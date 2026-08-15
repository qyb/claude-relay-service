jest.mock('../src/utils/logger', () => ({
  promptLog: jest.fn(),
  error: jest.fn()
}))

const {
  SkillPromptAnalyzer,
  classifyPromptSource,
  parseInvokedSkills,
  parseCommandMarkers
} = require('../src/utils/skillPromptAnalyzer')
const { AgentContextResolver } = require('../src/utils/agentContext')

const SESSION_A = '11111111-1111-4111-8111-111111111111'

function sessionInfo(clientSessionId = SESSION_A) {
  return {
    clientSessionId,
    source: 'header',
    stickySessionKey: clientSessionId
  }
}

describe('skillPromptAnalyzer text parsing & classification', () => {
  it('1. 能识别标准 <command-message>、<command-name>、<skill-format> 组合', () => {
    const text = `<system-reminder>
<command-message>git-commit</command-message>
<command-name>git-commit</command-name>
<skill-format>true</skill-format>
Skill content for git-commit execution
</system-reminder>`

    const skills = parseCommandMarkers(text)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'git-commit',
      detectionType: 'skill_command_marker',
      confidence: 'exact_marker',
      formatType: 'command_marker'
    })
    expect(skills[0].body).toContain('Skill content for git-commit execution')
    expect(skills[0].chars).toBe(skills[0].body.length)

    expect(classifyPromptSource(text)).toBe('skill_injection')
  })

  it('2. 能识别 invoked_skills 的 ### Skill 和 Path 结构', () => {
    const text = `<system-reminder>
The following skills were invoked in this session:

### Skill: code-reviewer
Path: /home/user/.gemini/skills/code-reviewer/SKILL.md

Review guidelines and instructions here...

### Skill: test-runner
Path: /home/user/.gemini/skills/test-runner/SKILL.md

Run tests with jest...
</system-reminder>`

    const skills = parseInvokedSkills(text)
    expect(skills).toHaveLength(2)
    expect(skills[0]).toMatchObject({
      name: 'code-reviewer',
      path: '/home/user/.gemini/skills/code-reviewer/SKILL.md',
      detectionType: 'invoked_skills',
      confidence: 'exact_marker',
      formatType: 'rehydrate_structure'
    })
    expect(skills[0].body).toContain('Review guidelines and instructions here...')

    expect(skills[1]).toMatchObject({
      name: 'test-runner',
      path: '/home/user/.gemini/skills/test-runner/SKILL.md',
      detectionType: 'invoked_skills',
      confidence: 'exact_marker',
      formatType: 'rehydrate_structure'
    })

    expect(classifyPromptSource(text)).toBe('skill_injection')
  })

  it('3. 能识别 SKILL 列表但不把它计入正文大小', () => {
    const analyzer = new SkillPromptAnalyzer()
    const listText = `<system-reminder>
The following skills are available for use with the Skill tool:
- code-reviewer: review code
- test-runner: run tests
</system-reminder>`

    const requestBody = {
      messages: [{ role: 'user', content: [{ type: 'text', text: listText }] }]
    }

    const { summary, skillRecords } = analyzer.analyze(requestBody, sessionInfo(), 'key-1')
    expect(summary.skill_detected).toBe(true)
    expect(summary.skill_detection_types).toContain('skill_listing')
    expect(summary.skill_chars).toBe(0)
    expect(summary.skill_count).toBe(0)
    expect(skillRecords).toHaveLength(0)

    expect(classifyPromptSource(listText)).toBe('system_reminder')
  })

  it('7. 普通 system reminder 完全拆出 SKILL 指标，不再违反计数不变量', () => {
    const analyzer = new SkillPromptAnalyzer()
    const reminderText = '<system-reminder>Generic environment note</system-reminder>'

    const requestBody = {
      messages: [{ role: 'user', content: [{ type: 'text', text: reminderText }] }]
    }

    const { summary, skillRecords } = analyzer.analyze(requestBody, sessionInfo(), 'key-1')
    // SKILL 指标不为通用 reminder 置位：newly + reinjected (0) <= skill_count (0) 恒成立
    expect(summary.skill_detected).toBe(false)
    expect(summary.skill_detection_confidence).toBeNull()
    expect(summary.skill_detection_types).toEqual([])
    expect(summary.skill_names).toHaveLength(0)
    expect(summary.skill_count).toBe(0)
    expect(summary.skill_injection_count).toBe(0)
    expect(summary.skill_newly_injected_count).toBe(0)
    expect(summary.skill_reinjected_count).toBe(0)
    // 通用 reminder 走独立字段
    expect(summary.system_reminder_detected).toBe(true)
    expect(summary.system_reminder_count).toBe(1)
    expect(summary.system_reminder_detection_types).toContain('generic_system_reminder')
    expect(summary.system_reminder_newly_injected_count).toBe(1)
    expect(summary.system_reminder_chars).toBeGreaterThan(0)
    // 明文记录仍然生成，prompt_source 标记为 system_reminder
    expect(skillRecords).toHaveLength(1)
    expect(skillRecords[0].skill_name).toBeNull()
    expect(skillRecords[0].skill_detection_confidence).toBe('heuristic')
    expect(skillRecords[0].prompt_source).toBe('system_reminder')

    expect(classifyPromptSource(reminderText)).toBe('system_reminder')
  })

  it('普通员工输入分类为 human', () => {
    expect(classifyPromptSource('Please refactor this function')).toBe('human')
    expect(classifyPromptSource('How do I run tests?')).toBe('human')
  })
})

