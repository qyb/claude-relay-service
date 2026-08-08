jest.mock('../src/utils/logger', () => ({
  telemetry: jest.fn()
}))

const logger = require('../src/utils/logger')
const {
  SCHEMA_VERSION,
  createTelemetryContext,
  detectHarness,
  finalizeTelemetry,
  hashValue,
  normalizeToolNames,
  summarizeRequestForTelemetry,
  summarizeResponseForTelemetry
} = require('../src/utils/llmTelemetry')

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

function buildRequest(overrides = {}) {
  return {
    requestId: 'gateway-request-1',
    originalUrl: '/v1/messages?beta=true',
    headers: {
      'user-agent': 'claude-cli/2.1.3 (external, cli)'
    },
    apiKey: {
      id: 'key-record-1',
      name: 'employee-key'
    },
    body: {
      model: 'claude-sonnet-test',
      stream: true,
      messages: [],
      ...overrides.body
    },
    ...overrides
  }
}

function buildSessionInfo() {
  return {
    clientSessionId: SESSION_ID,
    source: 'header',
    stickySessionKey: SESSION_ID
  }
}

describe('llmTelemetry summaries', () => {
  beforeEach(() => {
    logger.telemetry.mockClear()
  })

  it('稳定 hash 不受对象 key 顺序影响', () => {
    expect(hashValue({ a: 1, b: { c: 2, d: 3 } })).toBe(hashValue({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('从 Claude Code User-Agent 识别 harness 与版本', () => {
    expect(detectHarness({ 'user-agent': 'claude-cli/2.1.3 (external, cli)' })).toEqual({
      harness_id: 'claude-code',
      harness_version: '2.1.3',
      harness_source: 'user_agent'
    })
  })

  it('显式 harness header 优先于 User-Agent', () => {
    expect(
      detectHarness({
        'x-crs-harness': 'Internal Harness',
        'x-crs-harness-version': 'release 7',
        'user-agent': 'claude-cli/2.1.3 (external, cli)'
      })
    ).toEqual({
      harness_id: 'internal-harness',
      harness_version: 'release-7',
      harness_source: 'explicit_header'
    })
  })

  it('tool 名称去重、排序并清理不安全字符', () => {
    expect(normalizeToolNames(['Bash', 'Read File', 'Bash', null, 'Edit'])).toEqual([
      'Bash',
      'Edit',
      'Read-File'
    ])
  })

  it('请求摘要不包含 prompt、tool schema、参数或结果正文', () => {
    const requestBody = {
      system: 'PRIVATE SYSTEM PROMPT',
      tools: [
        {
          name: 'Read',
          description: 'PRIVATE TOOL DESCRIPTION',
          input_schema: { secret_property: { type: 'string' } }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'PRIVATE TOOL RESULT',
              is_error: true
            }
          ]
        }
      ]
    }

    const summary = summarizeRequestForTelemetry(requestBody, {
      'user-agent': 'claude-cli/2.1.3 (external, cli)'
    })
    const serialized = JSON.stringify(summary)

    expect(summary).toMatchObject({
      message_count: 1,
      tools_offered_count: 1,
      tool_names: ['Read'],
      tool_result_count: 1,
      tool_result_error_count: 1
    })
    expect(summary.system_prompt_hash).toHaveLength(64)
    expect(summary.tool_schema_hash).toHaveLength(64)
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain('secret_property')
    expect(serialized).not.toContain('tool-1')
  })

  it('响应摘要记录 stop reason 与并行 tool use', () => {
    expect(
      summarizeResponseForTelemetry({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', name: 'Read', input: { private: true } },
          { type: 'tool_use', name: 'Edit', input: { private: true } }
        ]
      })
    ).toEqual({
      stop_reason: 'tool_use',
      tool_use_count: 2,
      tool_use_names: ['Edit', 'Read'],
      parallel_tool_use_detected: true
    })
  })

  it('尚未收到响应时 tool use 字段保持未知', () => {
    expect(summarizeResponseForTelemetry()).toEqual({
      stop_reason: null,
      tool_use_count: null,
      tool_use_names: [],
      parallel_tool_use_detected: null
    })
  })
})

describe('llmTelemetry finalization', () => {
  beforeEach(() => {
    logger.telemetry.mockClear()
  })

  it('每个 context 只接受一个终态', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    expect(
      finalizeTelemetry(context, {
        eventType: 'llm_request_completed',
        statusCode: 200,
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    ).toBe(true)
    expect(
      finalizeTelemetry(context, {
        eventType: 'llm_request_error',
        errorType: 'late_error'
      })
    ).toBe(false)
    expect(logger.telemetry).toHaveBeenCalledTimes(1)
  })

  it('成功但没有 usage 仍记录 completed', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    expect(
      finalizeTelemetry(context, {
        eventType: 'llm_request_completed',
        statusCode: 200,
        responseCompleted: true
      })
    ).toBe(true)

    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      schema_version: SCHEMA_VERSION,
      event_type: 'llm_request_completed',
      gateway_request_id: 'gateway-request-1',
      client_session_id: SESSION_ID,
      response_completed: true,
      usage_available: false,
      total_tokens: null
    })
  })

  it('空 usage 对象不视为可用 usage', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, {
      eventType: 'llm_request_completed',
      usage: {}
    })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      usage_available: false,
      total_tokens: null
    })
  })

  it('错误记录只保留标准化类别和代码，不保存原始错误消息', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, {
      eventType: 'llm_request_error',
      statusCode: 502,
      upstreamStatusCode: 429,
      errorType: 'upstream rate limit',
      errorCode: '1308',
      errorMessage: 'PRIVATE UPSTREAM RESPONSE'
    })

    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      event_type: 'llm_request_error',
      response_completed: false,
      status_code: 502,
      upstream_status_code: 429,
      error_type: 'upstream-rate-limit',
      error_code: '1308'
    })
    expect(JSON.stringify(record)).not.toContain('PRIVATE UPSTREAM RESPONSE')
  })

  it('汇总四类 token 并接受 response tool summary', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, {
      eventType: 'llm_request_completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
        cache_creation: {
          ephemeral_5m_input_tokens: 2,
          ephemeral_1h_input_tokens: 1
        }
      },
      responseSummary: {
        stop_reason: 'tool_use',
        tool_use_count: 2,
        tool_use_names: ['Read', 'Edit']
      }
    })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_ephemeral_5m_input_tokens: 2,
      cache_creation_ephemeral_1h_input_tokens: 1,
      total_tokens: 25,
      usage_available: true,
      stop_reason: 'tool_use',
      tool_use_count: 2,
      parallel_tool_use_detected: true
    })
  })

  it('缺少 gateway request ID 时拒绝终态', () => {
    const request = buildRequest()
    delete request.requestId
    const context = createTelemetryContext(request, buildSessionInfo())

    expect(finalizeTelemetry(context, { eventType: 'llm_request_completed' })).toBe(false)
    expect(logger.telemetry).not.toHaveBeenCalled()
  })

  it('拒绝未知终态类型', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    expect(finalizeTelemetry(context, { eventType: 'completed' })).toBe(false)
    expect(context.finalized).toBe(false)
    expect(logger.telemetry).not.toHaveBeenCalled()
  })
})
