/**
 * Prompt 来源分类 — 区分员工输入与各类机器注入文本。
 *
 * 分类结果决定内容是否进入员工行为分析：只有 human 视为员工输入，
 * 其余来源（command / skill / auto_classifier / suggestion / recap / system /
 * unknown）一律排除在员工 Prompt 统计之外。
 *
 * v4 起把「技能」与「命令」拆开（生产日志 2026-08-17 取证：/clear、/model、
 * /resume 仅带命令标签也曾被整类判为 skill 并污染 skill_execution 归因）：
 * - 只有文本自身可证明是 SKILL 的强证据（skill-format 标记、invoked-skills
 *   恢复结构头、Base directory 标记、### Skill: 定义结构）才返回 skill；
 * - 仅命令标签（<command-message>/<command-name>/<command-args>/
 *   <command-contents>）不足以证明是技能，返回 command。内置命令与技能
 *   调用在网关侧共用同一套命令标签，本分类器无会话状态、无法查目录，
 *   技能与否的最终判定在 skillPromptAnalyzer（会话目录匹配）完成。
 *
 * 机器模板只匹配稳定、明确的标记（XML 标签、固定头短语），不做自然语言
 * 片段猜测，也不使用宽泛的方括号兜底：研发常用 [TODO]/[BUG] 等前缀写
 * Prompt，误杀员工输入的代价高于漏判未收录的机器模板。未收录模板会按
 * human 进入员工统计，通过版本号和后续规则迭代逐步收敛。
 */

const PROMPT_SOURCE_RULE_VERSION = 4

const SOURCE_TYPES = [
  'human',
  'command',
  'skill',
  'auto_classifier',
  'suggestion',
  'recap',
  'system',
  'unknown'
]

// 仅凭文本即可证明是 SKILL 的强证据；命令标签不在其列
const SKILL_EVIDENCE_MARKERS = [
  'The following skills were invoked in this session:',
  'Base directory for this skill:'
]

const SKILL_FORMAT_PATTERN = /<skill-format>\s*true\s*<\/skill-format>/i
const SKILL_DEFINITION_PATTERN = /^### Skill:\s*\S+/m

// 命令调用标记：证明是机器命令包装，但不足以证明是技能
const COMMAND_TAG_MARKERS = [
  '<command-message>',
  '<command-name>',
  '<command-args>',
  '<command-contents>'
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

function hasSkillEvidence(normalized) {
  if (SKILL_FORMAT_PATTERN.test(normalized) || SKILL_DEFINITION_PATTERN.test(normalized)) {
    return true
  }
  for (const marker of SKILL_EVIDENCE_MARKERS) {
    if (normalized.includes(marker)) {
      return true
    }
  }
  return false
}

function hasCommandTag(normalized) {
  for (const marker of COMMAND_TAG_MARKERS) {
    if (normalized.includes(marker)) {
      return true
    }
  }
  return false
}

function classifyPromptSource(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return 'unknown'
  }

  const normalized = normalizeText(text)

  if (hasSkillEvidence(normalized)) {
    return 'skill'
  }

  if (hasCommandTag(normalized)) {
    return 'command'
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
