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
const {
  createTelemetryContext,
  finalizeTelemetry,
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
  constructor(req, res, sessionInfo, telemetryEnabled, skillSummary = null) {
    this.res = res
    this.telemetryEnabled = telemetryEnabled
    this.context = telemetryEnabled ? createTelemetryContext(req, sessionInfo, skillSummary) : null
    this.finishSeen = false
    this.usage = null
    this.responseSummary = null
    this.provider = null
    this.accountId = null
    this.accountType = null
    this.apiUrl = null
    this.model = req?.body?.model ?? null
    this.upstreamRequestId = null
    this.queueRequestId = null
    this.upstreamStatusCode = null
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
    return this
  }

  observeUsage(usage) {
    this.usage = mergeUsage(this.usage, usage)
    return this
  }

  observeResponse(response) {
    if (!response || typeof response !== 'object') {
      return this
    }

    this.responseSummary = summarizeResponseForTelemetry(response)
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
    return this
  }

  noteRetry(reason) {
    this.attemptCount += 1
    this.retryReason = reason ?? this.retryReason
    return this
  }

  observeClientDisconnect() {
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

  _getResponseSummary() {
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
    const statusCode = this.res.statusCode ?? null
    const isError = options.forceError === true || Boolean(this.errorType) || statusCode >= 400
    const errorType =
      options.errorType ?? this.errorType ?? (isError && statusCode ? `http_${statusCode}` : null)
    const errorCode =
      options.errorCode ?? this.errorCode ?? (isError && statusCode ? `http_${statusCode}` : null)

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
      upstreamStatusCode: this.upstreamStatusCode,
      responseCompleted: options.responseCompleted === true && !isError,
      clientDisconnected: options.clientDisconnected === true,
      errorType,
      errorCode
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
  if (promptLogEnabled || telemetryEnabled) {
    try {
      skillAnalysis = skillPromptAnalyzer.analyze(req?.body, sessionInfo, req?.apiKey?.id)
    } catch (error) {
      logger.error('Failed to analyze SKILL prompt injection:', error?.message || String(error))
    }
  }

  if (promptLogEnabled) {
    try {
      promptLogger.recordRequest(req, sessionInfo, skillAnalysis.skillRecords)
    } catch (error) {
      logger.error('Failed to record latest user Prompt:', error?.message || String(error))
    }
  }

  const observer = new LlmRequestObserver(
    req,
    res,
    sessionInfo,
    telemetryEnabled,
    skillAnalysis.summary
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
