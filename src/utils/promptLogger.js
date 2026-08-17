/**
 * Prompt Logger — 提取并按 session 去重记录最新用户 Prompt。
 *
 * Prompt 原文只在内存中经过脱敏，然后传给 logger.promptLog() 的独立高敏感
 * 日志 transport；LRU 只保存 session 与 Prompt 的 HMAC，不保存明文。
 * 只有分类为 human 的文本才进入 user_prompt_observed，机器注入内容一律
 * 通过 SKILL 分析器的 prompt_component_observed（schema v4）单独落盘。
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
const { detectHarness } = require('./harnessDetector')
const { getPurposeKey, getKeyId } = require('./hmacKeyring')

const SCHEMA_VERSION = 3
// SKILL/命令/reminder 组件记录的独立 schema（v4：prompt_kind 分类体系 + 归因字段）
const COMPONENT_RECORD_SCHEMA_VERSION = 4
// 兼容旧版分析器输出（无 skill_detection_rule_version 字段）时的回退版本号
const RULE_VERSION_FALLBACK = 1
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

/**
 * 最新 user 文本（跨消息回溯版）。
 * 仅用于机器记录的去重哈希兜底；request_purpose 判定必须用
 * extractLatestUserMessageText，避免把工具续跑请求归因到历史人工 Prompt。
 */
