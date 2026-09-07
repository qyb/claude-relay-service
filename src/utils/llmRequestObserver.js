/**
 * `/v1/messages` 请求观察器。
 *
 * Prompt Log 在入口记录最新用户文本；Telemetry 在响应 finish/异常 close 时
 * 只写一个终态。流式响应只提取 Anthropic SSE 的 usage、stop_reason 和工具名，
 * 不保留模型正文或工具参数。
 */

const { StringDecoder } = require('string_decoder')
const logger = require('./logger')
const promptLogger = require('./promptLogger')
const sessionHelper = require('./sessionHelper')
const { defaultAgentContextResolver } = require('./agentContext')
const purposeClassifier = require('./requestPurposeClassifier')
const {
  createTelemetryContext,
  classifyFailureStage,
  extractUpstreamErrorFields,
  finalizeTelemetry,
  recordUpstreamTelemetry,
  summarizeResponseForTelemetry
} = require('./llmTelemetry')

const skillPromptAnalyzer = require('./skillPromptAnalyzer')

const REQUEST_OBSERVER = Symbol('llmRequestObserver')

function isFeatureEnabled(methodName) {
  try {
    return typeof logger[methodName] === 'function' && logger[methodName]() === true
  } catch (error) {
    logger.error(`Failed to check ${methodName}:`, error?.message || String(error))
    return false
  }
}

function providerForAccountType(accountType) {
  if (accountType === 'claude-official' || accountType === 'claude-console') {
    return 'anthropic'
  }
  if (accountType === 'bedrock') {
    return 'aws-bedrock'
  }
  return accountType || null
}

function mergeUsage(current, incoming) {
  if (!incoming || typeof incoming !== 'object') {
    return current
  }

  const merged = { ...(current || {}) }
  const numericFields = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens'
  ]

  for (const field of numericFields) {
    if (typeof incoming[field] === 'number' && Number.isFinite(incoming[field])) {
      merged[field] = incoming[field]
    }
  }

  const incomingCacheCreation = incoming.cache_creation
  if (incomingCacheCreation && typeof incomingCacheCreation === 'object') {
    merged.cache_creation = { ...(merged.cache_creation || {}) }
    for (const field of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
      if (
        typeof incomingCacheCreation[field] === 'number' &&
        Number.isFinite(incomingCacheCreation[field])
      ) {
        merged.cache_creation[field] = incomingCacheCreation[field]
      }
    }
  }

  return merged
}

class LlmRequestObserver {
  constructor(req, res, sessionInfo, telemetryEnabled, skillSummary = null, requestMeta = {}) {
    this.res = res
    this.telemetryEnabled = telemetryEnabled
    this.context = telemetryEnabled
      ? createTelemetryContext(req, sessionInfo, skillSummary, requestMeta)
      : null
    this.finishSeen = false
    this.usage = null
    this.responseSummary = null
    this.upstreamResponseSummary = null
    this.provider = null
    this.accountId = null
    this.accountType = null
    this.apiUrl = null
    this.model = req?.body?.model ?? null
    this.upstreamRequestId = null
    this.queueRequestId = null
    this.upstreamStatusCode = null
    this.gatewayStatusCode = null
    this.failureStage = null
    this.upstreamErrorType = null
    this.upstreamErrorCode = null
    this.upstreamMessageTemplate = null
    this.attemptEventCount = 0
    this.attemptCount = 1
    this.retryReason = null
    this.errorType = null
    this.errorCode = null
    this.firstByteAtMs = null
    this.streamEventSeen = false
    this.streamStopReason = null
    this.streamToolUseCount = 0
    this.streamToolUseNames = new Set()
    this.decoder = telemetryEnabled && req?.body?.stream === true ? new StringDecoder('utf8') : null
    this.sseBuffer = ''
    this.sseDataLines = []
    this.upstreamDecoder = null
    this.upstreamSseBuffer = ''
    this.upstreamSseDataLines = []

    if (telemetryEnabled) {
      this._attachResponseLifecycle()
    }
  }

