/**
 * Prompt Logger — 提取并按 session 去重记录最新用户 Prompt。
 *
 * Prompt 明文仅传给 logger.promptLog() 的独立高敏感日志 transport；LRU
 * 只保存 session 与 Prompt 的 SHA-256，不保存明文。
 */

const crypto = require('crypto')
const logger = require('./logger')
const LRUCache = require('./lruCache')

const SCHEMA_VERSION = 1
const DEFAULT_CACHE_SIZE = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
      if (content.trim()) {
        return content
      }
      continue
    }

    if (!Array.isArray(content)) {
      continue
    }

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
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
  }

  recordRequest(req, sessionInfo = {}) {
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
      accepted = this.writeRecord(record) === true
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
