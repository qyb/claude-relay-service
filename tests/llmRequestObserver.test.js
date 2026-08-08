const { EventEmitter } = require('events')

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  telemetry: jest.fn(),
  isPromptLogEnabled: jest.fn(),
  isTelemetryEnabled: jest.fn()
}))

jest.mock('../src/utils/promptLogger', () => ({
  recordRequest: jest.fn()
}))

jest.mock('../src/utils/sessionHelper', () => ({
  extractClientSessionId: jest.fn()
}))

const logger = require('../src/utils/logger')
const promptLogger = require('../src/utils/promptLogger')
const sessionHelper = require('../src/utils/sessionHelper')
const {
  mergeUsage,
  providerForAccountType,
  startLlmRequestObservation
} = require('../src/utils/llmRequestObserver')

const SESSION_INFO = {
  clientSessionId: '11111111-1111-4111-8111-111111111111',
  source: 'header',
  stickySessionKey: '11111111-1111-4111-8111-111111111111'
}

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.chunks = []
    this.endArgs = []
    this.jsonBody = null
  }

  write(...args) {
    this.chunks.push(args[0])
    return false
  }

  end(...args) {
    this.endArgs = args
    return this
  }

  json(body) {
    this.jsonBody = body
    return this
  }
}

function buildRequest(overrides = {}) {
  return {
    requestId: 'gateway-request-1',
    originalUrl: '/v1/messages?beta=true',
    headers: {
      'user-agent': 'claude-cli/1.2.3',
      'x-claude-code-session-id': SESSION_INFO.clientSessionId
    },
    apiKey: { id: 'key-record-1', name: 'employee-key' },
    body: {
      model: 'claude-sonnet-test',
      stream: true,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'human prompt' }] }]
    },
    ...overrides
  }
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

describe('llmRequestObserver helpers', () => {
  it('mergeUsage 合并分散在 message_start 和 message_delta 的 token', () => {
    const first = mergeUsage(null, {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_5m_input_tokens: 2 }
    })
    const merged = mergeUsage(first, {
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation: { ephemeral_1h_input_tokens: 0 }
    })

    expect(merged).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 2,
        ephemeral_1h_input_tokens: 0
      }
    })
  })

  it('按 account type 生成 provider', () => {
    expect(providerForAccountType('claude-official')).toBe('anthropic')
    expect(providerForAccountType('claude-console')).toBe('anthropic')
    expect(providerForAccountType('bedrock')).toBe('aws-bedrock')
    expect(providerForAccountType('ccr')).toBe('ccr')
  })
})

