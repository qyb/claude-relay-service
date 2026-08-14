jest.mock('../src/utils/logger', () => ({
  promptLog: jest.fn(),
  error: jest.fn()
}))

const {
  SkillPromptAnalyzer,
  RULE_VERSION,
  classifyPromptSource,
  extractSkillsFromText,
  parseInvokedSkills,
  parseCommandMarkers,
  stripOuterSystemReminder
} = require('../src/utils/skillPromptAnalyzer')

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

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

  it('7. 普通 system reminder 被标为低置信度 (heuristic)，而不是确定 SKILL', () => {
    const analyzer = new SkillPromptAnalyzer()
    const reminderText = '<system-reminder>Generic environment note</system-reminder>'

    const requestBody = {
      messages: [{ role: 'user', content: [{ type: 'text', text: reminderText }] }]
    }

    const { summary, skillRecords } = analyzer.analyze(requestBody, sessionInfo(), 'key-1')
    expect(summary.skill_detected).toBe(true)
    expect(summary.skill_detection_confidence).toBe('heuristic')
    expect(summary.skill_detection_types).toContain('generic_system_reminder')
    expect(summary.skill_names).toHaveLength(0)
    expect(summary.skill_count).toBe(0)
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

  it('system prompt 中未变化的 system-reminder 判为 carried_over', () => {
    const analyzer = new SkillPromptAnalyzer()
    const systemSkill = '<system-reminder>Runtime guidance</system-reminder>'
    const request = {
      system: systemSkill,
      messages: [{ role: 'user', content: 'human prompt' }]
    }

    const first = analyzer.analyze(request, sessionInfo(), 'key-1')
    const second = analyzer.analyze(request, sessionInfo(), 'key-1')

    expect(first.summary.skill_newly_injected_count).toBe(1)
    expect(second.summary.skill_newly_injected_count).toBe(0)
    expect(second.summary.skill_reinjected_count).toBe(0)
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
