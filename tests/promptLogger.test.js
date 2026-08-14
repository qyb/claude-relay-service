jest.mock('../src/utils/logger', () => ({
  promptLog: jest.fn(),
  error: jest.fn()
}))

const {
  PromptLogger,
  buildPromptSessionKey,
  extractLatestUserPrompt,
  hashPrompt,
  isHumanPrompt
} = require('../src/utils/promptLogger')

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

function buildRequest(messages, overrides = {}) {
  return {
    requestId: overrides.requestId || 'gateway-request-1',
    originalUrl: '/v1/messages?beta=true',
    apiKey: {
      id: overrides.apiKeyId || 'key-record-1',
      name: overrides.apiKeyName || 'employee-key'
    },
    body: {
      model: 'claude-sonnet-test',
      stream: true,
      messages
    }
  }
}

function sessionInfo(clientSessionId = SESSION_A) {
  return {
    clientSessionId,
    source: 'header',
    stickySessionKey: clientSessionId
  }
}

function userText(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function toolResult(id = 'tool-1') {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: 'PRIVATE TOOL RESULT' }]
      }
    ]
  }
}

describe('Prompt extraction', () => {
  it('只取最后一条 user 消息的最后一个非空普通文本块', () => {
    expect(
      extractLatestUserPrompt({
        messages: [
          userText('first prompt'),
          {
            role: 'user',
            content: [
              { type: 'text', text: 'context' },
              { type: 'image', source: { type: 'base64', data: 'private' } },
              { type: 'text', text: 'latest prompt' }
            ]
          }
        ]
      })
    ).toBe('latest prompt')
  })

  it('tool-result-only user 消息回退到更早的人工文本', () => {
    expect(
      extractLatestUserPrompt({
        messages: [
          userText('human prompt'),
          { role: 'assistant', content: 'working' },
          toolResult()
        ]
      })
    ).toBe('human prompt')
  })

  it('混合 tool_result 和 text 时只提取普通 text', () => {
    expect(
      extractLatestUserPrompt({
        messages: [
          userText('old prompt'),
          {
            role: 'user',
            content: [toolResult().content[0], { type: 'text', text: 'new human prompt' }]
          }
        ]
      })
    ).toBe('new human prompt')
  })

  it('支持字符串 content，并忽略空文本和其他角色', () => {
    expect(
      extractLatestUserPrompt({
        messages: [
          { role: 'user', content: 'string prompt' },
          { role: 'assistant', content: 'assistant response' },
          { role: 'user', content: [{ type: 'text', text: '   ' }] }
        ]
      })
    ).toBe('string prompt')
  })

  it('没有普通用户文本时返回 null', () => {
    expect(extractLatestUserPrompt({ messages: [toolResult()] })).toBeNull()
  })

  it('8. 最后一条 user 消息是 SKILL/system-reminder 注入时回退到更早的人工文本', () => {
    const skillText = `<system-reminder>
<command-message>linter</command-message>
<skill-format>true</skill-format>
Run eslint on modified files
</system-reminder>`
    const reminderText =
      '<system-reminder>The following skills are available for use with the Skill tool:\n- linter: lint</system-reminder>'

    expect(
      extractLatestUserPrompt({
        messages: [userText('human prompt'), userText(skillText)]
      })
    ).toBe('human prompt')
    expect(
      extractLatestUserPrompt({
        messages: [userText('human prompt'), userText(reminderText)]
      })
    ).toBe('human prompt')
    // 全部 user 消息都是机器注入时不记录任何明文
    expect(extractLatestUserPrompt({ messages: [userText(skillText)] })).toBeNull()
  })
})

describe('Prompt hashes', () => {
  it('Prompt hash 忽略首尾空白和 NUL，但不修改内部内容', () => {
    expect(hashPrompt('  hello\u0000\nworld  ')).toBe(hashPrompt('hello\nworld'))
    expect(hashPrompt('hello\nworld')).not.toBe(hashPrompt('hello world'))
  })

  it('session key 同时隔离 API Key 和 session', () => {
    expect(buildPromptSessionKey('key-1', SESSION_A)).toBe(
      buildPromptSessionKey('key-1', SESSION_A.toUpperCase())
    )
    expect(buildPromptSessionKey('key-1', SESSION_A)).not.toBe(
      buildPromptSessionKey('key-2', SESSION_A)
    )
    expect(buildPromptSessionKey('key-1', SESSION_A)).not.toBe(
      buildPromptSessionKey('key-1', SESSION_B)
    )
  })
})

