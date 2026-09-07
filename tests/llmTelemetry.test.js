jest.mock('../src/utils/logger', () => ({
  telemetry: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}))

const logger = require('../src/utils/logger')
const {
  SCHEMA_VERSION,
  classifyFailureStage,
  createTelemetryContext,
  detectHarness,
  extractUpstreamErrorFields,
  finalizeTelemetry,
  hashValue,
  normalizeToolNames,
  recordUpstreamTelemetry,
  sanitizeMessageTemplate,
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

  it.each([
    'ZCode/3.6.5 ai-sdk/provider-utils/4.0.27 runtime/node.js/24',
    'ZCode/3.6.5 ai/6.0.193 ai-sdk/provider-utils/4.0.27 runtime/node.js/24'
  ])('从 ZCode User-Agent 识别 harness 与版本: %s', (userAgent) => {
    expect(detectHarness({ 'user-agent': userAgent })).toEqual({
      harness_id: 'zcode',
      harness_version: '3.6.5',
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

  it('按实际上游区域模型回填美元成本并保留请求模型', () => {
    const context = createTelemetryContext(
      buildRequest({ body: { model: 'glm-5.3', stream: false } }),
      buildSessionInfo()
    )

    finalizeTelemetry(context, {
      eventType: 'llm_request_completed',
      model: 'glm-5.3',
      apiUrl: 'https://api.z.ai/api/anthropic',
      usage: { input_tokens: 1000000, output_tokens: 0 }
    })
    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      model: 'glm-5.3',
      requested_model: 'glm-5.3',
      api_url: 'https://api.z.ai/api/anthropic',
      cost: 1.4,
      has_pricing: true,
      pricing_model: 'glm-5.3',
      pricing_region: 'intl',
      provisional_pricing: false
    })
  })

  it('上下文标识与请求目的字段完整透传', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo(), null, {
      agentContext: {
        agentContextId: 'abc123def4567890',
        contextFingerprint: 'sys:aaa|tools:bbb|first:ccc',
        contextKeyId: 'ek-abcd1234'
      },
      purposeInfo: {
        request_purpose: 'subagent',
        purpose_rule_version: 1,
        purpose_source: 'context_role',
        template_id: null,
        agent_context_role: 'secondary',
        agent_context_role_source: 'registry_primary'
      }
    })

    finalizeTelemetry(context, { eventType: 'llm_request_completed' })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      root_session_id: SESSION_ID,
      agent_context_id: 'abc123def4567890',
      context_fingerprint: 'sys:aaa|tools:bbb|first:ccc',
      context_key_id: 'ek-abcd1234',
      parent_gateway_request_id: null,
      request_purpose: 'subagent',
      purpose_rule_version: 1,
      purpose_source: 'context_role',
      purpose_template_id: null,
      agent_context_role: 'secondary',
      agent_context_role_source: 'registry_primary'
    })
  })

  it('未知价格保留 cost=null 而不是 0，且 schema 版本为 2', () => {
    const context = createTelemetryContext(
      buildRequest({ body: { model: 'totally-unknown-model', stream: false } }),
      buildSessionInfo()
    )

    finalizeTelemetry(context, {
      eventType: 'llm_request_completed',
      model: 'totally-unknown-model',
      usage: { input_tokens: 1000, output_tokens: 10 }
    })
    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      schema_version: 2,
      cost: null,
      has_pricing: false
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

  it('三层状态码拆分：client/gateway/upstream 独立字段，旧 status_code 保留', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, {
      eventType: 'llm_request_error',
      statusCode: 429,
      clientStatusCode: 429,
      gatewayStatusCode: 429,
      upstreamStatusCode: 429,
      failureStage: 'account_selection',
      upstreamErrorCode: 'ALL_ACCOUNTS_RATE_LIMITED'
    })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      client_status_code: 429,
      gateway_status_code: 429,
      status_code: 429,
      upstream_status_code: 429,
      failure_stage: 'account_selection'
    })
  })

  it('网关合成错误不冒充上游状态：upstream_status_code 保持 null', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, {
      eventType: 'llm_request_error',
      statusCode: 500,
      gatewayStatusCode: 500,
      failureContext: { errorCode: 'NO_ELIGIBLE_ACCOUNT', errorType: 'Error' }
    })

    const record = logger.telemetry.mock.calls[0][0]
    expect(record).toMatchObject({
      gateway_status_code: 500,
      upstream_status_code: null,
      failure_stage: 'account_selection'
    })
  })

  it('上游错误脱敏字段透传且错误码被清洗', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, {
      eventType: 'llm_request_error',
      statusCode: 429,
      upstreamStatusCode: 429,
      failureStage: 'upstream_http',
      upstreamErrorType: 'rate_limit_error',
      upstreamErrorCode: '1302',
      upstreamMessageTemplate: '您的账户已达到速率限制，请您控制请求频率'
    })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      failure_stage: 'upstream_http',
      upstream_error_type: 'rate_limit_error',
      upstream_error_code: '1302',
      upstream_message_template: '您的账户已达到速率限制，请您控制请求频率'
    })
  })

  it('成功请求不写 failure_stage', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, { eventType: 'llm_request_completed', statusCode: 200 })

    expect(logger.telemetry.mock.calls[0][0].failure_stage).toBeNull()
  })
})

