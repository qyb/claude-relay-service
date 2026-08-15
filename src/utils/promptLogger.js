/**
 * Prompt Logger — 提取并按 session 去重记录最新用户 Prompt。
 *
 * Prompt 原文只在内存中经过脱敏，然后传给 logger.promptLog() 的独立高敏感
 * 日志 transport；LRU 只保存 session 与 Prompt 的 HMAC，不保存明文。
 * 只有分类为 human 的文本才进入 user_prompt_observed，机器注入内容一律
 * 通过 SKILL 分析器的 skill_prompt_observed 单独落盘。
 */

const crypto = require('crypto')
const logger = require('./logger')
const LRUCache = require('./lruCache')
const { createPromptMasker, DEFAULT_MASK_VERSION } = require('./promptMasker')
const {
  classifyPromptSource,
  isHumanPrompt: classifyIsHumanPrompt,
  PROMPT_SOURCE_RULE_VERSION
} = require('./promptSourceClassifier')
const { getPurposeKey, getKeyId } = require('./hmacKeyring')

const SCHEMA_VERSION = 2
const DEFAULT_CACHE_SIZE = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SUSPECTED_SECRET_WARN_INTERVAL_MS = 5 * 60 * 1000
const MAX_SKILL_PATH_LENGTH = 128

// 常见客户端 home 目录前缀归一化为 $HOME，避免用户名落盘
const HOME_PATH_PATTERNS = [
  { pattern: /^\/home\/[^/]+/, replacement: '$HOME' },
  { pattern: /^\/Users\/[^/]+/, replacement: '$HOME' },
  { pattern: /^C:\\Users\\[^\\]+/, replacement: '$HOME' }
]

let lastSuspectedSecretWarnAt = 0

function isHumanPrompt(text) {
  return classifyIsHumanPrompt(text)
}

function normalizeSkillPath(value) {
  if (typeof value !== 'string') {
    return null
  }
  let normalized = value.trim()
  if (!normalized) {
    return null
  }
  for (const { pattern, replacement } of HOME_PATH_PATTERNS) {
    normalized = normalized.replace(pattern, replacement)
  }
  return normalized.slice(0, MAX_SKILL_PATH_LENGTH)
}

function extractLatestUserPrompt(requestBody) {
  const messages = requestBody?.messages
  if (!Array.isArray(messages)) {
    return null
  }

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.role !== 'user') {
      continue
    }

    const { content } = message
    if (typeof content === 'string') {
      if (content.trim() && isHumanPrompt(content)) {
        return content
      }
      continue
    }

    if (!Array.isArray(content)) {
      continue
    }

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (
        block?.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.trim() &&
        isHumanPrompt(block.text)
      ) {
        return block.text
      }
    }
  }

  return null
}

/**
 * 带密钥的 HMAC，防止低熵敏感文本被离线字典枚举还原。
 * 密钥来自 ENCRYPTION_KEY；未配置时为进程随机值，hash_key_id 带 ephemeral- 前缀。
 */
function hashPrompt(prompt, hmacKeyOverride) {
  if (typeof prompt !== 'string') {
    return null
  }
  const normalized = prompt.split('\u0000').join('').trim()
  if (!normalized) {
    return null
  }
  const key = getPurposeKey('prompt-hash:v1', hmacKeyOverride)
  return crypto.createHmac('sha256', key).update(normalized).digest('hex')
}

function getPromptHashKeyId(hmacKeyOverride) {
  return getKeyId('prompt-hash:v1', hmacKeyOverride)
}

function buildPromptSessionKey(apiKeyId, clientSessionId) {
  if (
    (typeof apiKeyId !== 'string' && typeof apiKeyId !== 'number') ||
    !String(apiKeyId).trim() ||
    typeof clientSessionId !== 'string' ||
    !clientSessionId.trim()
  ) {
    return null
  }

  const normalizedSessionId = clientSessionId.trim().toLowerCase()
  return crypto
    .createHash('sha256')
    .update(`${String(apiKeyId)}\u0000anthropic\u0000${normalizedSessionId}`)
    .digest('hex')
}

