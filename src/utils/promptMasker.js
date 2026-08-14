/**
 * Prompt 写盘前脱敏。
 *
 * 该模块只返回脱敏后的文本和统计信息，不负责日志写入。默认规则优先
 * 处理长结构（PEM、连接串、认证头），再处理赋值结构和值形状，最后处理
 * PII，避免同一段内容被重复替换。
 */

const crypto = require('crypto')
const fs = require('fs')

const DEFAULT_MASK_VERSION = '2026.08.14'
const DEFAULT_HMAC_KEY = crypto.randomBytes(32)
const DEFAULT_VENDOR_PREFIXES = ['sk-', 'AKID', 'ghp_']

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
    enableDigest: parseBoolean(rules.enableDigest ?? rules.enable_digest, false)
  }
}

function loadRulesFile(filePath, fallbackRules) {
  if (!filePath) {
    return { rules: fallbackRules, mtimeMs: null }
  }

  try {
    const stat = fs.statSync(filePath)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return {
      rules: normalizeRules(data, fallbackRules.version),
      mtimeMs: stat.mtimeMs
    }
  } catch (error) {
    return { rules: fallbackRules, mtimeMs: null }
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
      return fallbackRules
    }

    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs !== loaded.mtimeMs) {
        loaded = loadRulesFile(filePath, fallbackRules)
      }
    } catch (error) {
      loaded = { rules: fallbackRules, mtimeMs: null }
    }
    return loaded.rules
  }
}

function getHmacKey(value) {
  const rawKey = value ?? process.env.ENCRYPTION_KEY
  if (Buffer.isBuffer(value) && value.length > 0) {
    return crypto.createHmac('sha256', value).update('crs:prompt-masking:v1').digest()
  }
  if (typeof rawKey === 'string' && rawKey.length > 0) {
    return crypto
      .createHmac('sha256', Buffer.from(rawKey, 'utf8'))
      .update('crs:prompt-masking:v1')
      .digest()
  }
  if (rawKey !== undefined && rawKey !== null && String(rawKey).length > 0) {
    return crypto
      .createHmac('sha256', Buffer.from(String(rawKey), 'utf8'))
      .update('crs:prompt-masking:v1')
      .digest()
  }
  // 未配置时仍然全量替换，只是不保证跨进程关联；生产环境应配置 ENCRYPTION_KEY。
  return DEFAULT_HMAC_KEY
}

function fingerprint(value, hmacKey) {
  return crypto.createHmac('sha256', getHmacKey(hmacKey)).update(value).digest('hex').slice(0, 8)
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

function getStructureType(key) {
  return STRUCTURE_TYPES[key.replace(/^['"]|['"]$/g, '').toLowerCase()] || 'secret'
}

function maskPrompt(prompt, options = {}) {
  if (typeof prompt !== 'string') {
    return {
      maskedPrompt: prompt,
      maskCount: 0,
      suspectedSecret: false,
      maskVersion: options.maskVersion || DEFAULT_MASK_VERSION
    }
  }

  const getRules = options.getRules || createRuleProvider(options)
  const rules = getRules()
  const hmacKey = options.hmacKey ?? process.env.ENCRYPTION_KEY
  let maskedPrompt = prompt
  let maskCount = 0

  const apply = (pattern, type, transform = null) => {
    const result = replaceMatches(maskedPrompt, pattern, type, hmacKey, transform)
    maskedPrompt = result.text
    maskCount += result.count
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
    return `${value.slice(0, 3)}****${value.slice(-2)}`
  })
  apply(PHONE_PATTERN, 'phone', (args) => {
    const prefix = args[1] || args[2] || ''
    const firstThree = args[3]
    const lastTwo = args[5]
    return `${prefix}${firstThree}****${lastTwo}`
  })
  apply(EMAIL_PATTERN, 'email', (args) => {
    const value = args[0]
    const atIndex = value.indexOf('@')
    return `${value.slice(0, 1)}***${value.slice(atIndex)}`
  })

  return {
    maskedPrompt,
    maskCount,
    suspectedSecret: hasSuspectedSecret(maskedPrompt),
    maskVersion: rules.version
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

  return [...new Set(categories)]
}

module.exports = {
  DEFAULT_MASK_VERSION,
  DEFAULT_VENDOR_PREFIXES,
  createPromptMasker: (options = {}) => {
    const getRules = createRuleProvider(options)
    return (prompt) => maskPrompt(prompt, { ...options, getRules })
  },
  detectPromptCategories,
  hasSuspectedSecret,
  maskPrompt,
  maskedValue
}