function extractLatestUserText(requestBody) {
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

/**
 * 只读取最后一条 user 消息的最后一个非空顶层文本块（不跨消息回溯）。
 *
 * request_purpose 判定的专用提取器：工具续跑请求的最后一条 user 消息
 * 往往只含 tool_result（或 tool_result 之后的 system-reminder），该消息
 * 没有顶层 text block 时必须返回 null，让分类器走 background /
 * skill_execution 分支，而不是回溯到历史人工 Prompt 把 token/cost
 * 错归因为 human。
 */
function extractLatestUserMessageText(requestBody) {
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
      return content.trim() ? content : null
    }
    if (!Array.isArray(content)) {
      return null
    }

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text
      }
    }
    // 最后一条 user 消息没有顶层 text block（tool_result-only）→ 不回溯
    return null
  }

  return null
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
  if (!record || (typeof record.prompt !== 'string' && typeof record.prompt_prefix !== 'string')) {
    return record
  }

  try {
    const next = { ...record }
    if (typeof record.prompt === 'string') {
      const result = maskPromptFn(record.prompt)
      next.prompt = result.maskedPrompt
      next.mask_version = result.maskVersion || DEFAULT_MASK_VERSION
      next.mask_count = Number.isInteger(result.maskCount) ? result.maskCount : 0
      next.mask_key_id = result.maskKeyId || null
      next.rules_source = result.rulesSource || 'default'

      if (Array.isArray(result.entityFingerprints) && result.entityFingerprints.length > 0) {
        next.entity_fingerprints = result.entityFingerprints
      }
      if (Number.isInteger(result.highEntropyCount) && result.highEntropyCount > 0) {
        next.high_entropy_count = result.highEntropyCount
      }
      if (result.suspectedSecret === true) {
        next.suspected_secret = true
      }
    }
    if (typeof record.prompt_prefix === 'string') {
      // 前缀采样与正文走同一脱敏路径；脱敏异常时同样以占位符兜底
      try {
        const prefixResult = maskPromptFn(record.prompt_prefix)
        next.prompt_prefix = prefixResult.maskedPrompt
      } catch (error) {
        next.prompt_prefix = '[MASKED:prompt_masking_error]'
      }
    }
    return next
  } catch (error) {
    // 脱敏异常时绝不能把明文继续写盘；使用不可逆占位符并保留可复核元字段。
    return {
      ...record,
      prompt: '[MASKED:prompt_masking_error]',
      prompt_prefix: undefined,
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

  recordRequest(req, sessionInfo = {}, skillRecords = [], purposeInfo = {}) {
    // 统一的“脱敏 → 高熵告警 → 写盘”路径，员工 Prompt 与 SKILL/reminder
    // 明文记录同样触发限频告警
    const writeMaskedRecord = (record) => {
      const maskedRecord = maskPromptRecord(record, this.maskPrompt)
      if (maskedRecord.suspected_secret === true) {
        warnSuspectedSecret(maskedRecord)
      }
      return this.writeRecord(maskedRecord) === true
    }

    // 1. 记录待落盘的机器注入组件（写盘前脱敏）。schema v4：prompt_kind
    //    分类体系（skill_invocation / command_invocation / system_reminder 等），
    //    并携带 request_purpose、agent_context、harness 与内容 hash 归因字段
    if (Array.isArray(skillRecords)) {
      const harness = detectHarness(req?.headers)
      for (const skillRecord of skillRecords) {
        const record = {
          schema_version: COMPONENT_RECORD_SCHEMA_VERSION,
          event_type: 'prompt_component_observed',
          timestamp: new Date().toISOString(),
          gateway_request_id: req?.requestId ?? null,
          api_key_record_id: req?.apiKey?.id ?? null,
          api_key_name: req?.apiKey?.name ?? null,
          client_session_id: sessionInfo?.clientSessionId ?? null,
          session_id_source: sessionInfo?.source ?? null,
          route: req?.route?.path ?? req?.originalUrl?.split('?')[0] ?? null,
          model: req?.body?.model ?? null,
          harness_id: harness.harness_id,
          harness_version: harness.harness_version,
          harness_source: harness.harness_source,
          request_purpose: purposeInfo?.request_purpose ?? null,
          purpose_source: purposeInfo?.purpose_source ?? null,
          agent_context_id: purposeInfo?.agent_context_id ?? null,
          agent_context_role: purposeInfo?.agent_context_role ?? null,
          prompt_kind: skillRecord.prompt_kind ?? 'unknown_machine_prompt',
          prompt_source: skillRecord.prompt_source ?? 'skill_injection',
          skill_name: skillRecord.skill_name ?? null,
          command_name: skillRecord.command_name ?? null,
          skill_path: normalizeSkillPath(skillRecord.skill_path),
          detection_type: skillRecord.detection_type ?? null,
          skill_detection_confidence: skillRecord.skill_detection_confidence ?? null,
          classification_confidence: skillRecord.classification_confidence ?? null,
          classification_reason: skillRecord.classification_reason ?? null,
          skill_detection_rule_version:
            skillRecord.skill_detection_rule_version ?? RULE_VERSION_FALLBACK,
          skill_injection_kind: skillRecord.skill_injection_kind ?? 'newly_injected',
          skill_rehydrated: skillRecord.skill_rehydrated === true,
          message_index: Number.isInteger(skillRecord.message_index)
            ? skillRecord.message_index
            : null,
          content_hash: skillRecord.content_hash ?? null,
          content_first_seen_request_id: skillRecord.content_first_seen_request_id ?? null,
          active_age_requests: Number.isInteger(skillRecord.active_age_requests)
            ? skillRecord.active_age_requests
            : null,
          skill_chars: skillRecord.skill_chars ?? 0,
          prompt: skillRecord.prompt ?? null,
          prompt_prefix: skillRecord.prompt_prefix ?? null
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

    // 2. 按请求目的分流：human 写员工明文记录；机器目的（auto/recap/
    //    suggestion/skill_execution/subagent/background）只写无正文的
    //    结构化统计，不进入员工行为分析
    const purpose = purposeInfo.request_purpose
    const isHumanRecord = !purpose || purpose === 'human'
    const prompt = isHumanRecord
      ? extractLatestUserPrompt(req?.body)
      : (purposeInfo.latestUserText ?? extractLatestUserMessageText(req?.body))
    const promptHash = hashPrompt(prompt, this.promptHashHmacKey)
    if (!prompt || !promptHash) {
      return { logged: false, duplicate: false, reason: 'no_prompt' }
    }

    const sessionKey = buildPromptSessionKey(req?.apiKey?.id, sessionInfo.clientSessionId)
    if (sessionKey && this.cache.get(sessionKey) === promptHash) {
      this.cache.set(sessionKey, promptHash, this.cacheTtlMs)
      return { logged: false, duplicate: true, reason: 'duplicate' }
    }

    const purposeRuleVersion = purposeInfo.purpose_rule_version ?? PROMPT_SOURCE_RULE_VERSION
    const commonFields = {
      schema_version: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      gateway_request_id: req?.requestId ?? null,
      api_key_record_id: req?.apiKey?.id ?? null,
      api_key_name: req?.apiKey?.name ?? null,
      client_session_id: sessionInfo.clientSessionId ?? null,
      session_id_source: sessionInfo.source ?? null,
      route: req?.route?.path ?? req?.originalUrl?.split('?')[0] ?? null,
      model: req?.body?.model ?? null,
      message_count: Array.isArray(req?.body?.messages) ? req.body.messages.length : 0,
      request_purpose: isHumanRecord ? 'human' : purpose,
      purpose_rule_version: purposeRuleVersion,
      purpose_source: purposeInfo.purpose_source ?? null,
      prompt_source: purposeInfo.prompt_source ?? classifyPromptSource(prompt),
      prompt_source_rule_version: PROMPT_SOURCE_RULE_VERSION,
      agent_context_id: purposeInfo.agent_context_id ?? null,
      agent_context_role: purposeInfo.agent_context_role ?? null,
      agent_context_role_source: purposeInfo.agent_context_role_source ?? null,
      prompt_hash: promptHash,
      hash_key_id: getPromptHashKeyId(this.promptHashHmacKey),
      prompt_length: prompt.length
    }

    const record = isHumanRecord
      ? {
          ...commonFields,
          event_type: 'user_prompt_observed',
          prompt
        }
      : {
          // 机器目的不落正文：只保留模板指纹与哈希统计
          ...commonFields,
          event_type: 'machine_prompt_observed',
          template_id: purposeInfo.template_id ?? null
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
module.exports.COMPONENT_RECORD_SCHEMA_VERSION = COMPONENT_RECORD_SCHEMA_VERSION
module.exports.buildPromptSessionKey = buildPromptSessionKey
module.exports.extractLatestUserPrompt = extractLatestUserPrompt
module.exports.extractLatestUserMessageText = extractLatestUserMessageText
module.exports.extractLatestUserText = extractLatestUserText
module.exports.hashPrompt = hashPrompt
module.exports.isHumanPrompt = isHumanPrompt
module.exports.maskPromptRecord = maskPromptRecord
module.exports.normalizeSkillPath = normalizeSkillPath