describe('llmTelemetry message template sanitizer', () => {
  it('数字、UUID 与长十六进制串替换为占位符，中文正文保留', () => {
    expect(
      sanitizeMessageTemplate('[1302][您的账户已达到速率限制，请您控制请求频率][req-8f3a2b1c9d]')
    ).toBe('[<n>][您的账户已达到速率限制，请您控制请求频率][req-<id>]')
    expect(
      sanitizeMessageTemplate(
        '[1310][您已达到每周/每月使用上限，您的限额将在 2026-08-05 15:16:26 重置。][foo]'
      )
    ).toBe('[<n>][您已达到每周/每月使用上限，您的限额将在 <n>-<n>-<n> <n>:<n>:<n> 重置。][foo]')
    expect(sanitizeMessageTemplate('error in block 12345678-1234-4123-8123-123456789abc')).toBe(
      'error in block <id>'
    )
  })

  it('控制字符折叠为空格，超长截断，非字符串返回 null', () => {
    expect(sanitizeMessageTemplate('line1\nline2\t\ttab')).toBe('line<n> line<n> tab')
    expect(sanitizeMessageTemplate('x'.repeat(400))).toHaveLength(256)
    expect(sanitizeMessageTemplate(null)).toBeNull()
    expect(sanitizeMessageTemplate('   ')).toBeNull()
  })
})

describe('llmTelemetry upstream error extraction', () => {
  it('提取智谱 1302 的错误码与消息模板', () => {
    expect(
      extractUpstreamErrorFields({
        error: { code: '1302', message: '[1302][您的账户已达到速率限制，请您控制请求频率][r-1]' }
      })
    ).toEqual({
      upstreamErrorCode: '1302',
      upstreamMessageTemplate: '[<n>][您的账户已达到速率限制，请您控制请求频率][r-<n>]'
    })
  })

  it('提取 Anthropic 错误 type/code，兼容字符串与 Buffer 输入', () => {
    expect(
      extractUpstreamErrorFields(
        '{"error":{"type":"rate_limit_error","message":"Number of requests 42"}}'
      )
    ).toEqual({
      upstreamErrorType: 'rate_limit_error',
      upstreamMessageTemplate: 'Number of requests <n>'
    })
    expect(extractUpstreamErrorFields(Buffer.from('{"error":{"code":"429"}}'))).toEqual({
      upstreamErrorCode: '429'
    })
  })

  it('无法解析或不带 error 对象时返回空对象', () => {
    expect(extractUpstreamErrorFields('not json')).toEqual({})
    expect(extractUpstreamErrorFields({ message: 'no error field' })).toEqual({})
    expect(extractUpstreamErrorFields(null)).toEqual({})
  })
})