  observeUpstream(details = {}) {
    this.accountId = details.accountId ?? this.accountId
    this.accountType = details.accountType ?? this.accountType
    this.apiUrl = details.apiUrl ?? this.apiUrl
    this.provider = details.provider ?? providerForAccountType(details.accountType) ?? this.provider
    this.model = details.model ?? this.model
    this.queueRequestId = details.queueRequestId ?? this.queueRequestId
    this.upstreamStatusCode = details.upstreamStatusCode ?? this.upstreamStatusCode
    this.upstreamRequestId = details.upstreamRequestId ?? this.upstreamRequestId
    this.upstreamErrorType = details.upstreamErrorType ?? this.upstreamErrorType
    this.upstreamErrorCode = details.upstreamErrorCode ?? this.upstreamErrorCode
    this.upstreamMessageTemplate = details.upstreamMessageTemplate ?? this.upstreamMessageTemplate
    // 响应体中的错误详情（智谱 1302 等）：relay 只传原始 body，这里统一脱敏
    if (details.upstreamErrorBody !== undefined && details.upstreamErrorBody !== null) {
      const extracted = extractUpstreamErrorFields(details.upstreamErrorBody)
      this.upstreamErrorType = extracted.upstreamErrorType ?? this.upstreamErrorType
      this.upstreamErrorCode = extracted.upstreamErrorCode ?? this.upstreamErrorCode
      this.upstreamMessageTemplate =
        extracted.upstreamMessageTemplate ?? this.upstreamMessageTemplate
    }
    if (
      Number.isInteger(details.upstreamStatusCode) &&
      details.upstreamStatusCode >= 400 &&
      this.failureStage === null
    ) {
      this.failureStage = 'upstream_http'
    }
    return this
  }