function warnSuspectedSecret(record) {
  const now = Date.now()
  if (now - lastSuspectedSecretWarnAt < SUSPECTED_SECRET_WARN_INTERVAL_MS) {
    return
  }
  lastSuspectedSecretWarnAt = now
  logger.warn?.(
    `⚠️ Prompt 中检测到疑似高熵密钥 (mask_count=${record.mask_count}, high_entropy_count=${record.high_entropy_count})，已整体替换`
  )
}

function maskPromptRecord(record, maskPromptFn) {
  if (!record || typeof record.prompt !== 'string') {
    return record
  }

  try {
    const result = maskPromptFn(record.prompt)
    const maskedRecord = {
      ...record,
      prompt: result.maskedPrompt,
      mask_version: result.maskVersion || DEFAULT_MASK_VERSION,
      mask_count: Number.isInteger(result.maskCount) ? result.maskCount : 0,
      mask_key_id: result.maskKeyId || null,
      rules_source: result.rulesSource || 'default'
    }

    if (Array.isArray(result.entityFingerprints) && result.entityFingerprints.length > 0) {
      maskedRecord.entity_fingerprints = result.entityFingerprints
    }
    if (Number.isInteger(result.highEntropyCount) && result.highEntropyCount > 0) {
      maskedRecord.high_entropy_count = result.highEntropyCount
    }
    if (result.suspectedSecret === true) {
      maskedRecord.suspected_secret = true
    }

    return maskedRecord
  } catch (error) {
    // 脱敏异常时绝不能把明文继续写盘；使用不可逆占位符并保留可复核元字段。
    return {
      ...record,
      prompt: '[MASKED:prompt_masking_error]',
      mask_version: DEFAULT_MASK_VERSION,
      mask_count: 0,
      suspected_secret: true
    }
  }
}

class PromptLogger {
  constructor(options = {}) {
    const cacheSize = parsePositiveInteger(
      options.cacheSize ?? process.env.PROMPT_LOG_CACHE_SIZE,
      DEFAULT_CACHE_SIZE
    )
    this.cacheTtlMs = parsePositiveInteger(
      options.cacheTtlMs ?? process.env.PROMPT_LOG_CACHE_TTL_MS,
      DEFAULT_CACHE_TTL_MS
    )
    this.cache = options.cache || new LRUCache(cacheSize)
    this.writeRecord = options.writeRecord || ((record) => logger.promptLog(record))
    this.promptHashHmacKey = options.promptHashHmacKey
    this.maskPrompt =
      options.maskPrompt ||
      createPromptMasker({
        hmacKey: options.maskingHmacKey,
        maskVersion: options.maskVersion,
        rules: options.maskingRules,
        rulesFile: options.maskingRulesFile
      })
  }