describe('llmTelemetry failure stage classification', () => {
  it.each([
    [{ errorCode: 'ALL_ACCOUNTS_RATE_LIMITED' }, 'account_selection'],
    [{ errorCode: 'NO_ELIGIBLE_ACCOUNT' }, 'account_selection'],
    [{ errorCode: 'MODEL_NOT_SUPPORTED' }, 'account_selection'],
    [{ errorCode: 'CONSOLE_ACCOUNT_CONCURRENCY_FULL' }, 'account_selection'],
    [{ errorCode: 'queue_timeout' }, 'queue'],
    [{ errorType: 'queue_timeout' }, 'queue'],
    [{ upstreamStatusCode: 429 }, 'upstream_http'],
    [{ upstreamStatusCode: 500 }, 'upstream_http'],
    [{ errorType: 'upstream_stream_error' }, 'upstream_stream'],
    [{ errorType: 'client_disconnected' }, 'client_disconnect'],
    [{ clientDisconnected: true }, 'client_disconnect'],
    [{ errorCode: 'ECONNRESET', errorType: 'Error' }, 'relay']
  ])('classifyFailureStage(%j) => %s', (input, expected) => {
    expect(classifyFailureStage(input)).toBe(expected)
  })
})

describe('upstream telemetry events', () => {
  beforeEach(() => {
    logger.telemetry.mockClear()
    logger.telemetry.mockReturnValue(true)
  })

  it('记录账号 failover 事件且只保留结构化字段', () => {
    expect(
      recordUpstreamTelemetry('account_failover', {
        gatewayRequestId: 'gateway-1',
        sessionHash: 'hash-1',
        accountId: 'account-1',
        accountType: 'claude-official',
        reason: 'rate_limit',
        upstreamStatusCode: 429,
        stickyDeleted: true,
        errorMessage: 'PRIVATE UPSTREAM RESPONSE'
      })
    ).toBe(true)

    expect(logger.telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: SCHEMA_VERSION,
        event_type: 'account_failover',
        gateway_request_id: 'gateway-1',
        session_hash: 'hash-1',
        account_id: 'account-1',
        account_type: 'claude-official',
        reason: 'rate_limit',
        upstream_status_code: 429,
        sticky_deleted: true
      })
    )
    expect(JSON.stringify(logger.telemetry.mock.calls[0][0])).not.toContain(
      'PRIVATE UPSTREAM RESPONSE'
    )
  })

  it('记录 sticky 生命周期事件并拒绝未知事件类型', () => {
    recordUpstreamTelemetry('sticky_session_lifecycle', {
      action: 'set',
      sessionHash: 'hash-1',
      accountId: 'account-1',
      accountType: 'claude-official',
      ttlSeconds: 3600,
      reason: 'first_assign'
    })

    expect(logger.telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'sticky_session_lifecycle',
        action: 'set',
        ttl_seconds: 3600
      })
    )
    expect(recordUpstreamTelemetry('unknown_event', {})).toBe(false)
    expect(
      recordUpstreamTelemetry('account_failover', {
        accountId: 'account-without-join-key',
        reason: 'rate_limit'
      })
    ).toBe(false)
    expect(logger.telemetry).toHaveBeenCalledTimes(1)
  })

  it('account_failover 携带上游错误详情、预期恢复时间与受影响会话数', () => {
    recordUpstreamTelemetry('account_failover', {
      sessionHash: 'hash-1',
      accountId: 'account-1',
      accountType: 'claude-console',
      reason: 'rate_limit',
      upstreamStatusCode: 429,
      upstreamErrorCode: '1302',
      upstreamMessageTemplate: '[<n>][您的账户已达到速率限制，请您控制请求频率][r-<n>]',
      stickyDeleted: true,
      expectedRecoveryAt: '2026-08-20T04:14:15.922Z',
      affectedSessionCount: 4
    })

    expect(logger.telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'account_failover',
        upstream_error_code: '1302',
        upstream_message_template: '[<n>][您的账户已达到速率限制，请您控制请求频率][r-<n>]',
        expected_recovery_at: '2026-08-20T04:14:15.922Z',
        affected_session_count: 4
      })
    )
  })

  it('账号生命周期事件：detected 携带上游详情，suppressed/recovered 允许仅 account_id 关联', () => {
    recordUpstreamTelemetry('account_rate_limit_detected', {
      gatewayRequestId: 'gateway-1',
      sessionHash: 'hash-1',
      accountId: 'account-1',
      accountType: 'claude-console',
      upstreamStatusCode: 429,
      upstreamErrorCode: '1302',
      suppressionId: '1755687600000',
      resetTimestamp: 1755688500
    })
    expect(logger.telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'account_rate_limit_detected',
        upstream_error_code: '1302',
        suppression_id: '1755687600000',
        reset_timestamp: new Date(1755688500 * 1000).toISOString()
      })
    )

    // 定时器/人工恢复没有请求上下文：account_id 单独作为关联键
    expect(
      recordUpstreamTelemetry('account_suppressed', {
        accountId: 'account-1',
        accountType: 'claude-console',
        reason: 'rate_limit',
        configuredDurationSeconds: 3600,
        expectedRecoveryAt: '2026-08-20T04:14:15.922Z',
        suppressionId: '1755687600000',
        affectedSessionCount: 3
      })
    ).toBe(true)
    expect(logger.telemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: 'account_suppressed',
        configured_duration_seconds: 3600,
        affected_session_count: 3
      })
    )

    expect(
      recordUpstreamTelemetry('account_recovered', {
        accountId: 'account-1',
        accountType: 'claude-console',
        recoverySource: 'successful_inflight_response',
        expectedRecoveryAt: '2026-08-20T04:14:15.922Z',
        actualRecoveryAt: '2026-08-20T03:14:19.922Z',
        actualSuppressionSeconds: 4,
        suppressionId: '1755687600000'
      })
    ).toBe(true)
    expect(logger.telemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: 'account_recovered',
        recovery_source: 'successful_inflight_response',
        actual_suppression_seconds: 4
      })
    )
  })

  it('upstream_attempt 必须挂在 gateway 请求下并按 usage 计算成本', () => {
    expect(recordUpstreamTelemetry('upstream_attempt', { accountId: 'account-1' })).toBe(false)

    recordUpstreamTelemetry('upstream_attempt', {
      gatewayRequestId: 'gateway-1',
      attemptNumber: 2,
      accountId: 'account-1',
      accountType: 'claude-console',
      model: 'glm-5.3',
      apiUrl: 'https://api.z.ai/api/anthropic',
      queueRequestId: 'queue-1',
      queueWaitMs: 120,
      upstreamLatencyMs: 450,
      upstreamStatusCode: 200,
      success: true,
      upstreamRequestId: 'req-1',
      usage: { input_tokens: 1000000, output_tokens: 0 }
    })

    expect(logger.telemetry).toHaveBeenCalledTimes(1)
    expect(logger.telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'upstream_attempt',
        gateway_request_id: 'gateway-1',
        attempt_number: 2,
        attempt_id: 'gateway-1#a2',
        account_id: 'account-1',
        queue_request_id: 'queue-1',
        queue_wait_ms: 120,
        upstream_latency_ms: 450,
        upstream_status_code: 200,
        success: true,
        input_tokens: 1000000,
        usage_available: true,
        cost: 1.4,
        has_pricing: true
      })
    )
  })
})