describe('PromptLogger LRU retention', () => {
  it('四次相同 session 的 agent 请求只写一条', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord })
    const humanMessage = userText('only human prompt')
    const requests = [
      buildRequest([humanMessage], { requestId: 'request-1' }),
      buildRequest(
        [
          humanMessage,
          { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
          toolResult('tool-1')
        ],
        { requestId: 'request-2' }
      ),
      buildRequest(
        [
          humanMessage,
          { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
          toolResult('tool-1'),
          { role: 'assistant', content: 'continuing' }
        ],
        { requestId: 'request-3' }
      ),
      buildRequest(
        [
          humanMessage,
          { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
          toolResult('tool-1'),
          { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] },
          toolResult('tool-2')
        ],
        { requestId: 'request-4' }
      )
    ]

    const results = requests.map((request) => promptLogger.recordRequest(request, sessionInfo()))

    expect(results[0]).toMatchObject({ logged: true, duplicate: false })
    expect(results.slice(1).every((result) => result.duplicate)).toBe(true)
    expect(writeRecord).toHaveBeenCalledTimes(1)
    expect(writeRecord.mock.calls[0][0].prompt).toBe('only human prompt')
  })

  it('不同 session 的相同 Prompt 分别写入', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord })
    const request = buildRequest([userText('same prompt')])

    promptLogger.recordRequest(request, sessionInfo(SESSION_A))
    promptLogger.recordRequest(request, sessionInfo(SESSION_B))

    expect(writeRecord).toHaveBeenCalledTimes(2)
  })

  it('同一 session 的 A、B、A 分别写入', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord })

    promptLogger.recordRequest(buildRequest([userText('A')]), sessionInfo())
    promptLogger.recordRequest(buildRequest([userText('B')]), sessionInfo())
    promptLogger.recordRequest(buildRequest([userText('A')]), sessionInfo())

    expect(writeRecord).toHaveBeenCalledTimes(3)
  })

  it('没有可靠 session 时不做跨请求去重', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord })
    const request = buildRequest([userText('same prompt')])
    const fallbackOnly = {
      clientSessionId: null,
      source: 'none',
      stickySessionKey: 'content-hash-is-not-a-real-session'
    }

    promptLogger.recordRequest(request, fallbackOnly)
    promptLogger.recordRequest(request, fallbackOnly)

    expect(writeRecord).toHaveBeenCalledTimes(2)
  })

  it('相同 Prompt 的访问会刷新 session 空闲 TTL', () => {
    const nowSpy = jest.spyOn(Date, 'now')
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord, cacheTtlMs: 100 })
    const request = buildRequest([userText('active prompt')])

    try {
      nowSpy.mockReturnValue(1000)
      promptLogger.recordRequest(request, sessionInfo())

      nowSpy.mockReturnValue(1050)
      promptLogger.recordRequest(request, sessionInfo())

      nowSpy.mockReturnValue(1120)
      promptLogger.recordRequest(request, sessionInfo())

      nowSpy.mockReturnValue(1221)
      promptLogger.recordRequest(request, sessionInfo())
    } finally {
      nowSpy.mockRestore()
    }

    expect(writeRecord).toHaveBeenCalledTimes(2)
  })

  it('logger 拒绝记录时不更新 LRU', () => {
    const writeRecord = jest.fn(() => false)
    const promptLogger = new PromptLogger({ writeRecord })
    const request = buildRequest([userText('retry me')])

    expect(promptLogger.recordRequest(request, sessionInfo()).reason).toBe('logger_unavailable')
    expect(promptLogger.recordRequest(request, sessionInfo()).reason).toBe('logger_unavailable')
    expect(writeRecord).toHaveBeenCalledTimes(2)
  })

  it('Prompt 在写盘前脱敏，但保留原始长度和审计字段', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord, maskingHmacKey: 'test-mask-key' })
    const rawPrompt = '  password=secret\n第二行  '

    promptLogger.recordRequest(buildRequest([userText(rawPrompt)]), sessionInfo())

    const record = writeRecord.mock.calls[0][0]
    expect(record.prompt).toMatch(/^  password=\[MASKED:password:[0-9a-f]{8}\]\n第二行  $/)
    expect(record.prompt).not.toContain('password=secret')
    expect(record.prompt_length).toBe(rawPrompt.length)
    expect(record).toMatchObject({
      mask_version: '2026.08.14',
      mask_count: 1
    })
    expect(record).toMatchObject({
      event_type: 'user_prompt_observed',
      api_key_record_id: 'key-record-1',
      client_session_id: SESSION_A,
      model: 'claude-sonnet-test'
    })
  })

  it('8. SKILL 明文只进入 skill_prompt_observed，不污染 user_prompt_observed', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord })
    const skillText = `<system-reminder>
<command-message>linter</command-message>
<skill-format>true</skill-format>
Run eslint on modified files
</system-reminder>`
    const request = buildRequest([userText('human prompt'), userText(skillText)])
    const skillRecords = [
      {
        skill_name: 'linter',
        skill_path: null,
        skill_detection_confidence: 'exact_marker',
        skill_detection_rule_version: 1,
        skill_injection_kind: 'newly_injected',
        skill_rehydrated: false,
        skill_chars: 28,
        prompt: 'Run eslint on modified files'
      }
    ]

    promptLogger.recordRequest(request, sessionInfo(), skillRecords)

    const recordsByType = {}
    for (const call of writeRecord.mock.calls) {
      recordsByType[call[0].event_type] = call[0]
    }

    expect(Object.keys(recordsByType).sort()).toEqual([
      'skill_prompt_observed',
      'user_prompt_observed'
    ])
    // 员工输入与 SKILL 明文各归各的记录类型
    expect(recordsByType.user_prompt_observed.prompt).toBe('human prompt')
    expect(recordsByType.skill_prompt_observed.prompt).toBe('Run eslint on modified files')
    expect(recordsByType.skill_prompt_observed).toMatchObject({
      prompt_source: 'skill_injection',
      skill_name: 'linter',
      skill_injection_kind: 'newly_injected',
      schema_version: 2
    })
    expect(JSON.stringify(recordsByType.skill_prompt_observed)).not.toContain('human prompt')
    expect(JSON.stringify(recordsByType.user_prompt_observed)).not.toContain('Run eslint')
  })

  it('isHumanPrompt 识别常见机器注入标记', () => {
    expect(isHumanPrompt('please help me refactor')).toBe(true)
    expect(isHumanPrompt('<command-args>/tmp</command-args>')).toBe(false)
    expect(isHumanPrompt('<command-contents>body</command-contents>')).toBe(false)
    expect(isHumanPrompt('<local-command-stdout>output</local-command-stdout>')).toBe(false)
    expect(isHumanPrompt('The following skills were invoked in this session:\n### Skill: x')).toBe(
      false
    )
  })

  it('保留 system_reminder 的 prompt_source', () => {
    const writeRecord = jest.fn(() => true)
    const promptLogger = new PromptLogger({ writeRecord })

    promptLogger.recordRequest(buildRequest([userText('human prompt')]), sessionInfo(), [
      {
        prompt_source: 'system_reminder',
        skill_name: null,
        skill_path: null,
        skill_detection_confidence: 'heuristic',
        skill_detection_rule_version: 1,
        skill_injection_kind: 'newly_injected',
        skill_rehydrated: false,
        skill_chars: 20,
        prompt: 'Runtime guidance'
      }
    ])

    expect(writeRecord.mock.calls[0][0]).toMatchObject({
      event_type: 'skill_prompt_observed',
      prompt_source: 'system_reminder'
    })
  })
})
