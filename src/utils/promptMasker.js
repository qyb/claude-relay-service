/**
 * Prompt 写盘前脱敏。
 *
 * 该模块只返回脱敏后的文本和统计信息，不负责日志写入。默认规则优先
 * 处理长结构（PEM、连接串、认证头），再处理赋值结构和值形状，然后处理
 * PII，最后兜底替换高熵字符串，避免同一段内容被重复替换。
 *
 * 这仍是规则型部分脱敏而非安全边界：规则之间的真实密钥依赖高熵兜底替换，
 * 命中后保留 HMAC 指纹与类别，原文不落盘。
 */

const crypto = require('crypto')
const fs = require('fs')
const { getPurposeKey, getKeyId } = require('./hmacKeyring')

const DEFAULT_MASK_VERSION = '2026.08.15'
const FINGERPRINT_HEX_CHARS = 16
const RULES_WARN_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_VENDOR_PREFIXES = [
  'sk-',
  'sk-ant-',
  'AKID',
  'LTAI',
  'ghp_',
  'github_pat_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'AIza'
]

const STRUCTURE_KEYS =
  'password|passwd|pwd|secret|secret_key|token|apikey|api_key|access_key|密码|口令|密钥|凭据'

const STRUCTURE_PATTERN = new RegExp(
  `(?<!\\[MASKED:)(?<![A-Za-z0-9])("?(?:${STRUCTURE_KEYS})"?)(?![A-Za-z0-9_])(\\s*[=:：]\\s*)(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^\\s,;}\\]\\)\\n]+))`,
  'giu'
)

const PEM_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const CONNECTION_PATTERN =
  /((?:mysql|postgres(?:ql)?|mongodb|redis|jdbc[^\s:]*):\/\/[^\s/:]+:)([^\s/@]+)(@)/gi