  // 网关决定返回给客户端的状态码（区别于 res.statusCode 与上游状态）
  observeGatewayStatus(statusCode) {
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 999) {
      this.gatewayStatusCode = statusCode
    }
    return this
  }

  /**
   * 队列锁结果：acquired 回填 queue_request_id；timeout/backend_error 标记
   * failure_stage=queue，使调度失败与排队失败可区分。
   */
  observeQueue(outcome = {}) {
    if (outcome.queueRequestId) {
      this.queueRequestId = outcome.queueRequestId
    }
    if (outcome.status === 'timeout' || outcome.status === 'error') {
      this.failureStage = this.failureStage ?? 'queue'
      const queueError = outcome.status === 'error' ? 'queue_backend_error' : 'queue_timeout'
      this.errorCode = this.errorCode ?? queueError
      this.errorType = this.errorType ?? queueError
    }
    return this
  }

  /**
   * 逐次真实上游尝试事件（v2）：每次 attempt 结束立即落盘 upstream_attempt，
   * 用 gateway_request_id + attempt_number 还原完整 retry/failover 链。
   */
  observeAttempt(details = {}) {
    if (!this.telemetryEnabled || !this.context || this.context.finalized) {
      return this
    }
    this.attemptEventCount += 1
    const extracted =
      details.upstreamErrorBody !== undefined && details.upstreamErrorBody !== null
        ? extractUpstreamErrorFields(details.upstreamErrorBody)
        : {}
    recordUpstreamTelemetry('upstream_attempt', {
      gatewayRequestId: this.context.gatewayRequestId,
      attemptNumber: this.attemptEventCount,
      accountId: details.accountId ?? this.accountId,
      accountType: details.accountType ?? this.accountType,
      provider: details.provider ?? this.provider,
      model: details.model ?? this.model,
      queueRequestId: details.queueRequestId ?? this.queueRequestId,
      queueWaitMs: details.queueWaitMs ?? null,
      upstreamLatencyMs: details.upstreamLatencyMs ?? null,
      upstreamStatusCode: details.upstreamStatusCode ?? null,
      success: details.success === true,
      upstreamErrorType: details.upstreamErrorType ?? extracted.upstreamErrorType ?? null,
      upstreamErrorCode: details.upstreamErrorCode ?? extracted.upstreamErrorCode ?? null,
      upstreamMessageTemplate:
        details.upstreamMessageTemplate ?? extracted.upstreamMessageTemplate ?? null,
      upstreamRequestId: details.upstreamRequestId ?? null,
      usage: details.usage ?? null,
      apiUrl: details.apiUrl ?? this.apiUrl
    })
    return this
  }

  observeUsage(usage) {
    this.usage = mergeUsage(this.usage, usage)
    return this
  }

  observeUpstreamStreamChunk(chunk, encoding) {
    if (!this.telemetryEnabled || !this.context || this.context.finalized) {
      return this
    }

    if (!this.upstreamDecoder) {
      this.upstreamDecoder = new StringDecoder('utf8')
    }

    try {
      let decoded
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        decoded = this.upstreamDecoder.write(Buffer.from(chunk))
      } else {
        const bufferEncoding = typeof encoding === 'string' ? encoding : 'utf8'
        decoded = this.upstreamDecoder.write(Buffer.from(String(chunk), bufferEncoding))
      }
      this._consumeUpstreamSseText(decoded)
    } catch (error) {
      logger.error(
        'Failed to inspect upstream telemetry SSE chunk:',
        error?.message || String(error)
      )
    }

    return this
  }

  observeResponse(response) {
    if (!response || typeof response !== 'object') {
      return this
    }

    this.responseSummary = summarizeResponseForTelemetry(response)
    if (!this.upstreamResponseSummary) {
      this.observeUsage(response.usage)
      this.upstreamRequestId = response.id ?? this.upstreamRequestId
      this.model = response.model ?? this.model
    }
    return this
  }

  observeUpstreamResponse(response) {
    if (!response || typeof response !== 'object') {
      return this
    }

    this.upstreamResponseSummary = summarizeResponseForTelemetry(response)
    this.observeUsage(response.usage)
    this.upstreamRequestId = response.id ?? this.upstreamRequestId
    this.model = response.model ?? this.model
    return this
  }

  observeError(error, details = {}) {
    this.errorType = details.errorType ?? error?.name ?? this.errorType ?? 'request_error'
    this.errorCode = details.errorCode ?? error?.code ?? this.errorCode
    this.upstreamStatusCode =
      details.upstreamStatusCode ??
      error?.response?.statusCode ??
      error?.response?.status ??
      error?.statusCode ??
      error?.status ??
      this.upstreamStatusCode
    if (details.upstreamErrorBody !== undefined && details.upstreamErrorBody !== null) {
      const extracted = extractUpstreamErrorFields(details.upstreamErrorBody)
      this.upstreamErrorType = extracted.upstreamErrorType ?? this.upstreamErrorType
      this.upstreamErrorCode = extracted.upstreamErrorCode ?? this.upstreamErrorCode
      this.upstreamMessageTemplate =
        extracted.upstreamMessageTemplate ?? this.upstreamMessageTemplate
    }
    this.upstreamErrorType = details.upstreamErrorType ?? this.upstreamErrorType
    this.upstreamErrorCode = details.upstreamErrorCode ?? this.upstreamErrorCode
    this.upstreamMessageTemplate = details.upstreamMessageTemplate ?? this.upstreamMessageTemplate
    // 显式指定优先；否则按错误码/上游状态推导失败阶段
    const derivedStage = classifyFailureStage({
      errorCode: this.errorCode,
      errorType: this.errorType,
      upstreamStatusCode: this.upstreamStatusCode,
      clientDisconnected: details.clientDisconnected === true
    })
    this.failureStage = details.failureStage ?? this.failureStage ?? derivedStage
    return this
  }

  noteRetry(reason) {
    this.attemptCount += 1
    this.retryReason = reason ?? this.retryReason
    return this
  }

  observeClientDisconnect() {
    this.failureStage = 'client_disconnect'
    return this._finalize({
      clientDisconnected: true,
      responseCompleted: false,
      forceError: true,
      errorType: 'client_disconnected',
      errorCode: 'client_disconnected'
    })
  }

  _attachResponseLifecycle() {
    const originalWrite = this.res.write
    if (this.decoder && typeof originalWrite === 'function') {
      const observer = this
      this.res.write = function (...args) {
        observer._observeOutputChunk(args[0], args[1])
        return originalWrite.apply(this, args)
      }
    }

    const originalEnd = this.res.end
    if (this.decoder && typeof originalEnd === 'function') {
      const observer = this
      this.res.end = function (...args) {
        if (args[0] !== undefined && args[0] !== null && typeof args[0] !== 'function') {
          observer._observeOutputChunk(args[0], args[1])
        }
        return originalEnd.apply(this, args)
      }
    }

    const originalJson = this.res.json
    if (typeof originalJson === 'function') {
      const observer = this
      this.res.json = function (...args) {
        observer.observeResponse(args[0])
        return originalJson.apply(this, args)
      }
    }

    this.res.once('finish', () => {
      this.finishSeen = true
      this._finalize({ clientDisconnected: false, responseCompleted: true })
    })

    this.res.once('close', () => {
      if (!this.finishSeen) {
        this.observeClientDisconnect()
      }
    })
  }

  _observeOutputChunk(chunk, encoding) {
    if (chunk === undefined || chunk === null) {
      return
    }

    if (this.firstByteAtMs === null) {
      this.firstByteAtMs = Date.now()
    }

    let decoded
    try {
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        decoded = this.decoder.write(Buffer.from(chunk))
      } else {
        const bufferEncoding = typeof encoding === 'string' ? encoding : 'utf8'
        decoded = this.decoder.write(Buffer.from(String(chunk), bufferEncoding))
      }
    } catch (error) {
      logger.error('Failed to inspect telemetry SSE chunk:', error?.message || String(error))
      return
    }

    this._consumeSseText(decoded)
  }

  _consumeSseText(text) {
    if (!text) {
      return
    }

    this.sseBuffer += text
    let newlineIndex = this.sseBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      let line = this.sseBuffer.slice(0, newlineIndex)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      this.sseBuffer = this.sseBuffer.slice(newlineIndex + 1)
      this._consumeSseLine(line)
      newlineIndex = this.sseBuffer.indexOf('\n')
    }
  }

  _consumeSseLine(line) {
    if (line === '') {
      this._consumeSseEvent()
      return
    }
    if (line.startsWith('data:')) {
      this.sseDataLines.push(line.slice(5).trimStart())
    }
  }

  _consumeSseEvent() {
    if (this.sseDataLines.length === 0) {
      return
    }

    const payload = this.sseDataLines.join('\n')
    this.sseDataLines = []
    if (!payload || payload === '[DONE]') {
      return
    }

    let event
    try {
      event = JSON.parse(payload)
    } catch (_) {
      return
    }

    this._observeSseEvent(event)
  }

  _observeSseEvent(event) {
    if (!event || typeof event !== 'object') {
      return
    }

    this.streamEventSeen = true
    const message = event.message && typeof event.message === 'object' ? event.message : null
    const contentBlock =
      event.content_block && typeof event.content_block === 'object' ? event.content_block : null

    if (message) {
      this.upstreamRequestId = message.id ?? this.upstreamRequestId
      this.model = message.model ?? this.model
      this.streamStopReason = message.stop_reason ?? this.streamStopReason
      this.observeUsage(message.usage)
      for (const block of Array.isArray(message.content) ? message.content : []) {
        this._observeToolUseBlock(block)
      }
    }

    this._observeToolUseBlock(contentBlock)
    this.observeUsage(event.usage)
    this.streamStopReason = event.delta?.stop_reason ?? event.stop_reason ?? this.streamStopReason

    if (event.type === 'error') {
      this.errorType = event.error?.type ?? 'upstream_stream_error'
      this.errorCode = event.error?.code ?? event.error?.type ?? 'upstream_stream_error'
      // 流式响应已成功建立（HTTP 200）后出错，属于 upstream_stream 而非 upstream_http。
      // 不捕获 error.message：SSE 错误消息没有可归一化的结构，原样落盘会泄露正文
      this.failureStage = 'upstream_stream'
    }
  }

  _observeToolUseBlock(block) {
    if (block?.type !== 'tool_use') {
      return
    }
    this.streamToolUseCount += 1
    if (typeof block.name === 'string' && block.name.trim()) {
      this.streamToolUseNames.add(block.name)
    }
  }

  _flushSse() {
    if (!this.decoder) {
      return
    }

    try {
      this._consumeSseText(this.decoder.end())
      if (this.sseBuffer) {
        const tail = this.sseBuffer.endsWith('\r') ? this.sseBuffer.slice(0, -1) : this.sseBuffer
        this.sseBuffer = ''
        this._consumeSseLine(tail)
      }
      this._consumeSseEvent()
    } catch (error) {
      logger.error('Failed to flush telemetry SSE summary:', error?.message || String(error))
    } finally {
      this.decoder = null
    }
  }

  _consumeUpstreamSseText(text) {
    if (!text) {
      return
    }

    this.upstreamSseBuffer += text
    let newlineIndex = this.upstreamSseBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      let line = this.upstreamSseBuffer.slice(0, newlineIndex)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      this.upstreamSseBuffer = this.upstreamSseBuffer.slice(newlineIndex + 1)
      if (line === '') {
        this._consumeUpstreamSseEvent()
      } else if (line.startsWith('data:')) {
        this.upstreamSseDataLines.push(line.slice(5).trimStart())
      }
      newlineIndex = this.upstreamSseBuffer.indexOf('\n')
    }
  }

  _consumeUpstreamSseEvent() {
    if (this.upstreamSseDataLines.length === 0) {
      return
    }

    const payload = this.upstreamSseDataLines.join('\n')
    this.upstreamSseDataLines = []
    if (!payload || payload === '[DONE]') {
      return
    }

    try {
      this._observeSseEvent(JSON.parse(payload))
    } catch (_) {
      return
    }
  }

  _flushUpstreamSse() {
    if (!this.upstreamDecoder) {
      return
    }

    try {
      this._consumeUpstreamSseText(this.upstreamDecoder.end())
      if (this.upstreamSseBuffer) {
        const tail = this.upstreamSseBuffer.endsWith('\r')
          ? this.upstreamSseBuffer.slice(0, -1)
          : this.upstreamSseBuffer
        this.upstreamSseBuffer = ''
        if (tail.startsWith('data:')) {
          this.upstreamSseDataLines.push(tail.slice(5).trimStart())
        }
      }
      this._consumeUpstreamSseEvent()
    } catch (error) {
      logger.error(
        'Failed to flush upstream telemetry SSE summary:',
        error?.message || String(error)
      )
    } finally {
      this.upstreamDecoder = null
    }
  }

  _getResponseSummary() {
    if (this.upstreamResponseSummary) {
      return this.upstreamResponseSummary
    }
    if (this.responseSummary) {
      return this.responseSummary
    }
    if (!this.streamEventSeen) {
      return null
    }
    return {
      stop_reason: this.streamStopReason,
      tool_use_count: this.streamToolUseCount,
      tool_use_names: Array.from(this.streamToolUseNames)
    }
  }

  _finalize(options = {}) {
    if (!this.telemetryEnabled || !this.context || this.context.finalized) {
      return false
    }

    this._flushSse()
    this._flushUpstreamSse()
    const statusCode = this.res.statusCode ?? null
    const isError = options.forceError === true || Boolean(this.errorType) || statusCode >= 400
    const errorType =
      options.errorType ?? this.errorType ?? (isError && statusCode ? `http_${statusCode}` : null)
    const errorCode =
      options.errorCode ?? this.errorCode ?? (isError && statusCode ? `http_${statusCode}` : null)
    const clientDisconnected = options.clientDisconnected === true
    const failureStage =
      this.failureStage ??
      (isError
        ? classifyFailureStage({
            errorCode,
            errorType,
            upstreamStatusCode: this.upstreamStatusCode,
            clientDisconnected
          })
        : null)

    return finalizeTelemetry(this.context, {
      eventType: isError ? 'llm_request_error' : 'llm_request_completed',
      provider: this.provider,
      accountId: this.accountId,
      accountType: this.accountType,
      apiUrl: this.apiUrl,
      model: this.model,
      upstreamRequestId: this.upstreamRequestId,
      queueRequestId: this.queueRequestId,
      usage: this.usage,
      responseSummary: this._getResponseSummary(),
      ttftMs:
        this.firstByteAtMs === null
          ? null
          : Math.max(0, this.firstByteAtMs - this.context.startTimeMs),
      attemptCount: this.attemptCount,
      retryReason: this.retryReason,
      statusCode,
      clientStatusCode: statusCode,
      gatewayStatusCode: this.gatewayStatusCode ?? statusCode,
      upstreamStatusCode: this.upstreamStatusCode,
      failureStage,
      upstreamErrorType: this.upstreamErrorType,
      upstreamErrorCode: this.upstreamErrorCode,
      upstreamMessageTemplate: this.upstreamMessageTemplate,
      responseCompleted: options.responseCompleted === true && !isError,
      clientDisconnected,
      errorType,
      errorCode,
      failureContext: {
        errorCode,
        errorType,
        upstreamStatusCode: this.upstreamStatusCode,
        clientDisconnected
      }
    })
  }
}

