const {
  PROMPT_SOURCE_RULE_VERSION,
  SOURCE_TYPES,
  classifyPromptSource,
  isHumanPrompt
} = require('../src/utils/promptSourceClassifier')

describe('promptSourceClassifier', () => {
  it('员工自然语言输入判为 human', () => {
    expect(classifyPromptSource('Please refactor this function')).toBe('human')
    expect(classifyPromptSource('帮我看一下这个报错')).toBe('human')
    expect(classifyPromptSource('  \n多行\n输入  ')).toBe('human')
    expect(isHumanPrompt('run the tests')).toBe(true)
  })

  it('强技能证据判为 skill', () => {
    expect(classifyPromptSource('<skill-format>true</skill-format>')).toBe('skill')
    expect(
      classifyPromptSource(
        '<command-message>linter</command-message>\n<skill-format>true</skill-format>\nbody'
      )
    ).toBe('skill')
    expect(
      classifyPromptSource('The following skills were invoked in this session:\n### Skill: x')
    ).toBe('skill')
    expect(classifyPromptSource('Base directory for this skill: /home/u/.claude/skills/x')).toBe(
      'skill'
    )
    expect(classifyPromptSource('### Skill: code-reviewer\nPath: /skills/x/SKILL.md')).toBe('skill')
  })

  it('仅命令标记不足以证明是技能，判为 command（/clear、/model、/resume 生产取证）', () => {
    expect(classifyPromptSource('<command-message>clear</command-message>')).toBe('command')
    expect(classifyPromptSource('<command-name>/model</command-name>')).toBe('command')
    expect(classifyPromptSource('<command-args>--verbose</command-args>')).toBe('command')
    expect(
      classifyPromptSource(
        '<command-name>/clear</command-name>\n<command-message>clear</command-message>'
      )
    ).toBe('command')
    // 命令是机器包装，不进入员工统计
    expect(isHumanPrompt('<command-name>/clear</command-name>')).toBe(false)
    // skill-format 非真值时只是普通标记文本，不构成技能证据
    expect(classifyPromptSource('<skill-format>invalid</skill-format>')).not.toBe('skill')
  })

  it('SOURCE_TYPES 包含 command 且与 skill 分开', () => {
    expect(SOURCE_TYPES).toContain('command')
    expect(SOURCE_TYPES).toContain('skill')
  })

  it('系统包装与列表判为 system', () => {
    expect(classifyPromptSource('<system-reminder>note</system-reminder>')).toBe('system')
    expect(classifyPromptSource('<local-command-stdout>output</local-command-stdout>')).toBe(
      'system'
    )
    expect(
      classifyPromptSource('The following skills are available for use with the Skill tool:\n- x')
    ).toBe('system')
  })

  it('suggestion / recap / auto classifier 各自归类', () => {
    expect(classifyPromptSource('[SUGGESTION MODE: draft]')).toBe('suggestion')
    expect(
      classifyPromptSource('This session is being continued from a previous conversation.')
    ).toBe('recap')
    expect(classifyPromptSource('[AUTO MODE] classify')).toBe('auto_classifier')
    expect(isHumanPrompt('[AUTO MODE] classify')).toBe(false)
  })

  it('已知机器方括号头判为 system，研发常用前缀不误杀', () => {
    expect(classifyPromptSource('[SYSTEM NOTIFICATION - NOT USER INPUT] done')).toBe('system')
    expect(isHumanPrompt('[SYSTEM NOTIFICATION - NOT USER INPUT] done')).toBe(false)
    // [TODO]/[BUG]/[API] 是员工 Prompt 的常见前缀，必须判 human
    expect(classifyPromptSource('[TODO] fix login timeout')).toBe('human')
    expect(classifyPromptSource('[BUG] 修复登录失败')).toBe('human')
    expect(classifyPromptSource('[API] add pagination')).toBe('human')
    // 未收录的机器头同样按 human 进入员工统计，通过规则版本迭代收敛
    expect(classifyPromptSource('[SOME NEW HEADER] payload')).toBe('human')
  })

  it('空输入判为 unknown，规则版本随分类规则演进', () => {
    expect(classifyPromptSource('')).toBe('unknown')
    expect(classifyPromptSource(null)).toBe('unknown')
    expect(PROMPT_SOURCE_RULE_VERSION).toBe(4)
  })
})