const AUTHORIZATION_PATTERN = /\bAuthorization\s*:?\s*\S+\s+[A-Za-z0-9._~+/=-]{20,}/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi
const PHONE_PATTERN = /(?<!\d)(?:(\+86[ -]?)|(86[ -]?))?(1[3-9]\d)(\d{6})(\d{2})(?!\d)/g
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const ID_PATTERN = /(?<!\d)\d{17}[\dXx](?!\d)/g
const ENTROPY_TOKEN_PATTERN = /[^\s"'`<>]{20,}/g
// CJK 文本字符多样、熵天然偏高，不适用为 ASCII 密钥设计的高熵启发式。
const CJK_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
// 含代码结构符号（括号/花括号/冒号/引号等）或 URL 结构的 token 是代码片段
// 而非密钥；文件路径以扩展名结尾且含路径分隔符的同样豁免。
const CODE_PUNCTUATION_PATTERN = /[{}()[\],;:|\\]/
const PATH_LIKE_SUFFIX_PATTERN = /\.[A-Za-z]{1,6}$/
// 候选 token 内的连续可打印 ASCII 片段（用于剥离 CJK 前后缀和边缘标点）
const ASCII_RUN_PATTERN = /[\x21-\x7e]{20,}/g
const LEADING_EDGE_PUNCTUATION_PATTERN = /^[.,;:!?)\]}>'"`]+/
const TRAILING_EDGE_PUNCTUATION_PATTERN = /[.,;:!?([{<'"`]+$/
const URL_QUERY_PARAM_PATTERN = /([?&][^=?&\s]+=)([^&\s]+)/g
// URL query 参数值的“不透明”形状：受限字符集且字母数字混合
const OPAQUE_URL_PARAM_PATTERN = /^[A-Za-z0-9._=+-]+$/

const STRUCTURE_TYPES = {
  password: 'password',
  passwd: 'password',
  pwd: 'password',
  secret: 'secret',
  secret_key: 'secret',
  token: 'token',
  apikey: 'api_key',
  api_key: 'api_key',
  access_key: 'api_key',
  密码: 'password',
  口令: 'password',
  密钥: 'secret',
  凭据: 'credential'
}

let lastRulesWarnAt = 0

function warnRulesFileFailure(filePath, error) {
  const now = Date.now()
  if (now - lastRulesWarnAt < RULES_WARN_INTERVAL_MS) {
    return
  }
  lastRulesWarnAt = now
  // 惰性加载：logger 依赖运行时配置，纯函数场景（如测试）下可能不可用
  try {
    const logger = require('./logger')
    logger.warn?.(
      `⚠️ 脱敏规则文件加载失败，退回默认规则 (${filePath}): ${error?.message || String(error)}`
    )
  } catch {
    // logger 不可用时保持静默，规则回退本身不受影响
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  return value === true || String(value).toLowerCase() === 'true'
}

function normalizeVendorPrefixes(prefixes) {
  if (!Array.isArray(prefixes)) {
    return DEFAULT_VENDOR_PREFIXES
  }

  const normalized = prefixes
    .filter((prefix) => typeof prefix === 'string' && prefix.length >= 2)
    .map((prefix) => prefix.trim())
    .filter(Boolean)

  return normalized.length > 0 ? normalized : DEFAULT_VENDOR_PREFIXES
}

function normalizeRules(rules = {}, fallbackVersion = DEFAULT_MASK_VERSION) {
  return {
    version:
      typeof rules.version === 'string' && rules.version.trim()
        ? rules.version.trim()
        : fallbackVersion,
    vendorPrefixes: normalizeVendorPrefixes(rules.vendorPrefixes || rules.vendor_prefixes),
    enableDigest: parseBoolean(rules.enableDigest ?? rules.enable_digest, false),
    maskHighEntropy: parseBoolean(rules.maskHighEntropy ?? rules.mask_high_entropy, true)
  }
}

function loadRulesFile(filePath, fallbackRules) {
  if (!filePath) {
    return { rules: fallbackRules, mtimeMs: null, source: 'default' }
  }

  try {
    const stat = fs.statSync(filePath)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return {
      rules: normalizeRules(data, fallbackRules.version),
      mtimeMs: stat.mtimeMs,
      source: 'file'
    }
  } catch (error) {
    warnRulesFileFailure(filePath, error)
    return { rules: fallbackRules, mtimeMs: null, source: 'default' }
  }
}

function createRuleProvider(options = {}) {
  const filePath = options.rulesFile || process.env.PROMPT_MASKING_RULES_FILE
  const fallbackRules = normalizeRules(
    options.rules || {},
    options.maskVersion || process.env.PROMPT_MASK_VERSION || DEFAULT_MASK_VERSION
  )
  let loaded = loadRulesFile(filePath, fallbackRules)

  return () => {
    if (!filePath) {
      return { ...fallbackRules, source: 'default' }
    }

    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs !== loaded.mtimeMs) {
        loaded = loadRulesFile(filePath, fallbackRules)
      }
    } catch (error) {
      warnRulesFileFailure(filePath, error)
      loaded = { rules: fallbackRules, mtimeMs: null, source: 'default' }
    }
    return { ...loaded.rules, source: loaded.source }
  }
}

function getHmacKey(value) {
  return getPurposeKey('prompt-masking:v1', value ?? process.env.ENCRYPTION_KEY)
}

function fingerprint(value, hmacKey) {
  return crypto
    .createHmac('sha256', getHmacKey(hmacKey))
    .update(value)
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_CHARS)
}

function maskedValue(type, value, hmacKey) {
  return `[MASKED:${type}:${fingerprint(value, hmacKey)}]`
}

function isPlaceholder(value) {
  const normalized = value.trim().toLowerCase()
  return (
    !normalized ||
    /^\*+$/.test(normalized) ||
    /^x{2,}$/.test(normalized) ||
    /^<[^>\r\n]+>$/.test(normalized) ||
    /^\[masked:[^\]]+\]?$/i.test(normalized) ||
    /^your[_ -]?(?:password|token|secret|key)$/.test(normalized) ||
    /^(?:placeholder|redacted|masked|change(?:me|[-_ ]?it)|n\/a|null|none|undefined)$/.test(
      normalized
    )
  )
}

function buildVendorPattern(prefixes) {
  const alternatives = prefixes
    .map((prefix) => {
      const minimumLength = prefix === 'sk-' || prefix === 'ghp_' ? 16 : 8
      return `${escapeRegExp(prefix)}[A-Za-z0-9._-]{${minimumLength},}`
    })
    .join('|')
  return new RegExp(`(?:${alternatives})`, 'g')
}

function replaceMatches(text, pattern, type, hmacKey, transform = null) {
  let count = 0
  pattern.lastIndex = 0
  const output = text.replace(pattern, (...args) => {
    const match = args[0]
    const replacement = transform ? transform(args) : maskedValue(type, match, hmacKey)
    if (replacement !== match) {
      count += 1
    }
    return replacement
  })
  return { text: output, count }
}

function calculateEntropy(value) {
  const counts = new Map()
  for (const character of value) {
    counts.set(character, (counts.get(character) || 0) + 1)
  }

  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function isHighEntropy(value) {
  if (value.length < 20) {
    return false
  }

  if (CJK_PATTERN.test(value)) {
    return false
  }

  const characterClasses = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^\p{L}\p{N}]/u.test(value)
  ].filter(Boolean).length

  return characterClasses >= 3 && calculateEntropy(value) >= 4.5
}