describe('llmTelemetry skill summary fields', () => {
  beforeEach(() => {
    logger.telemetry.mockClear()
  })

  it('skillSummary 展开为 telemetry 记录的 skill_* 摘要字段', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo(), {
      skill_detected: true,
      skill_catalog_detected: true,
      skill_catalog_names: 14,
      skill_detection_confidence: 'exact_marker',
      skill_detection_rule_version: 2,
      skill_detection_types: ['invoked_skills'],
      skill_names: ['verify'],
      skill_count: 1,
      skill_injection_count: 2,
      skill_chars: 18420,
      skill_newly_injected_count: 1,
      skill_reinjected_count: 0,
      skill_rehydrated: false,
      command_invocation_count: 1,
      command_invocation_names: ['clear'],
      system_reminder_detected: true,
      system_reminder_count: 3,
      system_reminder_detection_types: ['generic_system_reminder'],
      system_reminder_chars: 900,
      system_reminder_newly_injected_count: 2,
      system_reminder_reinjected_count: 1,
      tool_result_context_chars: 1200,
      tool_result_chars_current: 34567,
      system_prompt_chars: 8901,
      skill_context_chars_current: 18420,
      skill_context_chars_added: 9000,
      skill_context_chars_carried: 8000,
      skill_context_chars_rehydrated: 1420,
      active_skill_content_hashes: ['a'.repeat(64)],
      analysis_duration_ms: 2,
      analysis_scanned_chars: 2048,
      analysis_truncated: false
    })

    finalizeTelemetry(context, { eventType: 'llm_request_completed' })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      skill_detected: true,
      skill_catalog_detected: true,
      skill_catalog_names: 14,
      skill_detection_confidence: 'exact_marker',
      skill_detection_rule_version: 2,
      skill_detection_types: ['invoked_skills'],
      skill_names: ['verify'],
      skill_count: 1,
      skill_injection_count: 2,
      skill_chars: 18420,
      skill_newly_injected_count: 1,
      skill_reinjected_count: 0,
      skill_rehydrated: false,
      command_invocation_count: 1,
      command_invocation_names: ['clear'],
      system_reminder_detected: true,
      system_reminder_count: 3,
      system_reminder_detection_types: ['generic_system_reminder'],
      system_reminder_chars: 900,
      system_reminder_newly_injected_count: 2,
      system_reminder_reinjected_count: 1,
      tool_result_context_chars: 1200,
      tool_result_chars_current: 34567,
      system_prompt_chars: 8901,
      skill_context_chars_current: 18420,
      skill_context_chars_added: 9000,
      skill_context_chars_carried: 8000,
      skill_context_chars_rehydrated: 1420,
      active_skill_content_hashes: ['a'.repeat(64)],
      skill_analysis_duration_ms: 2,
      skill_analysis_scanned_chars: 2048,
      skill_analysis_truncated: false
    })
  })

  it('v4 语义：目录-only 摘要输出 skill_detected=false 与独立目录/命令字段', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo(), {
      skill_detected: false,
      skill_catalog_detected: true,
      skill_catalog_names: 14,
      command_invocation_count: 2,
      command_invocation_names: ['clear', 'model']
    })

    finalizeTelemetry(context, { eventType: 'llm_request_completed' })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      skill_detected: false,
      skill_catalog_detected: true,
      skill_catalog_names: 14,
      command_invocation_count: 2,
      command_invocation_names: ['clear', 'model']
    })
  })

  it('无 skillSummary 时 telemetry 记录不含 skill_* 字段', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo())

    finalizeTelemetry(context, { eventType: 'llm_request_completed' })

    const record = logger.telemetry.mock.calls[0][0]
    expect(Object.keys(record).filter((key) => key.startsWith('skill_'))).toHaveLength(0)
  })

  it('skillSummary 字段缺失或类型错误时回退到安全默认值', () => {
    const context = createTelemetryContext(buildRequest(), buildSessionInfo(), {
      skill_detected: true
    })

    finalizeTelemetry(context, { eventType: 'llm_request_completed' })

    expect(logger.telemetry.mock.calls[0][0]).toMatchObject({
      skill_detected: true,
      skill_detection_confidence: null,
      skill_detection_types: [],
      skill_names: [],
      skill_count: 0,
      skill_chars: 0,
      skill_newly_injected_count: 0,
      skill_reinjected_count: 0,
      skill_rehydrated: false
    })
  })
})