describe('LLM request observation lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    logger.isPromptLogEnabled.mockReturnValue(false)
    logger.isTelemetryEnabled.mockReturnValue(false)
    sessionHelper.extractClientSessionId.mockReturnValue(SESSION_INFO)
  })

  it('两个功能都关闭时不提取 session、不包装 response', () => {
    const req = buildRequest()
    const res = new FakeResponse()
    const originalWrite = res.write

    startLlmRequestObservation(req, res)
    res.emit('finish')

    expect(sessionHelper.extractClientSessionId).not.toHaveBeenCalled()
    expect(promptLogger.recordRequest).not.toHaveBeenCalled()
    expect(logger.telemetry).not.toHaveBeenCalled()
    expect(res.write).toBe(originalWrite)
  })

  it('同一 Express 请求只启动一次并只记录一次 Prompt', () => {
    logger.isPromptLogEnabled.mockReturnValue(true)
    const req = buildRequest()
    const res = new FakeResponse()

    const first = startLlmRequestObservation(req, res)
    const second = startLlmRequestObservation(req, res)

    expect(second).toBe(first)
    expect(sessionHelper.extractClientSessionId).toHaveBeenCalledTimes(1)
    expect(promptLogger.recordRequest).toHaveBeenCalledTimes(1)
    expect(promptLogger.recordRequest).toHaveBeenCalledWith(req, SESSION_INFO)
  })

  it('session 提取失败时按无 session 继续，不阻断 Prompt 和 telemetry', () => {
    logger.isPromptLogEnabled.mockReturnValue(true)
    logger.isTelemetryEnabled.mockReturnValue(true)
    sessionHelper.extractClientSessionId.mockImplementation(() => {
      throw new Error('session parser failure')
    })
    const req = buildRequest()
    const res = new FakeResponse()

    expect(() => startLlmRequestObservation(req, res)).not.toThrow()
    res.emit('finish')

    expect(promptLogger.recordRequest).toHaveBeenCalledWith(req, {
      clientSessionId: null,
      source: 'none',
      stickySessionKey: null
    })
    expect(logger.telemetry).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to extract LLM client session:',
      'session parser failure'
    )
  })

  it('分片 SSE 只提取 tool、usage 和 stop reason，并保持 write 返回值', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const req = buildRequest()
    const res = new FakeResponse()
    const observer = startLlmRequestObservation(req, res)
    observer.observeUpstream({
      accountId: 'account-1',
      accountType: 'claude-official',
      model: 'claude-sonnet-upstream'
    })

    const messageStart = sse({
      type: 'message_start',
      message: {
        id: 'msg-upstream-1',
        model: 'claude-sonnet-upstream',
        content: [],
        usage: { input_tokens: 10, cache_creation_input_tokens: 2 }
      }
    })
    const toolRead = sse({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }
    })
    const sensitiveDelta = sse({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"secret":"do-not-log"}' }
    })
    const toolEdit = sse({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tool-2', name: 'Edit', input: {} }
    })
    const messageDelta = sse({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5, cache_read_input_tokens: 3 }
    })
    const payload = messageStart + toolRead + sensitiveDelta + toolEdit + messageDelta

    expect(res.write(Buffer.from(payload.slice(0, 37)))).toBe(false)
    expect(res.write(Buffer.from(payload.slice(37)))).toBe(false)
    res.emit('finish')
    res.emit('close')

    expect(logger.telemetry).toHaveBeenCalledTimes(1)
    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      event_type: 'llm_request_completed',
      upstream_request_id: 'msg-upstream-1',
      provider: 'anthropic',
      account_id: 'account-1',
      account_type: 'claude-official',
      model: 'claude-sonnet-upstream',
      stop_reason: 'tool_use',
      tool_use_count: 2,
      tool_use_names: ['Edit', 'Read'],
      parallel_tool_use_detected: true,
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      total_tokens: 20,
      usage_available: true,
      status_code: 200,
      response_completed: true,
      client_disconnected: false
    })
    expect(typeof record.ttft_ms).toBe('number')
    expect(JSON.stringify(record)).not.toContain('do-not-log')
  })

  it('非流式响应通过 observeResponse 提取摘要但不记录正文', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const req = buildRequest({
      body: {
        model: 'claude-sonnet-test',
        stream: false,
        messages: [{ role: 'user', content: 'human prompt' }]
      }
    })
    const res = new FakeResponse()
    const observer = startLlmRequestObservation(req, res)

    observer.observeResponse({
      id: 'msg-non-stream',
      model: 'claude-sonnet-result',
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 2 },
      content: [
        { type: 'text', text: 'private model response' },
        { type: 'tool_use', name: 'Bash', input: { command: 'private command' } }
      ]
    })
    res.emit('finish')

    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      upstream_request_id: 'msg-non-stream',
      model: 'claude-sonnet-result',
      stop_reason: 'tool_use',
      tool_use_count: 1,
      tool_use_names: ['Bash'],
      input_tokens: 7,
      output_tokens: 2
    })
    expect(JSON.stringify(record)).not.toContain('private model response')
    expect(JSON.stringify(record)).not.toContain('private command')
  })

  it('包装 res.json 自动采集 bridge 的非流式响应', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const req = buildRequest({
      body: {
        model: 'gemini-test',
        stream: false,
        messages: [{ role: 'user', content: 'human prompt' }]
      }
    })
    const res = new FakeResponse()

    startLlmRequestObservation(req, res)
    const responseBody = {
      id: 'gemini-response',
      model: 'gemini-result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 6 },
      content: [{ type: 'text', text: 'private bridge response' }]
    }
    expect(res.json(responseBody)).toBe(res)
    res.emit('finish')

    expect(res.jsonBody).toBe(responseBody)
    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      upstream_request_id: 'gemini-response',
      model: 'gemini-result',
      stop_reason: 'end_turn',
      input_tokens: 4,
      output_tokens: 6
    })
    expect(JSON.stringify(logger.telemetry.mock.calls[0][0])).not.toContain(
      'private bridge response'
    )
  })

  it('异常 close 记录客户端断开，之后的 finish 不会产生第二条', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const req = buildRequest()
    const res = new FakeResponse()

    startLlmRequestObservation(req, res)
    res.emit('close')
    res.emit('finish')

    expect(logger.telemetry).toHaveBeenCalledTimes(1)
    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      event_type: 'llm_request_error',
      response_completed: false,
      client_disconnected: true,
      error_type: 'client_disconnected',
      error_code: 'client_disconnected'
    })
  })

  it('保留内部重试次数和最终错误分类', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const req = buildRequest()
    const res = new FakeResponse()
    const observer = startLlmRequestObservation(req, res)

    observer.noteRetry('console concurrency full')
    observer.observeError(
      Object.assign(new Error('upstream timeout'), { code: 'UPSTREAM_TIMEOUT' })
    )
    res.statusCode = 504
    res.emit('finish')

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      event_type: 'llm_request_error',
      attempt_count: 2,
      retry_reason: 'console-concurrency-full',
      status_code: 504,
      error_type: 'Error',
      error_code: 'UPSTREAM_TIMEOUT',
      response_completed: false
    })
  })

  it('SSE error 事件即使 HTTP 200 也记录 error 终态', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const req = buildRequest()
    const res = new FakeResponse()

    startLlmRequestObservation(req, res)
    res.end(
      sse({
        type: 'error',
        error: { type: 'overloaded_error', message: 'sensitive upstream message' }
      })
    )
    res.emit('finish')

    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      event_type: 'llm_request_error',
      status_code: 200,
      error_type: 'overloaded_error',
      error_code: 'overloaded_error'
    })
    expect(JSON.stringify(record)).not.toContain('sensitive upstream message')
  })
})
