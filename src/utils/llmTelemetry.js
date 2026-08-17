/**
 * LLM Telemetry — harness/tool 效能观测的请求级终态记录。
 *
 * 本模块只生成不含正文的结构化摘要；日志写入与轮转由 logger.telemetry()
 * 的独立 Winston transport 负责。
 */

const crypto = require('crypto')
const logger = require('./logger')
const pricingService = require('../services/pricingService')

// v2：未知价格时 cost 保留 null（不再写 0），并透传 skill/system-reminder 拆分指标
const SCHEMA_VERSION = 2
const MAX_TOOL_NAMES = 64
const MAX_TOOL_NAME_LENGTH = 128
const MAX_HARNESS_ID_LENGTH = 64
const MAX_HARNESS_VERSION_LENGTH = 64
const VALID_EVENT_TYPES = new Set([
  'llm_request_completed',
  'llm_request_error',
  'account_failover',
  'sticky_session_lifecycle'
])
const UPSTREAM_EVENT_TYPES = new Set(['account_failover', 'sticky_session_lifecycle'])

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return null
  }

  const direct = headers[name] ?? headers[name.toLowerCase()]
  if (typeof direct === 'string') {
    return direct
  }

  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
  const value = matchingKey ? headers[matchingKey] : null
  return typeof value === 'string' ? value : null
}

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

function recordUpstreamTelemetry(eventType, fields = {}) {
  if (!UPSTREAM_EVENT_TYPES.has(eventType)) {
    return false
  }

  const gatewayRequestId = sanitizeToken(fields.gatewayRequestId, 128)
  const sessionHash = sanitizeToken(fields.sessionHash, 128)
  if (!gatewayRequestId && !sessionHash) {
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
        account_id: sanitizeToken(fields.accountId, 256),
        account_type: sanitizeToken(fields.accountType, 128),
        reason: sanitizeToken(fields.reason, 64),
        upstream_status_code: normalizeStatusCode(fields.upstreamStatusCode),
        sticky_deleted: fields.stickyDeleted === true
      })
    )
  }

  return Boolean(
    logger.telemetry({
      ...commonFields,
      gateway_request_id: gatewayRequestId,
      session_hash: sessionHash,
      account_id: sanitizeToken(fields.accountId, 256),
      account_type: sanitizeToken(fields.accountType, 128),
      action: sanitizeToken(fields.action, 32),
      ttl_seconds:
        Number.isInteger(fields.ttlSeconds) && fields.ttlSeconds >= 0 ? fields.ttlSeconds : null,
      reason: sanitizeToken(fields.reason, 64)
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

function detectHarness(headers = {}) {
  const explicitId = sanitizeToken(getHeader(headers, 'x-crs-harness'), MAX_HARNESS_ID_LENGTH)
  const explicitVersion = sanitizeToken(
    getHeader(headers, 'x-crs-harness-version'),
    MAX_HARNESS_VERSION_LENGTH
  )

  if (explicitId) {
    return {
      harness_id: explicitId.toLowerCase(),
      harness_version: explicitVersion,
      harness_source: 'explicit_header'
    }
  }

  const userAgent = getHeader(headers, 'user-agent') || ''
  const patterns = [
    { regex: /^claude-cli\/([a-zA-Z0-9.-]+)/i, id: 'claude-code' },
    { regex: /^zcode\/([a-zA-Z0-9.-]+)(?:\s|$)/i, id: 'zcode' },
    { regex: /^codex_cli_rs\/([a-zA-Z0-9.-]+)/i, id: 'codex-cli' },
    { regex: /^codex_vscode\/([a-zA-Z0-9.-]+)/i, id: 'codex-vscode' },
    { regex: /^factory-cli\/([a-zA-Z0-9.-]+)/i, id: 'droid' }
  ]

  for (const pattern of patterns) {
    const match = userAgent.match(pattern.regex)
    if (match) {
      return {
        harness_id: pattern.id,
        harness_version: sanitizeToken(match[1], MAX_HARNESS_VERSION_LENGTH),
        harness_source: 'user_agent'
      }
    }
  }

  return {
    harness_id: 'unknown',
    harness_version: null,
    harness_source: 'unknown'
  }
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
        skill_detected: effectiveSkillSummary.skill_detected === true,
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
    status_code: outcome.statusCode ?? null,
    upstream_status_code: outcome.upstreamStatusCode ?? null,
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
  createTelemetryContext,
  detectHarness,
  finalizeTelemetry,
  hashValue,
  normalizeToolNames,
  recordUpstreamTelemetry,
  stableSerialize,
  summarizeRequestForTelemetry,
  summarizeResponseForTelemetry
}
