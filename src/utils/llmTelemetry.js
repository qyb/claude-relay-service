/**
 * LLM Telemetry — harness/tool 效能观测的请求级终态记录。
 *
 * 本模块只生成不含正文的结构化摘要；日志写入与轮转由 logger.telemetry()
 * 的独立 Winston transport 负责。
 */

const crypto = require('crypto')
const logger = require('./logger')
const pricingService = require('../services/pricingService')
const { detectHarness } = require('./harnessDetector')

// v2：未知价格时 cost 保留 null（不再写 0），并透传 skill/system-reminder 拆分指标
const SCHEMA_VERSION = 2
const MAX_TOOL_NAMES = 64
const MAX_TOOL_NAME_LENGTH = 128
const MAX_MESSAGE_TEMPLATE_LENGTH = 256
const VALID_EVENT_TYPES = new Set([
  'llm_request_completed',
  'llm_request_error',
  'account_failover',
  'sticky_session_lifecycle',
  'account_rate_limit_detected',
  'account_suppressed',
  'account_recovered',
  'upstream_attempt'
])
const UPSTREAM_EVENT_TYPES = new Set([
  'account_failover',
  'sticky_session_lifecycle',
  'account_rate_limit_detected',
  'account_suppressed',
  'account_recovered',
  'upstream_attempt'
])
// 账号级生命周期事件允许只携带 account_id 作为关联键（定时器/人工恢复没有请求上下文）
const ACCOUNT_SCOPED_EVENT_TYPES = new Set(['account_suppressed', 'account_recovered'])

// 请求失败阶段：区分账号选择、排队、上游 HTTP、上游流中、relay 传输与客户端断开
const FAILURE_STAGES = [
  'account_selection',
  'queue',
  'upstream_http',
  'upstream_stream',
  'relay',
  'client_disconnect'
]

// 账号恢复来源（稳定枚举，见 docs/UPSTREAM_TELEMETRY_DESIGN.md 6.1）
const RECOVERY_SOURCES = [
  'timer_expired',
  'upstream_reset_time',
  'successful_inflight_response',
  'manual',
  'service_restart',
  'quota_refresh'
]

// 调度失败的稳定错误码 → 失败阶段映射（供 observer 分类 failure_stage）
const SCHEDULING_ERROR_CODES = new Set([
  'ALL_ACCOUNTS_RATE_LIMITED',
  'NO_ELIGIBLE_ACCOUNT',
  'MODEL_NOT_SUPPORTED',
  'CLAUDE_DEDICATED_RATE_LIMITED',
  'SESSION_BINDING_ACCOUNT_UNAVAILABLE',
  'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
])

function sanitizeToken(value, maxLength) {
  if (typeof value !== 'string') {
    return null
  }
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
  return sanitized ? sanitized.slice(0, maxLength) : null
}

function normalizeStatusCode(value) {
  return Number.isInteger(value) && value >= 100 && value <= 999 ? value : null
}

/**
 * 上游错误消息 → 脱敏模板：数字、UUID、十六进制串等可变部分替换为占位符，
 * 保留中文等正文文本（智谱 1302 的消息模板因此可直接落盘）。
 * 不落原始消息：模板用于聚类同构错误，不能反推任何请求特定信息。
 */
function sanitizeMessageTemplate(message, maxLength = MAX_MESSAGE_TEMPLATE_LENGTH) {
  if (typeof message !== 'string') {
    return null
  }
  const templated = message
    // 控制字符与换行统一为空格，避免日志注入
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    // UUID / 8 位以上十六进制串（request-id 片段等）→ <id>
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>')
    .replace(/\b[0-9a-fA-F]{8,}\b/g, '<id>')
    // 连续数字（时间戳、数值）→ <n>
    .replace(/\d+/g, '<n>')
    // 连续空白折叠
    .replace(/\s+/g, ' ')
    .trim()
  if (!templated) {
    return null
  }
  return templated.length > maxLength ? templated.slice(0, maxLength) : templated
}