describe('skillPromptAnalyzer incremental analysis & LRU state', () => {
  it('4. 增量对比：未变化历史中的 SKILL 判为 carried_over，不写明文记录', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skillText = `<system-reminder>
<command-message>linter</command-message>
<skill-format>true</skill-format>
Run eslint on modified files
</system-reminder>`

    const request1 = {
      messages: [
        { role: 'user', content: 'human prompt 1' },
        { role: 'user', content: [{ type: 'text', text: skillText }] }
      ]
    }

    // 第一次调用：新注入
    const res1 = analyzer.analyze(request1, sessionInfo(), 'key-1')
    expect(res1.summary.skill_newly_injected_count).toBe(1)
    expect(res1.summary.skill_reinjected_count).toBe(0)
    expect(res1.skillRecords).toHaveLength(1)
    expect(res1.skillRecords[0].skill_injection_kind).toBe('newly_injected')

    // 第二次调用：相同的历史前缀延续
    const request2 = {
      messages: [
        { role: 'user', content: 'human prompt 1' },
        { role: 'user', content: [{ type: 'text', text: skillText }] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'human prompt 2' }
      ]
    }

    const res2 = analyzer.analyze(request2, sessionInfo(), 'key-1')
    expect(res2.summary.skill_detected).toBe(true)
    expect(res2.summary.skill_count).toBe(1)
    expect(res2.summary.skill_newly_injected_count).toBe(0)
    expect(res2.summary.skill_reinjected_count).toBe(0)
    expect(res2.summary.skill_chars).toBeGreaterThan(0)
    // carried_over 不落盘明文
    expect(res2.skillRecords).toHaveLength(0)
  })

  it('5. 增量对比：新消息中的 SKILL 判为 newly_injected，写 skill_prompt_observed', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skill1 = `<system-reminder><command-message>skill-one</command-message><skill-format>true</skill-format>Skill 1</system-reminder>`
    const skill2 = `<system-reminder><command-message>skill-two</command-message><skill-format>true</skill-format>Skill 2</system-reminder>`

    const request1 = {
      messages: [{ role: 'user', content: [{ type: 'text', text: skill1 }] }]
    }
    const res1 = analyzer.analyze(request1, sessionInfo(), 'key-1')
    expect(res1.summary.skill_newly_injected_count).toBe(1)
    expect(res1.skillRecords).toHaveLength(1)
    expect(res1.skillRecords[0].skill_name).toBe('skill-one')

    const request2 = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: skill1 }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: skill2 }] }
      ]
    }
    const res2 = analyzer.analyze(request2, sessionInfo(), 'key-1')
    expect(res2.summary.skill_count).toBe(2)
    expect(res2.summary.skill_newly_injected_count).toBe(1)
    expect(res2.summary.skill_reinjected_count).toBe(0)
    expect(res2.skillRecords).toHaveLength(1)
    expect(res2.skillRecords[0].skill_name).toBe('skill-two')
    expect(res2.skillRecords[0].skill_injection_kind).toBe('newly_injected')
  })

  it('system prompt 中未变化的 system-reminder 判为 carried_over，计入 reminder 指标', () => {
    const analyzer = new SkillPromptAnalyzer()
    const systemSkill = '<system-reminder>Runtime guidance</system-reminder>'
    const request = {
      system: systemSkill,
      messages: [{ role: 'user', content: 'human prompt' }]
    }

    const first = analyzer.analyze(request, sessionInfo(), 'key-1')
    const second = analyzer.analyze(request, sessionInfo(), 'key-1')

    expect(first.summary.skill_newly_injected_count).toBe(0)
    expect(first.summary.system_reminder_newly_injected_count).toBe(1)
    expect(second.summary.system_reminder_newly_injected_count).toBe(0)
    expect(second.summary.system_reminder_reinjected_count).toBe(0)
    expect(second.skillRecords).toHaveLength(0)
  })

  it('上一请求仍存在的 SKILL 在新位置出现时不判为 re_injected', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skillText =
      '<system-reminder><command-message>duplicate</command-message><skill-format>true</skill-format>Body</system-reminder>'

    analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: skillText }] }] },
      sessionInfo(),
      'key-1'
    )
    const result = analyzer.analyze(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: skillText }] },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: [{ type: 'text', text: skillText }] }
        ]
      },
      sessionInfo(),
      'key-1'
    )

    expect(result.summary.skill_newly_injected_count).toBe(1)
    expect(result.summary.skill_reinjected_count).toBe(0)
    expect(result.skillRecords).toHaveLength(1)
    expect(result.skillRecords[0].skill_injection_kind).toBe('newly_injected')
  })

  it('6. 增量对比：消失后以恢复结构重新出现的 SKILL 判为 re_injected 且 skill_rehydrated=true', () => {
    const analyzer = new SkillPromptAnalyzer()
    const originalSkill = `<system-reminder>
<command-message>reviewer</command-message>
<skill-format>true</skill-format>
Code review body text
</system-reminder>`

    const rehydratedSkill = `<system-reminder>
The following skills were invoked in this session:

### Skill: reviewer
Path: /skills/reviewer/SKILL.md

Code review body text
</system-reminder>`

    // 请求 1: 原始注入
    const req1 = {
      messages: [{ role: 'user', content: [{ type: 'text', text: originalSkill }] }]
    }
    analyzer.analyze(req1, sessionInfo(), 'key-1')

    // 请求 2: 上下文被压缩，原始 skill 消息消失
    const req2 = {
      messages: [{ role: 'user', content: 'compacted summary of history' }]
    }
    analyzer.analyze(req2, sessionInfo(), 'key-1')

    // 请求 3: 以 rehydrated 结构重新注入
    const req3 = {
      messages: [
        { role: 'user', content: 'compacted summary of history' },
        { role: 'user', content: [{ type: 'text', text: rehydratedSkill }] }
      ]
    }
    const res3 = analyzer.analyze(req3, sessionInfo(), 'key-1')
    expect(res3.summary.skill_reinjected_count).toBe(1)
    expect(res3.summary.skill_rehydrated).toBe(true)
    expect(res3.skillRecords).toHaveLength(1)
    expect(res3.skillRecords[0]).toMatchObject({
      skill_name: 'reviewer',
      skill_injection_kind: 're_injected',
      skill_rehydrated: true
    })
  })

  it('消息附加其他文本不再导致同一 SKILL 误判为重新注入', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skillText =
      '<system-reminder><command-message>linter</command-message><skill-format>true</skill-format>Body</system-reminder>'

    analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: skillText }] }] },
      sessionInfo(),
      'key-1'
    )
    const result = analyzer.analyze(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: skillText },
              { type: 'text', text: 'extra appended text' }
            ]
          }
        ]
      },
      sessionInfo(),
      'key-1'
    )

    expect(result.summary.skill_newly_injected_count).toBe(0)
    expect(result.summary.skill_reinjected_count).toBe(0)
    expect(result.skillRecords).toHaveLength(0)
  })

  it('同一请求内直接从 command marker 变为恢复结构判为 re_injected 且 rehydrated', () => {
    const analyzer = new SkillPromptAnalyzer()
    const originalSkill = `<system-reminder>
<command-message>reviewer</command-message>
<skill-format>true</skill-format>
Code review body text
</system-reminder>`

    const rehydratedSkill = `<system-reminder>
The following skills were invoked in this session:

### Skill: reviewer
Path: /skills/reviewer/SKILL.md

Code review body text
</system-reminder>`

    // 请求 1: 原始注入
    analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: originalSkill }] }] },
      sessionInfo(),
      'key-1'
    )

    // 请求 2: 压缩在一步内完成，直接出现恢复结构（没有中间“消失”请求）
    const result = analyzer.analyze(
      {
        messages: [
          { role: 'user', content: 'compacted summary of history' },
          { role: 'user', content: [{ type: 'text', text: rehydratedSkill }] }
        ]
      },
      sessionInfo(),
      'key-1'
    )

    expect(result.summary.skill_reinjected_count).toBe(1)
    expect(result.summary.skill_rehydrated).toBe(true)
    expect(result.skillRecords).toHaveLength(1)
    expect(result.skillRecords[0]).toMatchObject({
      skill_name: 'reviewer',
      skill_injection_kind: 're_injected',
      skill_rehydrated: true
    })
  })

  it('skill_injection_count 统计本次请求的实例数，包含 carried_over 实例', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skill1 =
      '<system-reminder><command-message>skill-one</command-message><skill-format>true</skill-format>Skill 1</system-reminder>'
    const skill2 =
      '<system-reminder><command-message>skill-two</command-message><skill-format>true</skill-format>Skill 2</system-reminder>'

    analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: skill1 }] }] },
      sessionInfo(),
      'key-1'
    )
    const result = analyzer.analyze(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: skill1 }] },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: [{ type: 'text', text: skill2 }] }
        ]
      },
      sessionInfo(),
      'key-1'
    )

    // 不变量：newly (1) + reinjected (0) <= injection_count (2)
    expect(result.summary.skill_injection_count).toBe(2)
    expect(result.summary.skill_newly_injected_count).toBe(1)
    expect(result.summary.skill_reinjected_count).toBe(0)
    expect(
      result.summary.skill_newly_injected_count + result.summary.skill_reinjected_count
    ).toBeLessThanOrEqual(result.summary.skill_injection_count)
  })

  it('超过扫描上限时截断并记录自观测字段', () => {
    const analyzer = new SkillPromptAnalyzer()
    const filler = 'x'.repeat(600 * 1024)

    const result = analyzer.analyze(
      { messages: [{ role: 'user', content: filler }] },
      sessionInfo(),
      'key-1'
    )

    expect(result.summary.analysis_truncated).toBe(true)
    expect(result.summary.analysis_scanned_chars).toBe(512 * 1024)
    expect(result.summary.analysis_duration_ms).toBeGreaterThanOrEqual(0)
    // 无 marker 的纯文本不产生任何检测结果
    expect(result.summary.skill_detected).toBe(false)
  })

  it('旧历史耗尽扫描预算时，末尾和 system 的 Skill 仍被检测', () => {
    const analyzer = new SkillPromptAnalyzer()
    const filler = 'x'.repeat(600 * 1024)
    const lateSkill =
      '<system-reminder><command-message>late-skill</command-message><skill-format>true</skill-format>Late body</system-reminder>'
    const systemSkill =
      '<system-reminder><command-message>system-skill</command-message><skill-format>true</skill-format>System body</system-reminder>'
    const messages = [
      { role: 'user', content: filler },
      { role: 'user', content: filler },
      { role: 'user', content: filler },
      { role: 'user', content: filler },
      { role: 'user', content: [{ type: 'text', text: lateSkill }] }
    ]

    const result = analyzer.analyze({ system: systemSkill, messages }, sessionInfo(), 'key-1')

    expect(result.summary.skill_names).toContain('late-skill')
    expect(result.summary.skill_names).toContain('system-skill')
    expect(result.summary.analysis_truncated).toBe(true)
  })

  it('单次扫描字符量硬性封顶在 2MB', () => {
    const analyzer = new SkillPromptAnalyzer()
    const filler = 'y'.repeat(500 * 1024)
    const messages = [0, 1, 2, 3, 4].map(() => ({ role: 'user', content: filler }))

    const result = analyzer.analyze({ messages }, sessionInfo(), 'key-1')

    expect(result.summary.analysis_scanned_chars).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(result.summary.analysis_truncated).toBe(true)
  })

  it('通用 reminder 出现→消失→再出现计为 re_injected', () => {
    const analyzer = new SkillPromptAnalyzer()
    const reminder = '<system-reminder>Runtime guidance</system-reminder>'

    analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: reminder }] }] },
      sessionInfo(),
      'key-1'
    )
    analyzer.analyze(
      { messages: [{ role: 'user', content: 'compacted, reminder gone' }] },
      sessionInfo(),
      'key-1'
    )
    const third = analyzer.analyze(
      {
        messages: [
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: [{ type: 'text', text: reminder }] }
        ]
      },
      sessionInfo(),
      'key-1'
    )

    expect(third.summary.system_reminder_newly_injected_count).toBe(0)
    expect(third.summary.system_reminder_reinjected_count).toBe(1)
  })

  it('父子代理共享根 session 时状态按 agent_context_id 隔离，不串线', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skillText =
      '<system-reminder><command-message>linter</command-message><skill-format>true</skill-format>Body</system-reminder>'

    const parentRequest = {
      system: 'parent system prompt',
      tools: [{ name: 'Read' }],
      messages: [
        { role: 'user', content: 'parent task' },
        { role: 'user', content: [{ type: 'text', text: skillText }] }
      ]
    }
    const subagentRequest = {
      system: 'subagent system prompt',
      messages: [{ role: 'user', content: 'subagent task' }]
    }

    const parentCtx = { agentContextId: 'parent-ctx-0001' }
    const subagentCtx = { agentContextId: 'subagent-ctx-0002' }

    // parent-1: 新注入
    const r1 = analyzer.analyze(parentRequest, sessionInfo(), 'key-1', parentCtx)
    expect(r1.summary.skill_newly_injected_count).toBe(1)
    // subagent-1: 独立上下文，不影响 parent 状态
    analyzer.analyze(subagentRequest, sessionInfo(), 'key-1', subagentCtx)
    // parent-2: 与 parent-1 完全相同 → carried_over，而非 re_injected
    const r3 = analyzer.analyze(parentRequest, sessionInfo(), 'key-1', parentCtx)
    expect(r3.summary.skill_newly_injected_count).toBe(0)
    expect(r3.summary.skill_reinjected_count).toBe(0)
    expect(r3.skillRecords).toHaveLength(0)

    // 无 agentContextId 时回退 session 级状态（旧请求 2 与请求 3 串线的场景）
    const r4 = analyzer.analyze(parentRequest, sessionInfo(), 'key-1', null)
    expect(r4.summary.skill_newly_injected_count).toBe(1)
  })

  it('回归：压缩替换首条用户消息后，Skill rehydrate 仍可识别（resolver alias）', () => {
    const analyzer = new SkillPromptAnalyzer()
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const scopeKey = 'resolver-scope-compression'
    const config = {
      system: 'main system prompt',
      tools: [{ name: 'Read' }, { name: 'Edit' }]
    }

    const originalSkill = `<system-reminder>
<command-message>reviewer</command-message>
<skill-format>true</skill-format>
Code review body text
</system-reminder>`
    const rehydratedSkill = `<system-reminder>
The following skills were invoked in this session:

### Skill: reviewer
Path: /skills/reviewer/SKILL.md

Code review body text
</system-reminder>`

    // 请求 1：原始注入（首条消息是真实员工 Prompt）
    const ctx1 = resolver.resolve(
      {
        ...config,
        messages: [
          { role: 'user', content: 'fix the test' },
          { role: 'user', content: [{ type: 'text', text: originalSkill }] }
        ]
      },
      scopeKey
    )
    analyzer.analyze(
      {
        ...config,
        messages: [
          { role: 'user', content: 'fix the test' },
          { role: 'user', content: [{ type: 'text', text: originalSkill }] }
        ]
      },
      sessionInfo(),
      'key-1',
      ctx1
    )

    // 请求 2：压缩后首条消息被 continuation summary 替换，skill 以恢复结构重现
    const compressedMessages = [
      {
        role: 'user',
        content:
          'This session is being continued from a previous conversation that ran out of context. Summary of analysis so far...'
      },
      { role: 'user', content: [{ type: 'text', text: rehydratedSkill }] }
    ]
    const ctx2 = resolver.resolve({ ...config, messages: compressedMessages }, scopeKey)
    // alias 迁移生效：压缩前后是同一个叶级上下文
    expect(ctx2.agentContextId).toBe(ctx1.agentContextId)

    const result = analyzer.analyze(
      { ...config, messages: compressedMessages },
      sessionInfo(),
      'key-1',
      ctx2
    )

    expect(result.summary.skill_reinjected_count).toBe(1)
    expect(result.summary.skill_rehydrated).toBe(true)
    expect(result.summary.skill_newly_injected_count).toBe(0)
    expect(result.skillRecords[0]).toMatchObject({
      skill_name: 'reviewer',
      skill_injection_kind: 're_injected',
      skill_rehydrated: true
    })
  })

  it('回归：同配置兄弟 A、B 都登记后，B 压缩不得复用 A 的 SKILL 状态', () => {
    const analyzer = new SkillPromptAnalyzer()
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const scopeKey = 'resolver-scope-sibling-skill'
    const config = {
      system: 'shared subagent system',
      tools: [{ name: 'Grep' }]
    }
    const skillText =
      '<system-reminder><command-message>linter</command-message><skill-format>true</skill-format>Body</system-reminder>'

    // A 登记并注入 SKILL；B 登记自己的首消息分支
    const ctxA = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'task A' }] },
      scopeKey
    )
    analyzer.analyze(
      { ...config, messages: [{ role: 'user', content: [{ type: 'text', text: skillText }] }] },
      sessionInfo(),
      'key-1',
      ctxA
    )
    resolver.resolve({ ...config, messages: [{ role: 'user', content: 'task B' }] }, scopeKey)

    // B 压缩：独立新分支，其 SKILL 实例必须按新上下文判定（newly_injected），
    // 而不是继承 A 的活跃状态被判 carried_over
    const bCompressed = {
      ...config,
      messages: [
        {
          role: 'user',
          content:
            'This session is being continued from a previous conversation. Summary of task B analysis...'
        },
        { role: 'user', content: [{ type: 'text', text: skillText }] }
      ]
    }
    const ctxBCompressed = resolver.resolve(bCompressed, scopeKey)
    expect(ctxBCompressed.agentContextId).not.toBe(ctxA.agentContextId)

    const result = analyzer.analyze(bCompressed, sessionInfo(), 'key-1', ctxBCompressed)
    expect(result.summary.skill_newly_injected_count).toBe(1)
    expect(result.summary.skill_reinjected_count).toBe(0)
  })

  it('__proto__ 等特殊 Skill 名称不会污染状态表', () => {
    const analyzer = new SkillPromptAnalyzer()
    const skillText =
      '<system-reminder><command-message>__proto__</command-message><skill-format>true</skill-format>Body</system-reminder>'

    const first = analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: skillText }] }] },
      sessionInfo(),
      'key-1'
    )
    const second = analyzer.analyze(
      { messages: [{ role: 'user', content: [{ type: 'text', text: skillText }] }] },
      sessionInfo(),
      'key-1'
    )

    expect(first.summary.skill_newly_injected_count).toBe(1)
    // 状态未被原型污染时，第二次应正确判为 carried_over
    expect(second.summary.skill_newly_injected_count).toBe(0)
    expect(second.summary.skill_reinjected_count).toBe(0)
  })

  it('12. session 状态 LRU 有界，超量淘汰不导致错误', () => {
    const analyzer = new SkillPromptAnalyzer({ cacheSize: 2 })
    const skill = `<system-reminder><command-message>test</command-message><skill-format>true</skill-format>Body</system-reminder>`

    analyzer.analyze(
      { messages: [{ role: 'user', content: skill }] },
      sessionInfo('session-1'),
      'k1'
    )
    analyzer.analyze(
      { messages: [{ role: 'user', content: skill }] },
      sessionInfo('session-2'),
      'k1'
    )
    analyzer.analyze(
      { messages: [{ role: 'user', content: skill }] },
      sessionInfo('session-3'),
      'k1'
    )

    expect(() => {
      analyzer.analyze(
        { messages: [{ role: 'user', content: skill }] },
        sessionInfo('session-1'),
        'k1'
      )
    }).not.toThrow()
  })

  it('10. 超长、畸形或嵌套标签不会抛出异常或阻断请求', () => {
    const analyzer = new SkillPromptAnalyzer()
    const malformed = `<system-reminder><command-message>${'A'.repeat(500)}</command-message><unclosed-tag>
      <skill-format>invalid
      ${'B'.repeat(600 * 1024)}
    `

    expect(() => {
      const res = analyzer.analyze(
        { messages: [{ role: 'user', content: malformed }] },
        sessionInfo(),
        'key-1'
      )
      expect(res.summary.skill_detected).toBe(true)
      expect(res.summary.skill_chars).toBeLessThanOrEqual(512 * 1024)
      if (res.summary.skill_names.length > 0) {
        expect(res.summary.skill_names[0].length).toBeLessThanOrEqual(128)
      }
    }).not.toThrow()
  })

  it('9. tool input、tool result 不进入 SKILL 分析结果', () => {
    const analyzer = new SkillPromptAnalyzer()
    const requestBody = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: '<command-message>fake-skill</command-message>' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [
                {
                  type: 'text',
                  text: 'The following skills were invoked in this session:\n### Skill: fake\nPath: /fake/SKILL.md\nfake body'
                }
              ]
            }
          ]
        }
      ]
    }

    const { summary, skillRecords } = analyzer.analyze(requestBody, sessionInfo(), 'key-1')
    expect(summary.skill_detected).toBe(false)
    expect(summary.skill_names).toHaveLength(0)
    expect(summary.skill_chars).toBe(0)
    expect(skillRecords).toHaveLength(0)
  })
})
