/**
 * Prompt 来源分类 — 区分员工输入与各类机器注入文本。
 *
 * 分类结果决定内容是否进入员工行为分析：只有 human 视为员工输入，
 * 其余来源（auto_classifier / suggestion / recap / skill / system / unknown）
 * 一律排除在员工 Prompt 统计之外。
 *
 * 机器模板只匹配稳定、明确的标记（XML 标签、固定头短语），不做自然语言
 * 片段猜测，也不使用宽泛的方括号兜底：研发常用 [TODO]/[BUG] 等前缀写
 * Prompt，误杀员工输入的代价高于漏判未收录的机器模板。未收录模板会按
 * human 进入员工统计，通过版本号和后续规则迭代逐步收敛。
 */

const PROMPT_SOURCE_RULE_VERSION = 3

const SOURCE_TYPES = [
  'human',
  'auto_classifier',
  'suggestion',
  'recap',
  'skill',
  'system',
  'unknown'
]

const SKILL_TAG_MARKERS = [
  '<command-message>',
  '<command-name>',
  '<skill-format>',
  '<command-args>',
  '<command-contents>',
  'The following skills were invoked in this session:',
  'Base directory for this skill:'
]

// 已在真实日志中出现过的机器方括号头（完整前缀，避免误伤普通输入）
const KNOWN_MACHINE_BRACKET_HEADERS = [/^\[system notification\b/i]

const RECAP_PATTERNS = [
  /^\[recap\b/i,
  /this session is being continued from a previous (?:conversation|session)/i,
  /summary of (?:our|the) conversation so far/i,
  /conversation so far, including/i
]

const AUTO_CLASSIFIER_PATTERNS = [/^\[auto[\s_-]/i, /^\[classifier\b/i]

function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function classifyPromptSource(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return 'unknown'
  }

  const normalized = normalizeText(text)

  for (const marker of SKILL_TAG_MARKERS) {
    if (normalized.includes(marker)) {
      return 'skill'
    }
  }

  if (/The following skills are available for use with the Skill tool:/i.test(normalized)) {
    return 'system'
  }

  if (normalized.includes('<system-reminder>') || normalized.includes('<local-command-stdout>')) {
    return 'system'
  }

  if (KNOWN_MACHINE_BRACKET_HEADERS.some((pattern) => pattern.test(normalized))) {
    return 'system'
  }

  if (/^\[suggestion mode\b/i.test(normalized) || normalized.includes('[SUGGESTION MODE')) {
    return 'suggestion'
  }

  if (RECAP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'recap'
  }

  if (AUTO_CLASSIFIER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'auto_classifier'
  }

  return 'human'
}

function isHumanPrompt(text) {
  return classifyPromptSource(text) === 'human'
}

module.exports = {
  PROMPT_SOURCE_RULE_VERSION,
  SOURCE_TYPES,
  classifyPromptSource,
  isHumanPrompt
}
