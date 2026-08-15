const {
  PROMPT_SOURCE_RULE_VERSION,
  classifyPromptSource,
  isHumanPrompt
} = require('../src/utils/promptSourceClassifier')

describe('promptSourceClassifier', () => {
  it('员工自然语言输入判为 human', () => {
    expect(classifyPromptSource('Please refactor this function')).toBe('human')
    expect(classifyPromptSource('帮我看一下这个报错')).toBe('human')
    expect(classifyPromptSource('  \n多行\n输入  \n')).toBe('human')
    expect(isHumanPrompt('run the tests')).toBe(true)
  })

  it('SKILL 相关标记判为 skill', () => {
    expect(classifyPromptSource('<command-message>linter</command-message>')).toBe('skill')
    expect(classifyPromptSource('<command-name>pdf</command-name>')).toBe('skill')
    expect(classifyPromptSource('<skill-format>true</skill-format>')).toBe('skill')
    expect(
      classifyPromptSource('The following skills were invoked in this session:\n### Skill: x')
    ).toBe('skill')
    expect(classifyPromptSource('Base directory for this skill: /home/u/.claude/skills/x')).toBe(
      'skill'
    )
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
    expect(PROMPT_SOURCE_RULE_VERSION).toBe(3)
  })
})
