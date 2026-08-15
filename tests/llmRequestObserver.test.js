const { EventEmitter } = require('events')

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  telemetry: jest.fn(),
  isPromptLogEnabled: jest.fn(),
  isTelemetryEnabled: jest.fn()
}))

jest.mock('../src/utils/promptLogger', () => {
  const crypto = require('crypto')
  // 与真实 extractLatestUserMessageText 同语义：只读最后一条 user 消息，
  // 没有顶层 text block（tool_result-only）时返回 null，不跨消息回溯
  const extractLatestUserMessageText = (body) => {
    const messages = body?.messages
    if (!Array.isArray(messages)) {
      return null
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message?.role !== 'user') {
        continue
      }
      if (typeof message.content === 'string') {
        return message.content.trim() ? message.content : null
      }
      if (!Array.isArray(message.content)) {
        return null
      }
      for (let j = message.content.length - 1; j >= 0; j -= 1) {
        const block = message.content[j]
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text
        }
      }
      return null
    }
    return null
  }
  return {
    recordRequest: jest.fn(),
    extractLatestUserMessageText: jest.fn(extractLatestUserMessageText),
    // 与真实 buildPromptSessionKey 保持一致的构造方式
    buildPromptSessionKey: (apiKeyId, clientSessionId) => {
      if (
        (typeof apiKeyId !== 'string' && typeof apiKeyId !== 'number') ||
        !String(apiKeyId).trim() ||
        typeof clientSessionId !== 'string' ||
        !clientSessionId.trim()
      ) {
        return null
      }
      return crypto
        .createHash('sha256')
        .update(`${String(apiKeyId)}\u0000anthropic\u0000${clientSessionId.trim().toLowerCase()}`)
        .digest('hex')
    }
  }
})

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

  it('P0 端到端：主上下文与 Auto 上下文交错时目的正确、SKILL 状态不串线', () => {
    logger.isPromptLogEnabled.mockReturnValue(true)
    logger.isTelemetryEnabled.mockReturnValue(true)
    // 独立 session，避免与其它用例共享目的分类器的上下文注册表
    const sessionInfo = {
      clientSessionId: '99999999-9999-4999-8999-999999999999',
      source: 'header',
      stickySessionKey: '99999999-9999-4999-8999-999999999999'
    }
    sessionHelper.extractClientSessionId.mockReturnValue(sessionInfo)

    const parentBody = {
      model: 'claude-sonnet-test',
      stream: false,
      system: [{ type: 'text', text: 'parent system prompt' }],
      tools: [{ name: 'Read' }, { name: 'Edit' }],
      messages: [
        { role: 'user', content: 'parent task' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder><command-message>linter</command-message><skill-format>true</skill-format>Body</system-reminder>'
            }
          ]
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'continue the task' }
      ]
    }
    const autoBody = {
      model: 'claude-sonnet-test',
      stream: false,
      system: [{ type: 'text', text: 'classifier system prompt' }],
      messages: [
        { role: 'user', content: 'action under review' },
        { role: 'user', content: '\nErr on the side of blocking. Stage 1 judge.' }
      ]
    }

    const finish = (body, requestId) => {
      const req = buildRequest({ requestId, body })
      const res = new FakeResponse()
      startLlmRequestObservation(req, res)
      res.emit('finish')
    }

    finish(parentBody, 'parent-1')
    finish(autoBody, 'auto-1')
    finish(parentBody, 'parent-2')

    expect(logger.telemetry).toHaveBeenCalledTimes(3)
    const [parent1, auto1, parent2] = logger.telemetry.mock.calls.map((call) => call[0])

    // 目的正确：主上下文 human，Auto 上下文 auto_classifier
    expect(parent1.request_purpose).toBe('human')
    expect(auto1).toMatchObject({
      request_purpose: 'auto_classifier',
      purpose_template_id: 'auto_stage1_block'
    })
    expect(parent2.request_purpose).toBe('human')

    // 上下文隔离：Auto 与主上下文的 agent_context_id 不同，主上下文前后一致
    expect(auto1.agent_context_id).not.toBe(parent1.agent_context_id)
    expect(parent2.agent_context_id).toBe(parent1.agent_context_id)
    expect(parent1.root_session_id).toBe(sessionInfo.clientSessionId)

    // SKILL 增量状态不串线：parent-2 中的 SKILL 是 carried_over 而非 re_injected
    expect(parent2).toMatchObject({
      skill_newly_injected_count: 0,
      skill_reinjected_count: 0
    })
    expect(parent2.skill_names).toContain('linter')
  })

  it('回归：tool_result-only 尾部的工具续跑请求判为 background，不错归因 human', () => {
    logger.isPromptLogEnabled.mockReturnValue(true)
    logger.isTelemetryEnabled.mockReturnValue(true)
    const sessionInfo = {
      clientSessionId: '88888888-8888-4888-8888-888888888888',
      source: 'header',
      stickySessionKey: '88888888-8888-4888-8888-888888888888'
    }
    sessionHelper.extractClientSessionId.mockReturnValue(sessionInfo)

    const req = buildRequest({
      requestId: 'tool-continuation-1',
      body: {
        model: 'claude-sonnet-test',
        stream: false,
        system: 'stable system',
        tools: [{ name: 'Read' }],
        messages: [
          { role: 'user', content: 'fix the test' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }]
          }
        ]
      }
    })
    const res = new FakeResponse()
    startLlmRequestObservation(req, res)
    res.emit('finish')

    // 严格提取器不回溯：latestUserText 为 null，purpose 走结构信号 background
    expect(promptLogger.recordRequest).toHaveBeenCalledWith(
      expect.anything(),
      sessionInfo,
      expect.any(Array),
      expect.objectContaining({
        request_purpose: 'background',
        purpose_source: 'structure',
        latestUserText: null
      })
    )
    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      request_purpose: 'background',
      purpose_source: 'structure'
    })
  })

  it('回归：Prompt Log 与 telemetry 对同一请求携带一致且非空的 agent_context_id', () => {
    logger.isPromptLogEnabled.mockReturnValue(true)
    logger.isTelemetryEnabled.mockReturnValue(true)
    const sessionInfo = {
      clientSessionId: '77777777-7777-4777-8777-777777777777',
      source: 'header',
      stickySessionKey: '77777777-7777-4777-8777-777777777777'
    }
    sessionHelper.extractClientSessionId.mockReturnValue(sessionInfo)

    const req = buildRequest({
      requestId: 'ctx-consistency-1',
      body: {
        model: 'claude-sonnet-test',
        stream: false,
        system: 'stable system',
        tools: [{ name: 'Read' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'human prompt' }] }]
      }
    })
    const res = new FakeResponse()
    startLlmRequestObservation(req, res)
    res.emit('finish')

    const purposeInfo = promptLogger.recordRequest.mock.calls[0][3]
    const telemetryRecord = logger.telemetry.mock.calls[0][0]
    expect(purposeInfo.agent_context_id).toMatch(/^[0-9a-f]{16}$/)
    expect(telemetryRecord.agent_context_id).toBe(purposeInfo.agent_context_id)
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
    expect(promptLogger.recordRequest).toHaveBeenCalledWith(
      req,
      SESSION_INFO,
      [],
      expect.objectContaining({ request_purpose: 'human', latestUserText: 'human prompt' })
    )
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

    expect(promptLogger.recordRequest).toHaveBeenCalledWith(
      req,
      {
        clientSessionId: null,
        source: 'none',
        stickySessionKey: null
      },
      [],
      expect.objectContaining({ request_purpose: 'human' })
    )
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

    observer.observeUpstream({ queueRequestId: 'queue-1' })
    observer.noteRetry('console concurrency full')
    observer.observeError(
      Object.assign(new Error('upstream timeout'), {
        code: 'UPSTREAM_TIMEOUT',
        response: { status: 429 }
      })
    )
    res.statusCode = 504
    res.emit('finish')

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      event_type: 'llm_request_error',
      attempt_count: 2,
      retry_reason: 'console-concurrency-full',
      queue_request_id: 'queue-1',
      status_code: 504,
      upstream_status_code: 429,
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

  it('11. SKILL 分析器失败不影响 Prompt 记录和 telemetry（fail-open）', () => {
    logger.isPromptLogEnabled.mockReturnValue(true)
    logger.isTelemetryEnabled.mockReturnValue(true)
    const skillPromptAnalyzer = require('../src/utils/skillPromptAnalyzer')
    const analyzeSpy = jest.spyOn(skillPromptAnalyzer, 'analyze').mockImplementation(() => {
      throw new Error('analyzer boom')
    })
    const req = buildRequest()
    const res = new FakeResponse()

    try {
      expect(() => startLlmRequestObservation(req, res)).not.toThrow()
      expect(promptLogger.recordRequest).toHaveBeenCalledWith(
        req,
        SESSION_INFO,
        [],
        expect.objectContaining({ request_purpose: 'human' })
      )
      res.emit('finish')

      expect(logger.telemetry).toHaveBeenCalledTimes(1)
      expect(logger.telemetry.mock.calls[0][0].event_type).toBe('llm_request_completed')
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to analyze SKILL prompt injection:',
        'analyzer boom'
      )
    } finally {
      analyzeSpy.mockRestore()
    }
  })

  it('检测到 SKILL 注入时 telemetry 记录包含 skill_* 摘要字段', () => {
    logger.isTelemetryEnabled.mockReturnValue(true)
    const skillText = `<system-reminder>
<command-message>verify</command-message>
<skill-format>true</skill-format>
Verify the build
</system-reminder>`
    const req = buildRequest({
      body: {
        model: 'claude-sonnet-test',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: skillText }] }]
      }
    })
    const res = new FakeResponse()

    startLlmRequestObservation(req, res)
    res.emit('finish')

    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      skill_detected: true,
      skill_detection_confidence: 'exact_marker',
      skill_names: ['verify'],
      skill_count: 1,
      skill_newly_injected_count: 1,
      skill_reinjected_count: 0,
      skill_rehydrated: false
    })
    // telemetry 只含摘要，不含 SKILL 正文明文
    expect(JSON.stringify(record)).not.toContain('Verify the build')
  })
})