/**
 * 从上游错误响应体提取脱敏的错误码与消息模板。
 * 兼容 Anthropic ({error:{type,code,message}}) 与智谱 ({"error":{"code":"1302","message":"[1302][...][...]"}})。
 */
function extractUpstreamErrorFields(responseBody) {
  let data = responseBody
  if (Buffer.isBuffer(data)) {
    try {
      data = data.toString('utf-8')
    } catch (_) {
      return {}
    }
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (_) {
      return {}
    }
  }
  if (!data || typeof data !== 'object' || !data.error || typeof data.error !== 'object') {
    return {}
  }
  const fields = {}
  if (data.error.code !== undefined && data.error.code !== null) {
    fields.upstreamErrorCode = sanitizeToken(String(data.error.code), 64)
  }
  if (data.error.type !== undefined && data.error.type !== null) {
    fields.upstreamErrorType = sanitizeToken(String(data.error.type), 128)
  }
  if (typeof data.error.message === 'string' && data.error.message) {
    const template = sanitizeMessageTemplate(data.error.message)
    if (template) {
      fields.upstreamMessageTemplate = template
    }
  }
  return fields
}

/**
 * 依据错误码/错误类型/上游状态推导失败阶段。
 * 返回 null 表示无法判定（如请求成功）。
 */
function classifyFailureStage({ errorCode, errorType, upstreamStatusCode, clientDisconnected }) {
  if (clientDisconnected) {
    return 'client_disconnect'
  }
  if (errorCode === 'queue_timeout' || errorType === 'queue_timeout') {
    return 'queue'
  }
  if (errorCode && SCHEDULING_ERROR_CODES.has(errorCode)) {
    return 'account_selection'
  }
  if (errorType === 'client_disconnected') {
    return 'client_disconnect'
  }
  if (errorType === 'upstream_stream_error' || errorType === 'upstream_stream') {
    return 'upstream_stream'
  }
  if (Number.isInteger(upstreamStatusCode) && upstreamStatusCode >= 400) {
    return 'upstream_http'
  }
  return 'relay'
}

function normalizeIsoTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value !== 'string' || !value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function recordUpstreamTelemetry(eventType, fields = {}) {
  if (!UPSTREAM_EVENT_TYPES.has(eventType)) {
    return false
  }

  const gatewayRequestId = sanitizeToken(fields.gatewayRequestId, 128)
  const sessionHash = sanitizeToken(fields.sessionHash, 128)
  const accountId = sanitizeToken(fields.accountId, 256)
  if (eventType === 'upstream_attempt') {
    // 逐次 attempt 必须挂在具体请求下才能还原 retry/failover 链
    if (!gatewayRequestId) {
      return false
    }
  } else if (ACCOUNT_SCOPED_EVENT_TYPES.has(eventType)) {
    // 账号级事件：定时器/人工恢复没有请求与会话上下文，account_id 即关联键
    if (!gatewayRequestId && !sessionHash && !accountId) {
      return false
    }
  } else if (!gatewayRequestId && !sessionHash) {
    return false
  }

  const commonFields = {
    schema_version: SCHEMA_VERSION,
    event_type: eventType,
    timestamp: new Date().toISOString()
  }

  if (eventType === 'account_failover') {
    return Boolean(
      logger.telemetry({
        ...commonFields,
        gateway_request_id: gatewayRequestId,
        session_hash: sessionHash,
        account_id: accountId,
        account_type: sanitizeToken(fields.accountType, 128),
        reason: sanitizeToken(fields.reason, 64),
        upstream_status_code: normalizeStatusCode(fields.upstreamStatusCode),
        upstream_error_code: sanitizeToken(fields.upstreamErrorCode, 64),
        upstream_message_template: sanitizeMessageTemplate(fields.upstreamMessageTemplate),
        sticky_deleted: fields.stickyDeleted === true,
        affected_session_count: normalizeNonNegativeNumber(fields.affectedSessionCount),
        expected_recovery_at: normalizeIsoTimestamp(fields.expectedRecoveryAt)
      })
    )
  }

  if (eventType === 'account_rate_limit_detected') {
    return Boolean(
      logger.telemetry({
        ...commonFields,
        gateway_request_id: gatewayRequestId,
        session_hash: sessionHash,
        account_id: accountId,
        account_type: sanitizeToken(fields.accountType, 128),
        upstream_status_code: normalizeStatusCode(fields.upstreamStatusCode),
        upstream_error_code: sanitizeToken(fields.upstreamErrorCode, 64),
        upstream_message_template: sanitizeMessageTemplate(fields.upstreamMessageTemplate),
        upstream_request_id: sanitizeToken(fields.upstreamRequestId, 256),
        // suppression_id 用于把 detected/suppressed/recovered 三个事件串成一次摘除
        suppression_id: sanitizeToken(fields.suppressionId, 128),
        reset_timestamp: normalizeIsoTimestamp(
          fields.resetTimestamp ? new Date(fields.resetTimestamp * 1000) : null
        )
      })
    )
  }

  if (eventType === 'account_suppressed') {
    return Boolean(
      logger.telemetry({
        ...commonFields,
        gateway_request_id: gatewayRequestId,
        session_hash: sessionHash,
        account_id: accountId,
        account_type: sanitizeToken(fields.accountType, 128),
        reason: sanitizeToken(fields.reason, 64),
        configured_duration_seconds: normalizeNonNegativeNumber(fields.configuredDurationSeconds),
        expected_recovery_at: normalizeIsoTimestamp(fields.expectedRecoveryAt),
        suppression_id: sanitizeToken(fields.suppressionId, 128),
        affected_session_count: normalizeNonNegativeNumber(fields.affectedSessionCount)
      })
    )
  }

  if (eventType === 'account_recovered') {
    return Boolean(
      logger.telemetry({
        ...commonFields,
        gateway_request_id: gatewayRequestId,
        session_hash: sessionHash,
        account_id: accountId,
        account_type: sanitizeToken(fields.accountType, 128),
        recovery_source: sanitizeToken(fields.recoverySource, 64),
        expected_recovery_at: normalizeIsoTimestamp(fields.expectedRecoveryAt),
        actual_recovery_at:
          normalizeIsoTimestamp(fields.actualRecoveryAt) ?? commonFields.timestamp,
        actual_suppression_seconds: normalizeNonNegativeNumber(fields.actualSuppressionSeconds),
        suppression_id: sanitizeToken(fields.suppressionId, 128)
      })
    )
  }

  if (eventType === 'upstream_attempt') {
    return recordUpstreamAttempt(fields, { gatewayRequestId })
  }

  return Boolean(
    logger.telemetry({
      ...commonFields,
      gateway_request_id: gatewayRequestId,
      session_hash: sessionHash,
      account_id: accountId,
      account_type: sanitizeToken(fields.accountType, 128),
      action: sanitizeToken(fields.action, 32),
      ttl_seconds:
        Number.isInteger(fields.ttlSeconds) && fields.ttlSeconds >= 0 ? fields.ttlSeconds : null,
      reason: sanitizeToken(fields.reason, 64)
    })
  )
}

function calculateCostFields(usage, model, apiUrl) {
  const result = pricingService.calculateCost(usage, model, { apiUrl })
  return {
    cost: result.hasPricing ? result.totalCost : null,
    hasPricing: result.hasPricing === true
  }
}

/**
 * 逐次真实上游尝试事件（v2）。每次 attempt 结束时立即落盘，
 * 不等请求终态，长流式请求的重试链也能完整还原。
 */