function hasSuspectedSecret(text) {
  ENTROPY_TOKEN_PATTERN.lastIndex = 0
  const withoutMaskTokens = text.replace(/\[MASKED:[^\]]+\]/g, '')
  return [...withoutMaskTokens.matchAll(ENTROPY_TOKEN_PATTERN)].some(([candidate]) =>
    isHighEntropy(candidate)
  )
}

/**
 * 高熵兜底替换：未被规则命中的疑似密钥替换为指纹占位符。
 *
 * 候选 token 先剥离 CJK 前后缀和边缘标点，再对其中的连续 ASCII 片段做
 * 密钥形状判定，避免“中文句子 + 密钥”整体豁免导致泄漏。URL token 不整体
 * 豁免，而是单独替换其中高熵的 query 参数值。已替换的 [MASKED:...] 占位
 * 符和部分遮蔽的 PII 展示值不会被再次处理。
 */
function isMaskableHighEntropyToken(value) {
  return (
    isHighEntropy(value) &&
    !CODE_PUNCTUATION_PATTERN.test(value) &&
    !value.includes('//') &&
    !(value.includes('/') && PATH_LIKE_SUFFIX_PATTERN.test(value)) &&
    // 多级路径（含 URL path）不是密钥；bcrypt 等单斜杠哈希不受影响
    (value.match(/\//g) || []).length < 2
  )
}

function isMaskableUrlParamValue(value) {
  return (
    value.length >= 20 &&
    OPAQUE_URL_PARAM_PATTERN.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value)
  )
}

function trimEdgePunctuation(value) {
  return value
    .replace(LEADING_EDGE_PUNCTUATION_PATTERN, '')
    .replace(TRAILING_EDGE_PUNCTUATION_PATTERN, '')
}

function maskCandidateToken(candidate, hmacKey) {
  if (candidate.includes('[MASKED:') || candidate.includes('****')) {
    return candidate
  }

  if (candidate.includes('://')) {
    return candidate.replace(URL_QUERY_PARAM_PATTERN, (match, prefix, value) => {
      if (!isMaskableUrlParamValue(value)) {
        return match
      }
      return `${prefix}${maskedValue('url_param', value, hmacKey)}`
    })
  }

  let replaced = candidate
  const runs = candidate.match(ASCII_RUN_PATTERN) || []
  for (const run of runs) {
    const core = trimEdgePunctuation(run)
    if (core.length < 20 || !isMaskableHighEntropyToken(core)) {
      continue
    }
    replaced = replaced.split(core).join(maskedValue('high_entropy', core, hmacKey))
  }
  return replaced
}

function maskHighEntropyTokens(text, hmacKey) {
  ENTROPY_TOKEN_PATTERN.lastIndex = 0
  const maskedText = text.replace(ENTROPY_TOKEN_PATTERN, (candidate) =>
    maskCandidateToken(candidate, hmacKey)
  )
  return { text: maskedText }
}

/**
 * 与 maskCandidateToken 同一判定口径的检测（供 golden 提取等分类用途）。
 */
function hasMaskableHighEntropy(text) {
  ENTROPY_TOKEN_PATTERN.lastIndex = 0
  for (const [candidate] of text.matchAll(ENTROPY_TOKEN_PATTERN)) {
    if (candidate.includes('[MASKED:') || candidate.includes('****')) {
      continue
    }
    if (candidate.includes('://')) {
      URL_QUERY_PARAM_PATTERN.lastIndex = 0
      for (const [, , value] of candidate.matchAll(URL_QUERY_PARAM_PATTERN)) {
        if (isMaskableUrlParamValue(value)) {
          return true
        }
      }
      continue
    }
    for (const run of candidate.match(ASCII_RUN_PATTERN) || []) {
      const core = trimEdgePunctuation(run)
      if (core.length >= 20 && isMaskableHighEntropyToken(core)) {
        return true
      }
    }
  }
  return false
}

function getStructureType(key) {
  return STRUCTURE_TYPES[key.replace(/^['"]|['"]$/g, '').toLowerCase()] || 'secret'
}

function maskPrompt(prompt, options = {}) {
  if (typeof prompt !== 'string') {
    return {
      maskedPrompt: prompt,
      maskCount: 0,
      suspectedSecret: false,
      maskVersion: options.maskVersion || DEFAULT_MASK_VERSION,
      maskKeyId: getKeyId('prompt-masking:v1', options.hmacKey ?? process.env.ENCRYPTION_KEY),
      rulesSource: 'default',
      entityFingerprints: [],
      highEntropyCount: 0
    }
  }

  const getRules = options.getRules || createRuleProvider(options)
  const rules = getRules()
  const hmacKey = options.hmacKey ?? process.env.ENCRYPTION_KEY
  let maskedPrompt = prompt
  let maskCount = 0
  const entityFingerprints = []

  const apply = (pattern, type, transform = null) => {
    const result = replaceMatches(maskedPrompt, pattern, type, hmacKey, transform)
    maskedPrompt = result.text
    maskCount += result.count
  }

  const pushEntityFingerprint = (type, value) => {
    entityFingerprints.push({ type, fingerprint: fingerprint(value, hmacKey) })
  }

  STRUCTURE_PATTERN.lastIndex = 0
  maskedPrompt = maskedPrompt.replace(
    STRUCTURE_PATTERN,
    (match, key, assignment, doubleQuoted, singleQuoted, bareValue) => {
      const value = doubleQuoted ?? singleQuoted ?? bareValue
      if (isPlaceholder(value)) {
        return match
      }

      maskCount += 1
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : ''
      return `${key}${assignment}${quote}${maskedValue(getStructureType(key), value, hmacKey)}${quote}`
    }
  )

  apply(PEM_PATTERN, 'private_key')
  apply(CONNECTION_PATTERN, 'connection_password', (args) => {
    const prefix = args[1]
    const password = args[2]
    const suffix = args[3]
    return `${prefix}${maskedValue('connection_password', password, hmacKey)}${suffix}`
  })
  apply(AUTHORIZATION_PATTERN, 'auth_header')
  apply(BEARER_PATTERN, 'auth_header')
  apply(JWT_PATTERN, 'token')
  apply(buildVendorPattern(rules.vendorPrefixes), 'api_key')

  if (rules.enableDigest) {
    apply(/\b[A-Fa-f0-9]{32}\b|\b[A-Fa-f0-9]{40}\b|\b[A-Fa-f0-9]{64}\b/g, 'digest')
  }

  apply(ID_PATTERN, 'id_card', (args) => {
    const value = args[0]
    pushEntityFingerprint('id_card', value)
    return `${value.slice(0, 3)}****${value.slice(-2)}`
  })
  apply(PHONE_PATTERN, 'phone', (args) => {
    const value = args[0]
    const prefix = args[1] || args[2] || ''
    const firstThree = args[3]
    const lastTwo = args[5]
    pushEntityFingerprint('phone', value)
    return `${prefix}${firstThree}****${lastTwo}`
  })
  apply(EMAIL_PATTERN, 'email', (args) => {
    const value = args[0]
    const atIndex = value.indexOf('@')
    pushEntityFingerprint('email', value)
    return `${value.slice(0, 1)}***${value.slice(atIndex)}`
  })

  let highEntropyCount = 0
  if (rules.maskHighEntropy) {
    const result = maskHighEntropyTokens(maskedPrompt, hmacKey)
    const added = (result.text.match(/\[MASKED:(?:high_entropy|url_param):/g) || []).length
    maskedPrompt = result.text
    highEntropyCount = added
    maskCount += added
  } else if (hasSuspectedSecret(maskedPrompt)) {
    highEntropyCount = 1
  }

  return {
    maskedPrompt,
    maskCount,
    // 兜底替换之后原文不再残留，suspected_secret 以“是否发生高熵命中”为准
    suspectedSecret: highEntropyCount > 0,
    maskVersion: rules.version,
    maskKeyId: getKeyId('prompt-masking:v1', hmacKey),
    rulesSource: rules.source || 'default',
    entityFingerprints,
    highEntropyCount
  }
}

function detectPromptCategories(prompt, options = {}) {
  if (typeof prompt !== 'string') {
    return []
  }

  const rules = (options.getRules || createRuleProvider(options))()
  const categories = []
  const tests = [
    ['structure', STRUCTURE_PATTERN],
    ['private_key', PEM_PATTERN],
    ['connection_password', CONNECTION_PATTERN],
    ['auth_header', AUTHORIZATION_PATTERN],
    ['auth_header', BEARER_PATTERN],
    ['token', JWT_PATTERN],
    ['api_key', buildVendorPattern(rules.vendorPrefixes)],
    ['phone', PHONE_PATTERN],
    ['email', EMAIL_PATTERN],
    ['id_card', ID_PATTERN]
  ]

  for (const [category, pattern] of tests) {
    pattern.lastIndex = 0
    if (pattern.test(prompt)) {
      categories.push(category)
    }
  }

  if (hasMaskableHighEntropy(prompt)) {
    categories.push('high_entropy')
  }

  return [...new Set(categories)]
}

module.exports = {
  DEFAULT_MASK_VERSION,
  DEFAULT_VENDOR_PREFIXES,
  FINGERPRINT_HEX_CHARS,
  createPromptMasker: (options = {}) => {
    const getRules = createRuleProvider(options)
    return (prompt) => maskPrompt(prompt, { ...options, getRules })
  },
  detectPromptCategories,
  hasSuspectedSecret,
  isHighEntropy,
  isMaskableHighEntropyToken,
  maskPrompt,
  maskedValue
}