function startLlmRequestObservation(req, res) {
  if (req?.[REQUEST_OBSERVER]) {
    return req[REQUEST_OBSERVER]
  }

  const promptLogEnabled = isFeatureEnabled('isPromptLogEnabled')
  const telemetryEnabled = isFeatureEnabled('isTelemetryEnabled')
  let sessionInfo = { clientSessionId: null, source: 'none', stickySessionKey: null }
  if (promptLogEnabled || telemetryEnabled) {
    try {
      sessionInfo = sessionHelper.extractClientSessionId(req?.headers, req?.body)
    } catch (error) {
      logger.error('Failed to extract LLM client session:', error?.message || String(error))
    }
  }

  let skillAnalysis = { summary: null, skillRecords: [] }
  let agentContextInfo = { agentContextId: null, contextFingerprint: null }
  let purposeInfo = null
  let latestUserText = null
  if (promptLogEnabled || telemetryEnabled) {
    try {
      // P0-2：先派生叶级上下文，分析器的增量状态按上下文隔离。
      // resolver 在同 scope + 同 system/tool 配置内维护首条消息分支的
      // alias 迁移，压缩后首条消息被 summary 替换时上下文 id 保持稳定
      const contextScopeKey = promptLogger.buildPromptSessionKey(
        req?.apiKey?.id,
        sessionInfo.clientSessionId
      )
      agentContextInfo = defaultAgentContextResolver.resolve(req?.body, contextScopeKey)
      skillAnalysis = skillPromptAnalyzer.analyze(
        req?.body,
        sessionInfo,
        req?.apiKey?.id,
        agentContextInfo,
        { requestId: req?.requestId ?? null }
      )
    } catch (error) {
      logger.error('Failed to analyze SKILL prompt injection:', error?.message || String(error))
    }

    try {
      // P0-1：判定请求目的（header > 模板指纹 > 上下文角色 > 结构信号）。
      // 只读最后一条 user 消息：尾部 tool_result-only 的工具续跑请求不能
      // 回溯到历史人工 Prompt，否则 token/cost 会被错归因为 human
      latestUserText = promptLogger.extractLatestUserMessageText(req?.body)
      purposeInfo = purposeClassifier.classify({
        headers: req?.headers,
        latestUserText,
        skillInstanceDetected:
          Number.isInteger(skillAnalysis?.summary?.skill_injection_count) &&
          skillAnalysis.summary.skill_injection_count > 0,
        toolsOfferedCount: Array.isArray(req?.body?.tools) ? req.body.tools.length : 0,
        messageCount: Array.isArray(req?.body?.messages) ? req.body.messages.length : 0,
        rootSessionId: sessionInfo.clientSessionId,
        apiKeyId: req?.apiKey?.id,
        agentContextId: agentContextInfo.agentContextId
      })
    } catch (error) {
      logger.error('Failed to classify request purpose:', error?.message || String(error))
    }
  }

  if (promptLogEnabled) {
    try {
      promptLogger.recordRequest(req, sessionInfo, skillAnalysis.skillRecords, {
        ...(purposeInfo || {}),
        latestUserText,
        // classifier 返回值不含该字段，显式附加保证 prompt-log 与 telemetry
        // 对同一请求携带相同的 agent_context_id
        agent_context_id: agentContextInfo.agentContextId
      })
    } catch (error) {
      logger.error('Failed to record latest user Prompt:', error?.message || String(error))
    }
  }

  const observer = new LlmRequestObserver(
    req,
    res,
    sessionInfo,
    telemetryEnabled,
    skillAnalysis.summary,
    { agentContext: agentContextInfo, purposeInfo: purposeInfo || {} }
  )
  if (req && typeof req === 'object') {
    Object.defineProperty(req, REQUEST_OBSERVER, {
      value: observer,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }
  return observer
}

module.exports = {
  LlmRequestObserver,
  mergeUsage,
  providerForAccountType,
  startLlmRequestObservation
}