function recordUpstreamAttempt(fields = {}, { gatewayRequestId } = {}) {
  if (!gatewayRequestId) {
    return false
  }

  const usage = fields.usage && typeof fields.usage === 'object' ? fields.usage : null
  const usageFields = getUsageFields(usage)
  let cost = null
  let hasPricing = null
  if (usageFields.usage_available) {
    try {
      const { cost: attemptCost, hasPricing: attemptHasPricing } = calculateCostFields(
        usage,
        fields.model ?? null,
        fields.apiUrl ?? null
      )
      cost = attemptCost
      hasPricing = attemptHasPricing
    } catch (error) {
      logger.warn?.(`⚠️ Failed to calculate upstream_attempt cost: ${error.message}`)
    }
  }

  const attemptNumber =
    Number.isInteger(fields.attemptNumber) && fields.attemptNumber > 0 ? fields.attemptNumber : null

  return Boolean(
    logger.telemetry({
      schema_version: SCHEMA_VERSION,
      event_type: 'upstream_attempt',
      timestamp: new Date().toISOString(),
      gateway_request_id: gatewayRequestId,
      attempt_number: attemptNumber,
      attempt_id:
        sanitizeToken(fields.attemptId, 160) ??
        (attemptNumber ? `${gatewayRequestId}#a${attemptNumber}` : null),
      account_id: sanitizeToken(fields.accountId, 256),
      account_type: sanitizeToken(fields.accountType, 128),
      provider: sanitizeToken(fields.provider, 64),
      model: sanitizeToken(fields.model, 160),
      queue_request_id: sanitizeToken(fields.queueRequestId, 128),
      queue_wait_ms: normalizeNonNegativeNumber(fields.queueWaitMs),
      upstream_latency_ms: normalizeNonNegativeNumber(fields.upstreamLatencyMs),
      upstream_status_code: normalizeStatusCode(fields.upstreamStatusCode),
      success: fields.success === true,
      upstream_error_type: sanitizeToken(fields.upstreamErrorType, 128),
      upstream_error_code: sanitizeToken(fields.upstreamErrorCode, 64),
      upstream_message_template: sanitizeMessageTemplate(fields.upstreamMessageTemplate),
      upstream_request_id: sanitizeToken(fields.upstreamRequestId, 256),
      input_tokens: usageFields.input_tokens,
      output_tokens: usageFields.output_tokens,
      cache_creation_input_tokens: usageFields.cache_creation_input_tokens,
      cache_read_input_tokens: usageFields.cache_read_input_tokens,
      usage_available: usageFields.usage_available,
      cost,
      has_pricing: hasPricing
    })
  )
}

function normalizeToolNames(names) {
  if (!Array.isArray(names)) {
    return []
  }

  return [
    ...new Set(names.map((name) => sanitizeToken(name, MAX_TOOL_NAME_LENGTH)).filter(Boolean))
  ]
    .sort()
    .slice(0, MAX_TOOL_NAMES)
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
  return `{${entries.join(',')}}`
}

function hashValue(value) {
  if (value === undefined || value === null) {
    return null
  }
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function collectToolResults(messages) {
  let count = 0
  let errorCount = 0

  if (!Array.isArray(messages)) {
    return { count, errorCount }
  }

  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) {
      continue
    }

    for (const block of content) {
      if (block?.type !== 'tool_result') {
        continue
      }
      count += 1
      if (block.is_error === true) {
        errorCount += 1
      }
    }
  }

  return { count, errorCount }
}

function summarizeRequestForTelemetry(requestBody = {}, headers = {}) {
  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : []
  const toolNames = normalizeToolNames(tools.map((tool) => tool?.name))
  const toolResults = collectToolResults(requestBody?.messages)
  const systemPromptHash = hashValue(requestBody?.system)
  const toolSchemaHash = hashValue(tools.length > 0 ? tools : null)
  const harness = detectHarness(headers)
  const harnessConfigHash =
    systemPromptHash || toolSchemaHash
      ? hashValue({ system_prompt_hash: systemPromptHash, tool_schema_hash: toolSchemaHash })
      : null

  return {
    ...harness,
    harness_config_hash: harnessConfigHash,
    message_count: Array.isArray(requestBody?.messages) ? requestBody.messages.length : 0,
    tools_offered_count: tools.length,
    tool_names: toolNames,
    tool_schema_hash: toolSchemaHash,
    system_prompt_hash: systemPromptHash,
    tool_result_count: toolResults.count,
    tool_result_error_count: toolResults.errorCount
  }
}

