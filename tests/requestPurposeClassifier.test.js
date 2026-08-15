const {
  RequestPurposeClassifier,
  PURPOSE_TYPES,
  PURPOSE_SOURCES,
  matchTemplateFingerprint
} = require('../src/utils/requestPurposeClassifier')

function makeClassifier() {
  return new RequestPurposeClassifier({ cacheSize: 16 })
}

const SESSION = 'session-purpose-test'

describe('requestPurposeClassifier', () => {
  it('枚举完整且模板指纹可独立匹配', () => {
    expect(PURPOSE_TYPES).toEqual([
      'human',
      'auto_classifier',
      'recap',
      'suggestion',
      'skill_execution',
      'subagent',
      'background',
      'unknown'
    ])
    expect(PURPOSE_SOURCES).toEqual([
      'header',
      'template',
      'skill_marker',
      'context_role',
      'human_text',
      'skill_instance',
      'structure'
    ])
    expect(matchTemplateFingerprint('\nErr on the side of blocking. Stage 1 ...').id).toBe(
      'auto_stage1_block'
    )
    expect(matchTemplateFingerprint('The user stepped away and is coming back.').id).toBe(
      'recap_stepped_away'
    )
    expect(matchTemplateFingerprint('[SUGGESTION MODE: x]').id).toBe('suggestion_mode')
    expect(matchTemplateFingerprint('[TODO] fix login timeout')).toBeNull()
  })

  it('普通员工输入默认 human，[TODO] 等前缀不误杀', () => {
    const classifier = makeClassifier()
    const result = classifier.classify({
      latestUserText: '[TODO] fix login timeout',
      messageCount: 5,
      rootSessionId: SESSION,
      agentContextId: 'ctx-primary-000001'
    })
    expect(result.request_purpose).toBe('human')
    expect(result.agent_context_role).toBe('primary')
  })

  it('客户端 header 优先于一切文本与结构信号', () => {
    const classifier = makeClassifier()
    const result = classifier.classify({
      headers: { 'x-crs-request-purpose': 'background' },
      latestUserText: '正常员工文本',
      messageCount: 1,
      rootSessionId: SESSION
    })
    expect(result.request_purpose).toBe('background')
  })

  it('header 枚举外的值被忽略', () => {
    const classifier = makeClassifier()
    const result = classifier.classify({
      headers: { 'x-crs-request-purpose': 'definitely-not-a-purpose' },
      latestUserText: '正常员工文本',
      messageCount: 1,
      rootSessionId: SESSION
    })
    expect(result.request_purpose).toBe('human')
  })

  it('Auto 分类器与 recap 模板命中各自目的', () => {
    const classifier = makeClassifier()
    expect(
      classifier.classify({
        latestUserText: '\nErr on the side of blocking. Stage 1 ...',
        toolsOfferedCount: 0,
        messageCount: 2,
        rootSessionId: SESSION
      })
    ).toMatchObject({ request_purpose: 'auto_classifier', template_id: 'auto_stage1_block' })

    expect(
      classifier.classify({
        latestUserText: 'The user stepped away and is coming back. Recap in under 40 words.',
        messageCount: 351,
        rootSessionId: SESSION
      })
    ).toMatchObject({ request_purpose: 'recap', template_id: 'recap_stepped_away' })
  })

  it('SKILL 标记判为 skill_execution', () => {
    const classifier = makeClassifier()
    const result = classifier.classify({
      latestUserText:
        '<system-reminder><command-message>linter</command-message><skill-format>true</skill-format>body</system-reminder>',
      messageCount: 4,
      rootSessionId: SESSION
    })
    expect(result.request_purpose).toBe('skill_execution')
  })

  it('同一根 session 的非主上下文判为 subagent（不依赖正文）', () => {
    const classifier = makeClassifier()

    // 主上下文先出现并累计更多请求
    for (let i = 0; i < 3; i += 1) {
      classifier.classify({
        latestUserText: 'parent working',
        messageCount: 10 + i,
        rootSessionId: SESSION,
        agentContextId: 'ctx-parent-000001'
      })
    }

    const subagent = classifier.classify({
      latestUserText: 'subagent task from parent delegation',
      messageCount: 1,
      rootSessionId: SESSION,
      agentContextId: 'ctx-child-000002'
    })
    expect(subagent.request_purpose).toBe('subagent')
    expect(subagent.agent_context_role).toBe('secondary')

    // 父上下文继续请求仍是 primary + human
    const parent = classifier.classify({
      latestUserText: 'parent continues',
      messageCount: 13,
      rootSessionId: SESSION,
      agentContextId: 'ctx-parent-000001'
    })
    expect(parent.request_purpose).toBe('human')
    expect(parent.agent_context_role).toBe('primary')
  })

  it('无新人工文本且存在历史消息判为 background，首请求判为 unknown', () => {
    const classifier = makeClassifier()

    expect(
      classifier.classify({
        latestUserText: '<system-reminder>Generic environment note</system-reminder>',
        messageCount: 8,
        rootSessionId: SESSION
      }).request_purpose
    ).toBe('background')

    expect(
      classifier.classify({
        latestUserText: null,
        messageCount: 0,
        rootSessionId: SESSION
      }).request_purpose
    ).toBe('unknown')
  })

  it('上下文注册表按 root session 隔离', () => {
    const classifier = makeClassifier()
    classifier.classify({
      latestUserText: 'session A primary',
      rootSessionId: 'session-a',
      agentContextId: 'ctx-a-0001'
    })

    // session B 的首个上下文在自己的 session 内是 primary
    const result = classifier.classify({
      latestUserText: 'session B first context',
      rootSessionId: 'session-b',
      agentContextId: 'ctx-a-0001'
    })
    expect(result.agent_context_role).toBe('primary')
    expect(result.request_purpose).toBe('human')
  })

  it('回归：Auto 请求先于主上下文到达时不吞掉 primary 选举', () => {
    const classifier = makeClassifier()

    // Auto stage-1 先到：模板命中，不参与选举，角色未定
    const auto = classifier.classify({
      latestUserText: '\nErr on the side of blocking. Stage 1 judge.',
      messageCount: 2,
      rootSessionId: SESSION,
      agentContextId: 'ctx-auto-000003'
    })
    expect(auto).toMatchObject({
      request_purpose: 'auto_classifier',
      purpose_source: 'template',
      prompt_source: 'auto_classifier',
      agent_context_role: null
    })

    // 真正的人工主上下文随后到达：仍能当选 primary，purpose 为 human；
    // 自我当选是低置信度信号（可能是并发/乱序先到的子代理）
    const main = classifier.classify({
      latestUserText: '员工的真实主上下文输入',
      messageCount: 1,
      rootSessionId: SESSION,
      agentContextId: 'ctx-main-000001'
    })
    expect(main).toMatchObject({
      request_purpose: 'human',
      purpose_source: 'human_text',
      agent_context_role: 'primary',
      agent_context_role_source: 'elected_primary'
    })

    // Auto 再来是 secondary，主上下文不翻转；命中已固定注册表
    const autoAgain = classifier.classify({
      latestUserText: '\nErr on the side of blocking. Stage 1 judge again.',
      messageCount: 4,
      rootSessionId: SESSION,
      agentContextId: 'ctx-auto-000003'
    })
    expect(autoAgain.agent_context_role).toBe('secondary')
    expect(autoAgain.agent_context_role_source).toBe('registry_primary')
  })

  it('回归：子代理调用次数超过父代理时 primary 不翻转', () => {
    const classifier = makeClassifier()

    const parentFirst = classifier.classify({
      latestUserText: 'parent task',
      messageCount: 1,
      rootSessionId: SESSION,
      agentContextId: 'ctx-parent-000001'
    })
    expect(parentFirst.agent_context_role).toBe('primary')

    // 子代理高频请求（次数远超父代理）
    for (let i = 0; i < 5; i += 1) {
      classifier.classify({
        latestUserText: `child continuation ${i}`,
        messageCount: 10 + i,
        rootSessionId: SESSION,
        agentContextId: 'ctx-child-000002'
      })
    }

    const parentAfter = classifier.classify({
      latestUserText: 'parent continues',
      messageCount: 13,
      rootSessionId: SESSION,
      agentContextId: 'ctx-parent-000001'
    })
    expect(parentAfter).toMatchObject({
      request_purpose: 'human',
      agent_context_role: 'primary'
    })

    const childAfter = classifier.classify({
      latestUserText: 'child still secondary',
      messageCount: 20,
      rootSessionId: SESSION,
      agentContextId: 'ctx-child-000002'
    })
    expect(childAfter).toMatchObject({
      request_purpose: 'subagent',
      purpose_source: 'context_role',
      agent_context_role: 'secondary'
    })
  })

  it('回归：tool_result-only 尾部（latestUserText=null）不判为 human', () => {
    const classifier = makeClassifier()

    // 工具续跑：最后一条 user 消息只有 tool_result，严格提取器返回 null
    const toolContinuation = classifier.classify({
      latestUserText: null,
      messageCount: 3,
      rootSessionId: SESSION,
      agentContextId: 'ctx-main-000001'
    })
    expect(toolContinuation).toMatchObject({
      request_purpose: 'background',
      purpose_source: 'structure'
    })

    // tool_result 之后跟随 system-reminder 文本块：内容结构是 system，非 human
    const reminderTail = classifier.classify({
      latestUserText: '<system-reminder>Runtime guidance</system-reminder>',
      messageCount: 3,
      rootSessionId: SESSION,
      agentContextId: 'ctx-main-000001'
    })
    expect(reminderTail).toMatchObject({
      request_purpose: 'background',
      purpose_source: 'structure',
      prompt_source: 'system'
    })

    // 真正的新人工输入仍是 human
    const humanFollowUp = classifier.classify({
      latestUserText: '这是新的员工输入',
      messageCount: 4,
      rootSessionId: SESSION,
      agentContextId: 'ctx-main-000001'
    })
    expect(humanFollowUp).toMatchObject({
      request_purpose: 'human',
      purpose_source: 'human_text'
    })
  })

  it('回归：注册表按 API Key 隔离，相同 session id 不互相影响', () => {
    const classifier = makeClassifier()
    classifier.classify({
      latestUserText: 'key-1 的主上下文',
      apiKeyId: 'key-1',
      rootSessionId: 'shared-session',
      agentContextId: 'ctx-shared-0001'
    })

    // 不同 API Key 复用同一 session id：自己的注册表内仍是首次选举
    const result = classifier.classify({
      latestUserText: 'key-2 的主上下文',
      apiKeyId: 'key-2',
      rootSessionId: 'shared-session',
      agentContextId: 'ctx-shared-0001'
    })
    expect(result.agent_context_role).toBe('primary')
    expect(result.request_purpose).toBe('human')
  })

  it('回归：模板命中的 prompt_source 与 request_purpose 口径一致', () => {
    const classifier = makeClassifier()
    const result = classifier.classify({
      latestUserText: 'The user stepped away and is coming back. Recap in under 40 words.',
      messageCount: 351,
      rootSessionId: SESSION
    })
    expect(result).toMatchObject({
      request_purpose: 'recap',
      prompt_source: 'recap'
    })
  })
})
