/**
 * Prompt Logger — 提取并按 session 去重记录最新用户 Prompt。
 *
 * Prompt 原文只在内存中经过脱敏，然后传给 logger.promptLog() 的独立高敏感
 * 日志 transport；LRU 只保存 session 与 Prompt 的 SHA-256，不保存明文。
 */

const crypto = require('crypto')
const logger = require('./logger')
const LRUCache = require('./lruCache')
const { createPromptMasker, DEFAULT_MASK_VERSION } = require('./promptMasker')

const SCHEMA_VERSION = 1
const DEFAULT_CACHE_SIZE = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function isHumanPrompt(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return false
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (
    normalized.includes('<command-message>') ||
    normalized.includes('<command-name>') ||
    normalized.includes('<skill-format>') ||
    normalized.includes('<command-args>') ||
    normalized.includes('<command-contents>') ||
    normalized.includes('<local-command-stdout>') ||
    normalized.includes('<system-reminder>') ||
    /The following skills were invoked in this session:/i.test(normalized) ||
    /The following skills are available for use with the Skill tool:/i.test(normalized)
  ) {
    return false
  }
  return true
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

function hashPrompt(prompt) {
  if (typeof prompt !== 'string') {
    return null
  }
  const normalized = prompt.split('\u0000').join('').trim()
  if (!normalized) {
    return null
  }
  return crypto.createHash('sha256').update(normalized).digest('hex')
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
      mask_count: Number.isInteger(result.maskCount) ? result.maskCount : 0
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
          skill_path: skillRecord.skill_path ?? null,
          skill_detection_confidence: skillRecord.skill_detection_confidence ?? null,
          skill_detection_rule_version: skillRecord.skill_detection_rule_version ?? 1,
          skill_injection_kind: skillRecord.skill_injection_kind ?? 'newly_injected',
          skill_rehydrated: skillRecord.skill_rehydrated === true,
          skill_chars: skillRecord.skill_chars ?? 0,
          prompt: skillRecord.prompt
        }
        try {
          this.writeRecord(maskPromptRecord(record, this.maskPrompt))
        } catch (error) {
          logger.error(
            'Failed to enqueue SKILL Prompt log record:',
            error?.message || String(error)
          )
        }
      }
    }

    // 2. 提取并记录员工 Prompt
    const prompt = extractLatestUserPrompt(req?.body)
    const promptHash = hashPrompt(prompt)
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
      prompt_hash: promptHash,
      prompt_length: prompt.length,
      prompt
    }

    let accepted = false
    try {
      accepted = this.writeRecord(maskPromptRecord(record, this.maskPrompt)) === true
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

const defaultPromptLogger = new PromptLogger()

module.exports = defaultPromptLogger
module.exports.PromptLogger = PromptLogger
module.exports.SCHEMA_VERSION = SCHEMA_VERSION
module.exports.buildPromptSessionKey = buildPromptSessionKey
module.exports.extractLatestUserPrompt = extractLatestUserPrompt
module.exports.hashPrompt = hashPrompt
module.exports.isHumanPrompt = isHumanPrompt
module.exports.maskPromptRecord = maskPromptRecord