function summarizeResponseForTelemetry(response) {
  if (!response || typeof response !== 'object') {
    return {
      stop_reason: null,
      tool_use_count: null,
      tool_use_names: [],
      parallel_tool_use_detected: null
    }
  }

  const content = Array.isArray(response?.content) ? response.content : []
  const contentToolUses = content.filter((block) => block?.type === 'tool_use')
  const providedNames = Array.isArray(response?.tool_use_names) ? response.tool_use_names : []
  const toolUseNames = normalizeToolNames([
    ...contentToolUses.map((block) => block?.name),
    ...providedNames
  ])
  const providedCount = Number.isInteger(response?.tool_use_count) ? response.tool_use_count : null
  const toolUseCount = providedCount ?? contentToolUses.length

  return {
    stop_reason: response?.stop_reason ?? response?.stopReason ?? null,
    tool_use_count: toolUseCount,
    tool_use_names: toolUseNames,
    parallel_tool_use_detected: response?.parallel_tool_use_detected === true || toolUseCount > 1
  }
}

function getUsageFields(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_ephemeral_5m_input_tokens: null,
      cache_creation_ephemeral_1h_input_tokens: null,
      total_tokens: null,
      usage_available: false
    }
  }

  const normalizeToken = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const inputTokens = normalizeToken(usage.input_tokens)
  const outputTokens = normalizeToken(usage.output_tokens)
  const cacheCreationTokens = normalizeToken(usage.cache_creation_input_tokens)
  const cacheReadTokens = normalizeToken(usage.cache_read_input_tokens)
  const ephemeral5mTokens = normalizeToken(usage.cache_creation?.ephemeral_5m_input_tokens)
  const ephemeral1hTokens = normalizeToken(usage.cache_creation?.ephemeral_1h_input_tokens)
  const numericValues = [inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens].filter(
    (value) => value !== null
  )

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_ephemeral_5m_input_tokens: ephemeral5mTokens,
    cache_creation_ephemeral_1h_input_tokens: ephemeral1hTokens,
    total_tokens:
      numericValues.length > 0 ? numericValues.reduce((sum, value) => sum + value, 0) : null,
    usage_available: numericValues.length > 0
  }
}

function createTelemetryContext(req, sessionInfo, skillSummary = null, requestMeta = {}) {
  const startTimeMs = Date.now()
  const agentContext = requestMeta?.agentContext || {}
  const purposeInfo = requestMeta?.purposeInfo || {}
  return {
    finalized: false,
    startTimeMs,
    requestStartedAt: new Date(startTimeMs).toISOString(),
    gatewayRequestId: req?.requestId ?? null,
    apiKeyRecordId: req?.apiKey?.id ?? null,
    apiKeyName: req?.apiKey?.name ?? null,
    route: req?.route?.path ?? req?.originalUrl?.split('?')[0] ?? null,
    provider: null,
    accountId: null,
    accountType: null,
    apiUrl: null,
    model: req?.body?.model ?? null,
    requestedModel: req?.body?.model ?? null,
    stream: req?.body?.stream === true,
    clientSessionId: sessionInfo?.clientSessionId ?? null,
    sessionIdSource: sessionInfo?.source ?? null,
    stickySessionKey: sessionInfo?.stickySessionKey ?? null,
    // P0-1/P0-2：请求目的与叶级上下文标识（由 observer 在入口派生）
    requestPurpose: purposeInfo.request_purpose ?? 'unknown',
    purposeRuleVersion: purposeInfo.purpose_rule_version ?? null,
    purposeSource: purposeInfo.purpose_source ?? null,
    purposeTemplateId: purposeInfo.template_id ?? null,
    agentContextId: agentContext.agentContextId ?? null,
    contextFingerprint: agentContext.contextFingerprint ?? null,
    contextKeyId: agentContext.contextKeyId ?? null,
    agentContextRole: purposeInfo.agent_context_role ?? null,
    agentContextRoleSource: purposeInfo.agent_context_role_source ?? null,
    requestSummary: summarizeRequestForTelemetry(req?.body, req?.headers),
    skillSummary: skillSummary || null
  }
}