  recordRequest(req, sessionInfo = {}, skillRecords = []) {
    // 统一的“脱敏 → 高熵告警 → 写盘”路径，员工 Prompt 与 SKILL/reminder
    // 明文记录同样触发限频告警
    const writeMaskedRecord = (record) => {
      const maskedRecord = maskPromptRecord(record, this.maskPrompt)
      if (maskedRecord.suspected_secret === true) {
        warnSuspectedSecret(maskedRecord)
      }
      return this.writeRecord(maskedRecord) === true
    }

    // 1. 记录待落盘的 SKILL Prompt（写盘前脱敏）
    if (Array.isArray(skillRecords)) {
      for (const skillRecord of skillRecords) {
        const record = {
          schema_version: 2,
          event_type: 'skill_prompt_observed',
          timestamp: new Date().toISOString(),
          gateway_request_id: req?.requestId ?? null,
          api_key_record_id: req?.apiKey?.id ?? null,
          api_key_name: req?.apiKey?.name ?? null,
          client_session_id: sessionInfo?.clientSessionId ?? null,
          session_id_source: sessionInfo?.source ?? null,
          route: req?.route?.path ?? req?.originalUrl?.split('?')[0] ?? null,
          model: req?.body?.model ?? null,
          prompt_source: skillRecord.prompt_source ?? 'skill_injection',
          skill_name: skillRecord.skill_name ?? null,
          skill_path: normalizeSkillPath(skillRecord.skill_path),
          skill_detection_confidence: skillRecord.skill_detection_confidence ?? null,
          skill_detection_rule_version: skillRecord.skill_detection_rule_version ?? 1,
          skill_injection_kind: skillRecord.skill_injection_kind ?? 'newly_injected',
          skill_rehydrated: skillRecord.skill_rehydrated === true,
          skill_chars: skillRecord.skill_chars ?? 0,
          prompt: skillRecord.prompt
        }
        try {
          writeMaskedRecord(record)
        } catch (error) {
          logger.error(
            'Failed to enqueue SKILL Prompt log record:',
            error?.message || String(error)
          )
        }
      }
    }

    // 2. 提取并记录员工 Prompt（只有 human 分类才落盘）
    const prompt = extractLatestUserPrompt(req?.body)
    const promptHash = hashPrompt(prompt, this.promptHashHmacKey)
    if (!prompt || !promptHash) {
      return { logged: false, duplicate: false, reason: 'no_prompt' }
    }

    const sessionKey = buildPromptSessionKey(req?.apiKey?.id, sessionInfo.clientSessionId)
    if (sessionKey && this.cache.get(sessionKey) === promptHash) {
      this.cache.set(sessionKey, promptHash, this.cacheTtlMs)
      return { logged: false, duplicate: true, reason: 'duplicate' }
    }

    const record = {
      schema_version: SCHEMA_VERSION,
      event_type: 'user_prompt_observed',
      timestamp: new Date().toISOString(),
      gateway_request_id: req?.requestId ?? null,
      api_key_record_id: req?.apiKey?.id ?? null,
      api_key_name: req?.apiKey?.name ?? null,
      client_session_id: sessionInfo.clientSessionId ?? null,
      session_id_source: sessionInfo.source ?? null,
      route: req?.route?.path ?? req?.originalUrl?.split('?')[0] ?? null,
      model: req?.body?.model ?? null,
      message_count: Array.isArray(req?.body?.messages) ? req.body.messages.length : 0,
      prompt_source: classifyPromptSource(prompt),
      prompt_source_rule_version: PROMPT_SOURCE_RULE_VERSION,
      prompt_hash: promptHash,
      hash_key_id: getPromptHashKeyId(this.promptHashHmacKey),
      prompt_length: prompt.length,
      prompt
    }

    let accepted = false
    try {
      accepted = writeMaskedRecord(record)
    } catch (error) {
      logger.error('Failed to enqueue Prompt log record:', error?.message || String(error))
    }

    if (!accepted) {
      return { logged: false, duplicate: false, reason: 'logger_unavailable' }
    }

    if (sessionKey) {
      this.cache.set(sessionKey, promptHash, this.cacheTtlMs)
    }

    return { logged: true, duplicate: false, reason: 'logged' }
  }

  getCacheStats() {
    return this.cache.getStats()
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const defaultPromptLogger = new PromptLogger()

module.exports = defaultPromptLogger
module.exports.PromptLogger = PromptLogger
module.exports.SCHEMA_VERSION = SCHEMA_VERSION
module.exports.buildPromptSessionKey = buildPromptSessionKey
module.exports.extractLatestUserPrompt = extractLatestUserPrompt
module.exports.hashPrompt = hashPrompt
module.exports.isHumanPrompt = isHumanPrompt
module.exports.maskPromptRecord = maskPromptRecord
module.exports.normalizeSkillPath = normalizeSkillPath