function finalizeTelemetry(context, outcome = {}) {
  if (
    !context ||
    context.finalized ||
    !context.gatewayRequestId ||
    !VALID_EVENT_TYPES.has(outcome.eventType) ||
    UPSTREAM_EVENT_TYPES.has(outcome.eventType)
  ) {
    return false
  }

  context.finalized = true
  const isError = outcome.eventType === 'llm_request_error'
  const usageFields = getUsageFields(outcome.usage)
  const responseSummary = summarizeResponseForTelemetry(outcome.responseSummary)
  const now = Date.now()
  const responseCompleted = outcome.responseCompleted ?? !isError
  const effectiveSkillSummary = outcome.skillSummary ?? context.skillSummary

  let cost = outcome.cost ?? null
  let hasPricing = null
  let pricingModel = null
  let pricingRegion = null
  let provisionalPricing = false
  if (cost === null && usageFields.usage_available) {
    try {
      const costResult = pricingService.calculateCost(
        outcome.usage,
        outcome.model ?? context.model,
        { apiUrl: outcome.apiUrl ?? context.apiUrl }
      )
      // 未知价格保留 null，避免消费者把“未知”聚合为“免费”；只有确认价格才写数值
      cost = costResult.hasPricing ? costResult.totalCost : null
      hasPricing = costResult.hasPricing === true
      pricingModel = costResult.pricing_model ?? null
      pricingRegion = costResult.region ?? null
      provisionalPricing = costResult.provisionalPricing === true
    } catch (error) {
      logger.warn?.(`⚠️ Failed to calculate telemetry cost: ${error.message}`)
    }
  }

  const skillFields = effectiveSkillSummary
    ? {
        // v4 语义：skill_detected 只反映真实技能实例（invocation/definition/
        // rehydration）；技能目录与命令调用有独立字段，不再互相污染
        skill_detected: effectiveSkillSummary.skill_detected === true,
        skill_catalog_detected: effectiveSkillSummary.skill_catalog_detected === true,
        skill_catalog_names: Number.isInteger(effectiveSkillSummary.skill_catalog_names)
          ? effectiveSkillSummary.skill_catalog_names
          : 0,
        skill_detection_confidence: effectiveSkillSummary.skill_detection_confidence ?? null,
        skill_detection_rule_version: effectiveSkillSummary.skill_detection_rule_version ?? 1,
        skill_detection_types: Array.isArray(effectiveSkillSummary.skill_detection_types)
          ? effectiveSkillSummary.skill_detection_types
          : [],
        skill_names: Array.isArray(effectiveSkillSummary.skill_names)
          ? effectiveSkillSummary.skill_names
          : [],
        skill_count: Number.isInteger(effectiveSkillSummary.skill_count)
          ? effectiveSkillSummary.skill_count
          : 0,
        skill_injection_count: Number.isInteger(effectiveSkillSummary.skill_injection_count)
          ? effectiveSkillSummary.skill_injection_count
          : 0,
        skill_chars: Number.isInteger(effectiveSkillSummary.skill_chars)
          ? effectiveSkillSummary.skill_chars
          : 0,
        skill_newly_injected_count: Number.isInteger(
          effectiveSkillSummary.skill_newly_injected_count
        )
          ? effectiveSkillSummary.skill_newly_injected_count
          : 0,
        skill_reinjected_count: Number.isInteger(effectiveSkillSummary.skill_reinjected_count)
          ? effectiveSkillSummary.skill_reinjected_count
          : 0,
        skill_rehydrated: effectiveSkillSummary.skill_rehydrated === true,
        command_invocation_count: Number.isInteger(effectiveSkillSummary.command_invocation_count)
          ? effectiveSkillSummary.command_invocation_count
          : 0,
        command_invocation_names: Array.isArray(effectiveSkillSummary.command_invocation_names)
          ? effectiveSkillSummary.command_invocation_names
          : [],
        system_reminder_detected: effectiveSkillSummary.system_reminder_detected === true,
        system_reminder_count: Number.isInteger(effectiveSkillSummary.system_reminder_count)
          ? effectiveSkillSummary.system_reminder_count
          : 0,
        system_reminder_detection_types: Array.isArray(
          effectiveSkillSummary.system_reminder_detection_types
        )
          ? effectiveSkillSummary.system_reminder_detection_types
          : [],
        system_reminder_chars: Number.isInteger(effectiveSkillSummary.system_reminder_chars)
          ? effectiveSkillSummary.system_reminder_chars
          : 0,
        system_reminder_newly_injected_count: Number.isInteger(
          effectiveSkillSummary.system_reminder_newly_injected_count
        )
          ? effectiveSkillSummary.system_reminder_newly_injected_count
          : 0,
        system_reminder_reinjected_count: Number.isInteger(
          effectiveSkillSummary.system_reminder_reinjected_count
        )
          ? effectiveSkillSummary.system_reminder_reinjected_count
          : 0,
        // 上下文构成（字符量）：需与响应侧真实 usage（cache_read_input_tokens
        // 等）按 gateway_request_id 关联才能回答成本来源；字符量≠缓存命中量
        tool_result_context_chars: Number.isInteger(effectiveSkillSummary.tool_result_context_chars)
          ? effectiveSkillSummary.tool_result_context_chars
          : 0,
        tool_result_chars_current: Number.isInteger(effectiveSkillSummary.tool_result_chars_current)
          ? effectiveSkillSummary.tool_result_chars_current
          : 0,
        system_prompt_chars: Number.isInteger(effectiveSkillSummary.system_prompt_chars)
          ? effectiveSkillSummary.system_prompt_chars
          : 0,
        skill_context_chars_current: Number.isInteger(
          effectiveSkillSummary.skill_context_chars_current
        )
          ? effectiveSkillSummary.skill_context_chars_current
          : 0,
        skill_context_chars_added: Number.isInteger(effectiveSkillSummary.skill_context_chars_added)
          ? effectiveSkillSummary.skill_context_chars_added
          : 0,
        skill_context_chars_carried: Number.isInteger(
          effectiveSkillSummary.skill_context_chars_carried
        )
          ? effectiveSkillSummary.skill_context_chars_carried
          : 0,
        skill_context_chars_rehydrated: Number.isInteger(
          effectiveSkillSummary.skill_context_chars_rehydrated
        )
          ? effectiveSkillSummary.skill_context_chars_rehydrated
          : 0,
        active_skill_content_hashes: Array.isArray(
          effectiveSkillSummary.active_skill_content_hashes
        )
          ? effectiveSkillSummary.active_skill_content_hashes
          : [],
        skill_analysis_duration_ms: Number.isInteger(effectiveSkillSummary.analysis_duration_ms)
          ? effectiveSkillSummary.analysis_duration_ms
          : null,
        skill_analysis_scanned_chars: Number.isInteger(effectiveSkillSummary.analysis_scanned_chars)
          ? effectiveSkillSummary.analysis_scanned_chars
          : null,
        skill_analysis_truncated: effectiveSkillSummary.analysis_truncated === true
      }
    : {}

  const record = {
    schema_version: SCHEMA_VERSION,
    event_type: isError ? 'llm_request_error' : 'llm_request_completed',
    request_started_at: context.requestStartedAt,
    timestamp: new Date(now).toISOString(),
    gateway_request_id: context.gatewayRequestId,
    upstream_request_id: outcome.upstreamRequestId ?? null,
    queue_request_id: outcome.queueRequestId ?? null,
    api_key_record_id: context.apiKeyRecordId,
    api_key_name: context.apiKeyName,
    client_session_id: context.clientSessionId,
    session_id_source: context.sessionIdSource,
    sticky_session_key: context.stickySessionKey,
    root_session_id: context.clientSessionId,
    agent_context_id: context.agentContextId,
    context_fingerprint: context.contextFingerprint,
    context_key_id: context.contextKeyId,
    // 客户端将来提供真实父子关系时填充；当前网关侧无法可靠获得
    parent_gateway_request_id: null,
    request_purpose: context.requestPurpose,
    purpose_rule_version: context.purposeRuleVersion,
    purpose_source: context.purposeSource,
    purpose_template_id: context.purposeTemplateId,
    agent_context_role: context.agentContextRole,
    agent_context_role_source: context.agentContextRoleSource,
    ...context.requestSummary,
    ...skillFields,
    route: context.route,
    provider: outcome.provider ?? context.provider,
    account_id: outcome.accountId ?? context.accountId,
    account_type: outcome.accountType ?? context.accountType,
    api_url: outcome.apiUrl ?? context.apiUrl,
    model: outcome.model ?? context.model,
    requested_model: context.requestedModel,
    stream: context.stream,
    ...responseSummary,
    ...usageFields,
    cost,
    has_pricing: hasPricing,
    pricing_model: pricingModel,
    pricing_region: pricingRegion,
    provisional_pricing: provisionalPricing,
    queue_latency_ms: outcome.queueLatencyMs ?? null,
    upstream_latency_ms: outcome.upstreamLatencyMs ?? null,
    ttft_ms: outcome.ttftMs ?? null,
    total_latency_ms: outcome.totalLatencyMs ?? now - context.startTimeMs,
    attempt_count: outcome.attemptCount ?? 1,
    retry_reason: sanitizeToken(outcome.retryReason, 128),
    // 三层状态拆分：client=客户端实际收到、gateway=网关决定返回、upstream=真实上游响应。
    // 旧 status_code 等于 client_status_code，兼容期保留，消费方应迁移到新字段
    client_status_code: outcome.clientStatusCode ?? outcome.statusCode ?? null,
    gateway_status_code: outcome.gatewayStatusCode ?? outcome.statusCode ?? null,
    status_code: outcome.statusCode ?? null,
    upstream_status_code: outcome.upstreamStatusCode ?? null,
    failure_stage: FAILURE_STAGES.includes(outcome.failureStage)
      ? outcome.failureStage
      : isError
        ? classifyFailureStage(outcome.failureContext || {})
        : null,
    upstream_error_type: sanitizeToken(outcome.upstreamErrorType, 128),
    upstream_error_code: sanitizeToken(outcome.upstreamErrorCode, 64),
    upstream_message_template: sanitizeMessageTemplate(outcome.upstreamMessageTemplate),
    response_completed: responseCompleted,
    client_disconnected: outcome.clientDisconnected === true,
    error_type: isError ? sanitizeToken(outcome.errorType, 128) : null,
    error_code: isError ? sanitizeToken(outcome.errorCode, 128) : null
  }

  logger.telemetry(record)
  return true
}

module.exports = {
  SCHEMA_VERSION,
  FAILURE_STAGES,
  RECOVERY_SOURCES,
  SCHEDULING_ERROR_CODES,
  classifyFailureStage,
  createTelemetryContext,
  detectHarness,
  extractUpstreamErrorFields,
  finalizeTelemetry,
  hashValue,
  normalizeToolNames,
  recordUpstreamTelemetry,
  sanitizeMessageTemplate,
  stableSerialize,
  summarizeRequestForTelemetry,
  summarizeResponseForTelemetry
}
