/**
 * SKILL Prompt Analyzer — 网关侧分析 Anthropic Messages 中的 SKILL 注入。
 *
 * 识别 Claude Code 注入的 SKILL 文本标记，进行三级置信度判定与增量对比分类，
 * 统计大小，生成 telemetry 摘要与待落盘明文记录。
 *
 * 状态键为 apiKeyId + rootSessionId + agentContextId（v3）：同一根 session 下
 * 的父代理、子代理、Auto 分类器上下文各自维护独立状态，互不覆盖。
 * agentContextId 由 system/tool_schema/首条用户消息指纹派生
 * （见 agentContext.js），缺失时回退到 session 级状态。
 *
 * 指标口径（v2）：
 * - skill_* 计数只覆盖 SKILL 实例（command marker / 恢复结构 / 强结构），
 *   通用 <system-reminder> 一律走 system_reminder_* 独立字段；
 * - 不变量：skill_newly_injected_count + skill_reinjected_count <= skill_injection_count；
 * - skill_count 是去重后的唯一 Skill 名称数，与实例数（skill_injection_count）分开。
 */

const crypto = require('crypto')
const LRUCache = require('./lruCache')
const { buildPromptSessionKey } = require('./promptLogger')
const { classifyPromptSource: classifyMachinePromptSource } = require('./promptSourceClassifier')

const RULE_VERSION = 3
const MAX_SKILL_NAME_LENGTH = 128
const MAX_SKILL_PATH_LENGTH = 128
const MAX_SKILL_BODY_CHARS = 512 * 1024
const MAX_SKILL_ITEMS = 64
const MAX_BLOCK_SCAN_CHARS = 512 * 1024
const MAX_TOTAL_SCAN_CHARS = 2 * 1024 * 1024
const MAX_SEEN_SKILL_ENTRIES = 256

const DEFAULT_CACHE_SIZE = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const CONFIDENCE_RANK = {
  exact_marker: 3,
  strong_pattern: 2,
  heuristic: 1
}

// 进入完整解析前先做廉价的 marker 预检；必须覆盖所有解析分支的触发条件
const SKILL_SNIFF_MARKERS = [
  '<command-message>',
  '<command-name>',
  '<skill-format',
  '### Skill:',
  'The following skills were invoked',
  'The following skills are available',
  '<system-reminder>'
]

const SKILL_INSTANCE_TYPES = new Set([
  'skill_command_marker',
  'invoked_skills',
  'possible_skill_injection'
])

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

function normalizeNewlines(str) {
  if (typeof str !== 'string') {
    return ''
  }
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function stripOuterSystemReminder(text) {
  if (typeof text !== 'string') {
    return ''
  }
  let trimmed = text.trim()
  const startTag = '<system-reminder>'
  const endTag = '</system-reminder>'
  while (trimmed.startsWith(startTag) && trimmed.endsWith(endTag)) {
    trimmed = trimmed.slice(startTag.length, trimmed.length - endTag.length).trim()
  }
  return trimmed
}

function hashContent(content) {
  if (typeof content !== 'string') {
    return null
  }
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * SKILL 增量状态键：session 级 key + 叶级上下文 id。
 * 同一根 session 内父/子代理与 Auto 上下文请求交错时，各自的状态分支
 * 互不覆盖（2026-08-15 生产日志：79 工具主上下文与 0 工具 Auto 上下文
 * 32 次切换曾导致延续被误判为 re_injected）。
 */
function buildAgentStateKey(apiKeyId, clientSessionId, agentContextId) {
  const base = buildPromptSessionKey(apiKeyId, clientSessionId)
  if (!base) {
    return null
  }
  if (typeof agentContextId !== 'string' || !agentContextId.trim()) {
    return base
  }
  return crypto
    .createHash('sha256')
    .update(`${base}\u0000ctx:${agentContextId.trim()}`)
    .digest('hex')
}

function mayContainSkillText(text) {
  for (const marker of SKILL_SNIFF_MARKERS) {
    if (text.includes(marker)) {
      return true
    }
  }
  return false
}

/**
 * 分类单个文本块的来源（沿用 prompt-log 流程的取值口径）。
 * 机器注入但无法细分（auto/suggestion/recap/未知方括号头）统一归入 system_reminder。
 */
function classifyPromptSource(textBlock) {
  const source = classifyMachinePromptSource(textBlock)
  if (source === 'skill') {
    return 'skill_injection'
  }
  if (source === 'human') {
    return 'human'
  }
  if (source === 'unknown' && (typeof textBlock !== 'string' || !textBlock.trim())) {
    return 'unknown_meta'
  }
  return 'system_reminder'
}

/**
 * 从文本中解析 invoked_skills 恢复结构
 * 结构：
 * The following skills were invoked in this session:
 * ### Skill: <name>
 * Path: <path>
 * <content>
 */
function parseInvokedSkills(text) {
  const normalized = normalizeNewlines(text)
  const headerRegex = /The following skills were invoked in this session:\s*/gi
  const headerMatch = headerRegex.exec(normalized)
  if (!headerMatch) {
    return []
  }

  const afterHeader = normalized.slice(headerMatch.index + headerMatch[0].length)
  const skillSectionRegex =
    /### Skill:\s*([^\n\r]+)(?:\r?\nPath:\s*([^\n\r]+))?([\s\S]*?)(?=(?:### Skill:|$))/g
  const skills = []

  let match
  while ((match = skillSectionRegex.exec(afterHeader)) !== null) {
    const rawName = match[1] ? match[1].trim() : ''
    const rawPath = match[2] ? match[2].trim() : ''
    const rawBody = match[3] ? match[3].trim() : ''

    const skillName = sanitizeString(rawName, MAX_SKILL_NAME_LENGTH)
    const skillPath = sanitizeString(rawPath, MAX_SKILL_PATH_LENGTH)
    const bodyNormalized = normalizeNewlines(stripOuterSystemReminder(rawBody))
    const bodyCapped = bodyNormalized.slice(0, MAX_SKILL_BODY_CHARS)

    skills.push({
      name: skillName,
      path: skillPath,
      body: bodyCapped,
      chars: bodyCapped.length,
      detectionType: 'invoked_skills',
      confidence: 'exact_marker',
      formatType: 'rehydrate_structure'
    })
  }

  return skills
}

/**
 * 从文本中解析 command-message / skill-format 等标准标记
 */
function parseCommandMarkers(text) {
  const normalized = normalizeNewlines(text)
  const skills = []

  const hasCommandMessage = normalized.includes('<command-message>')
  const hasSkillFormat = /<skill-format>\s*true\s*<\/skill-format>/i.test(normalized)
  const hasCommandName = normalized.includes('<command-name>')

  if (hasCommandMessage || hasSkillFormat || hasCommandName) {
    const nameMatch =
      normalized.match(/<command-message>([\s\S]*?)<\/command-message>/i) ||
      normalized.match(/<command-name>([\s\S]*?)<\/command-name>/i)

    const rawName = nameMatch ? nameMatch[1].trim() : null
    const skillName = sanitizeString(rawName, MAX_SKILL_NAME_LENGTH)

    const bodyNormalized = normalizeNewlines(stripOuterSystemReminder(normalized))
    const bodyCapped = bodyNormalized.slice(0, MAX_SKILL_BODY_CHARS)

    skills.push({
      name: skillName,
      path: null,
      body: bodyCapped,
      chars: bodyCapped.length,
      detectionType: 'skill_command_marker',
      confidence: skillName ? 'exact_marker' : 'strong_pattern',
      formatType: 'command_marker'
    })
  }

  return skills
}

/**
 * 识别强结构或启发式 SKILL 模式
 */
function parsePatternsAndHeuristics(text) {
  const normalized = normalizeNewlines(text)
  const skills = []

  // 1. 包含 ### Skill: 和 Path: 但没有标准头
  if (/### Skill:\s*([^\n\r]+)/i.test(normalized)) {
    const match = normalized.match(/### Skill:\s*([^\n\r]+)(?:\r?\nPath:\s*([^\n\r]+))?([\s\S]*)/i)
    if (match) {
      const rawName = match[1] ? match[1].trim() : ''
      const rawPath = match[2] ? match[2].trim() : ''
      const rawBody = match[3] ? match[3].trim() : ''

      const skillName = sanitizeString(rawName, MAX_SKILL_NAME_LENGTH)
      const skillPath = sanitizeString(rawPath, MAX_SKILL_PATH_LENGTH)
      const bodyNormalized = normalizeNewlines(stripOuterSystemReminder(rawBody || normalized))
      const bodyCapped = bodyNormalized.slice(0, MAX_SKILL_BODY_CHARS)

      skills.push({
        name: skillName,
        path: skillPath,
        body: bodyCapped,
        chars: bodyCapped.length,
        detectionType: 'possible_skill_injection',
        confidence: 'strong_pattern',
        formatType: 'pattern_structure'
      })
      return skills
    }
  }

  // 2. SKILL 发现/列表信息
  if (/The following skills are available for use with the Skill tool:/i.test(normalized)) {
    skills.push({
      name: null,
      path: null,
      body: '',
      chars: 0,
      detectionType: 'skill_listing',
      confidence: 'exact_marker',
      formatType: 'listing'
    })
    return skills
  }

  // 3. 通用 system-reminder 启发式
  if (normalized.includes('<system-reminder>')) {
    const bodyNormalized = normalizeNewlines(stripOuterSystemReminder(normalized))
    const bodyCapped = bodyNormalized.slice(0, MAX_SKILL_BODY_CHARS)

    skills.push({
      name: null,
      path: null,
      body: bodyCapped,
      chars: bodyCapped.length,
      detectionType: 'generic_system_reminder',
      confidence: 'heuristic',
      formatType: 'generic_reminder'
    })
  }

  return skills
}

/**
 * 对单条文本检测 SKILL 片段
 */
function extractSkillsFromText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return []
  }

  // 优先解析标准 invoked_skills 恢复结构
  const invoked = parseInvokedSkills(text)
  if (invoked.length > 0) {
    return invoked
  }

  // 其次解析 command 标记
  const commandMarkers = parseCommandMarkers(text)
  if (commandMarkers.length > 0) {
    return commandMarkers
  }

  // 再次解析 pattern / heuristic
  return parsePatternsAndHeuristics(text)
}

/**
 * 有界合并 seen 表：本次条目优先保留，再按插入顺序回填历史条目至上限。
 * 输入可能是 null 原型对象，输出同样保持 null 原型。
 */
function mergeBounded(previous, current, cap) {
  const merged = Object.assign(Object.create(null), current)
  if (Object.keys(merged).length >= cap) {
    return merged
  }
  for (const [key, value] of Object.entries(previous || {})) {
    if (Object.keys(merged).length >= cap) {
      break
    }
    if (!(key in merged)) {
      merged[key] = value
    }
  }
  return merged
}

class SkillPromptAnalyzer {
  constructor(options = {}) {
    const cacheSize = parsePositiveInteger(
      options.cacheSize ?? process.env.PROMPT_LOG_CACHE_SIZE,
      DEFAULT_CACHE_SIZE
    )
    this.cacheTtlMs = parsePositiveInteger(
      options.cacheTtlMs ?? process.env.PROMPT_LOG_CACHE_TTL_MS,
      DEFAULT_CACHE_TTL_MS
    )
    this.cache = options.cache || new LRUCache(cacheSize)
  }

  /**
   * 分析请求体中的 SKILL 注入
   * @param {Object} requestBody
   * @param {Object} sessionInfo
   * @param {string|number} apiKeyId
   * @param {Object|null} agentContextInfo - agentContext.js 派生的上下文信息
   * @returns {{ summary: Object, skillRecords: Array }}
   */
  analyze(requestBody = {}, sessionInfo = {}, apiKeyId = null, agentContextInfo = null) {
    const analysisStartedAt = Date.now()
    const detectedSkills = []
    let scannedChars = 0
    let analysisTruncated = false

    const scanText = (text, messageIndex) => {
      if (typeof text !== 'string' || !text.trim()) {
        return
      }
      // 按剩余预算截取当前 block，保证累计扫描量硬性封顶
      const remaining = MAX_TOTAL_SCAN_CHARS - scannedChars
      if (remaining <= 0) {
        analysisTruncated = true
        return
      }
      const scanLimit = Math.min(MAX_BLOCK_SCAN_CHARS, remaining)
      if (text.length > scanLimit) {
        analysisTruncated = true
      }
      const scanScope = text.length > scanLimit ? text.slice(0, scanLimit) : text
      scannedChars += scanScope.length
      if (!mayContainSkillText(scanScope)) {
        return
      }
      for (const item of extractSkillsFromText(scanScope)) {
        detectedSkills.push({ ...item, messageIndex })
      }
    }

    // 1. system prompt 优先扫描，并保存整体 hash 用于跨请求延续判断
    let systemText = ''
    if (typeof requestBody?.system === 'string') {
      systemText = requestBody.system
    } else if (Array.isArray(requestBody?.system)) {
      systemText = requestBody.system
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }

    const systemHash = systemText ? hashContent(systemText) : null
    if (systemText) {
      scanText(systemText, -1)
    }

    // 2. 扫描 messages 文本块：从最新到最旧。新注入的 SKILL 几乎总在
    // 末尾附近，预算耗尽时优先保住末尾和 system（预检 + 扫描上限，
    // 避免大上下文全量解析）
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : []
    for (let msgIdx = messages.length - 1; msgIdx >= 0; msgIdx -= 1) {
      const message = messages[msgIdx]
      const content = message?.content

      if (typeof content === 'string') {
        scanText(content, msgIdx)
      } else if (Array.isArray(content)) {
        for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
          const block = content[blockIndex]
          if (block?.type === 'text' && typeof block.text === 'string') {
            scanText(block.text, msgIdx)
          }
        }
      }
    }

    // 截断最大数量（超限意味着检测结果不完整）
    if (detectedSkills.length > MAX_SKILL_ITEMS) {
      analysisTruncated = true
    }
    const cappedSkills = detectedSkills.slice(0, MAX_SKILL_ITEMS)

    // 3. 增量对比（状态按根 session + 叶级上下文隔离）
    const sessionKey = buildAgentStateKey(
      apiKeyId,
      sessionInfo?.clientSessionId,
      agentContextInfo?.agentContextId
    )
    const previousState = sessionKey ? this.cache.get(sessionKey) : null

    let newlyInjectedCount = 0
    let reinjectedCount = 0
    let skillRehydrated = false
    let reminderNewlyCount = 0
    let reminderReinjectedCount = 0
    const skillRecords = []
    // 状态键来自外部输入（Skill 名称等），一律使用 null 原型对象，
    // 避免 __proto__/constructor 等名称污染原型或被原型属性误命中。
    const currentSeenSkills = Object.create(null)
    const currentSeenSkillNames = Object.create(null)
    const currentSeenReminders = Object.create(null)
    const activeSkillHashes = Object.create(null)
    const activeSkillNames = Object.create(null)
    const activeReminderHashes = Object.create(null)
    // messageIndex -> { contentHash: true }，标识上一请求中每个位置的活跃实例
    const activeOccurrences = Object.create(null)

    const previousActiveSkills = previousState?.activeSkills || {}
    const previousActiveHashes = previousActiveSkills.hashes || {}
    const previousActiveNames = previousActiveSkills.names || {}
    const previousOccurrences = previousState?.activeOccurrences || {}
    const previousSeenReminders = previousState?.seenReminders || {}
    const previousActiveReminderHashes = previousState?.activeReminderHashes || {}

    for (const skill of cappedSkills) {
      const contentHash = hashContent(skill.body)
      skill.contentHash = contentHash
      const isSkillInstance = SKILL_INSTANCE_TYPES.has(skill.detectionType)

      let injectionKind = 'newly_injected'

      if (previousState) {
        // 同一 message 位置出现相同内容的实例即视为延续，不依赖整条消息哈希，
        // 消息中附加其他文本不再导致误判重新注入。system 位置额外要求整体
        // system hash 一致。
        const previousHashesAtPosition = previousOccurrences[skill.messageIndex]
        const sameLocation =
          Boolean(contentHash && previousHashesAtPosition?.[contentHash]) &&
          (skill.messageIndex >= 0 ||
            Boolean(systemHash && previousState.systemHash === systemHash))

        if (sameLocation) {
          injectionKind = 'carried_over'
        } else if (isSkillInstance) {
          // 之前以其它标记格式（如 command marker）出现过的同名 SKILL。
          // 原始注入与恢复注入的包装结构不同，内容 hash 无法跨格式匹配，
          // 需要按名称回溯。
          const previousFormatForName = skill.name
            ? previousState.seenSkillNames?.[skill.name]
            : undefined

          const wasHistoricallySeen =
            Boolean(contentHash && previousState.seenSkills?.[contentHash]) ||
            Boolean(previousFormatForName)
          const wasActiveInPreviousRequest =
            Boolean(contentHash && previousActiveHashes[contentHash]) ||
            Boolean(skill.name && previousActiveNames[skill.name])

          // 上一请求仍是 command marker 等注入格式、本次直接变为恢复结构，
          // 属于一步完成的上下文压缩恢复，同样按 re_injected 统计。
          const isDirectRehydrate =
            skill.formatType === 'rehydrate_structure' &&
            Boolean(skill.name) &&
            Boolean(previousFormatForName) &&
            previousFormatForName !== 'rehydrate_structure'

          // 只有此前见过、且（上一请求已消失，或直接从注入格式变为恢复结构）
          // 才算 re_injected。上一请求仍存在但出现在新位置，
          // 属于 newly_injected 的新增实例。
          if (wasHistoricallySeen && (!wasActiveInPreviousRequest || isDirectRehydrate)) {
            injectionKind = 're_injected'
          } else {
            injectionKind = 'newly_injected'
          }
        } else {
          // 通用 reminder：独立历史表判定出现→消失→再出现
          const wasHistoricallySeen = Boolean(contentHash && previousSeenReminders[contentHash])
          const wasActiveInPreviousRequest = Boolean(
            contentHash && previousActiveReminderHashes[contentHash]
          )
          injectionKind =
            wasHistoricallySeen && !wasActiveInPreviousRequest ? 're_injected' : 'newly_injected'
        }
      }

      skill.injectionKind = injectionKind

      if (isSkillInstance) {
        if (injectionKind === 'newly_injected') {
          newlyInjectedCount += 1
        } else if (injectionKind === 're_injected') {
          reinjectedCount += 1
          if (skill.formatType === 'rehydrate_structure') {
            skillRehydrated = true
          }
        }
      } else if (skill.detectionType === 'generic_system_reminder') {
        if (injectionKind === 'newly_injected') {
          reminderNewlyCount += 1
        } else if (injectionKind === 're_injected') {
          reminderReinjectedCount += 1
        }
      }

      if (isSkillInstance) {
        if (contentHash) {
          currentSeenSkills[contentHash] = {
            name: skill.name,
            path: skill.path,
            formatType: skill.formatType
          }
          activeSkillHashes[contentHash] = true
        }
        if (skill.name) {
          currentSeenSkillNames[skill.name] = skill.formatType
          activeSkillNames[skill.name] = skill.formatType
        }
      } else if (skill.detectionType === 'generic_system_reminder' && contentHash) {
        currentSeenReminders[contentHash] = true
        activeReminderHashes[contentHash] = true
      }

      // 位置实例表对 SKILL 与通用 reminder 都生效（listing 无 body 不记录），
      // 这是 carried_over 判定的依据，与计数的分类口径无关。
      if (contentHash && skill.body) {
        const position = (activeOccurrences[skill.messageIndex] ||= Object.create(null))
        position[contentHash] = true
      }

      // 仅 newly_injected 和 re_injected 生成明文记录 (不记录 listing/discovery 或空 body)
      if (
        (injectionKind === 'newly_injected' || injectionKind === 're_injected') &&
        skill.body &&
        skill.detectionType !== 'skill_listing' &&
        skill.detectionType !== 'skill_discovery'
      ) {
        skillRecords.push({
          skill_name: skill.name,
          skill_path: skill.path,
          skill_detection_confidence: skill.confidence,
          skill_detection_rule_version: RULE_VERSION,
          prompt_source: isSkillInstance ? 'skill_injection' : 'system_reminder',
          skill_injection_kind: injectionKind,
          skill_rehydrated:
            injectionKind === 're_injected' && skill.formatType === 'rehydrate_structure',
          skill_chars: skill.chars,
          prompt: skill.body
        })
      }
    }

    // 更新 LRU 状态（历史表跨请求保留，用于增量对比；有界防膨胀）
    if (sessionKey) {
      const mergedSeenSkills = mergeBounded(
        previousState?.seenSkills,
        currentSeenSkills,
        MAX_SEEN_SKILL_ENTRIES
      )
      const mergedSeenSkillNames = mergeBounded(
        previousState?.seenSkillNames,
        currentSeenSkillNames,
        MAX_SEEN_SKILL_ENTRIES
      )
      const mergedSeenReminders = mergeBounded(
        previousSeenReminders,
        currentSeenReminders,
        MAX_SEEN_SKILL_ENTRIES
      )
      this.cache.set(
        sessionKey,
        {
          systemHash,
          activeSkills: {
            hashes: activeSkillHashes,
            names: activeSkillNames
          },
          activeReminderHashes,
          activeOccurrences,
          seenSkills: mergedSeenSkills,
          seenSkillNames: mergedSeenSkillNames,
          seenReminders: mergedSeenReminders
        },
        this.cacheTtlMs
      )
    }

    // 4. 汇总 telemetry 摘要（SKILL 与通用 system-reminder 严格分开）
    let skillInstanceCount = 0
    let reminderInstanceCount = 0
    let hasSkillListing = false
    let highestConfidence = null
    const detectionTypesSet = new Set()
    const reminderDetectionTypesSet = new Set()
    const skillNamesSet = new Set()
    let totalSkillChars = 0
    let totalReminderChars = 0

    for (const skill of cappedSkills) {
      if (SKILL_INSTANCE_TYPES.has(skill.detectionType)) {
        skillInstanceCount += 1
        totalSkillChars += skill.chars
        if (skill.name) {
          skillNamesSet.add(skill.name)
        }
      } else if (skill.detectionType === 'generic_system_reminder') {
        reminderInstanceCount += 1
        totalReminderChars += skill.chars
        if (skill.detectionType) {
          reminderDetectionTypesSet.add(skill.detectionType)
        }
      } else {
        hasSkillListing = true
      }

      if (skill.detectionType && skill.detectionType !== 'generic_system_reminder') {
        detectionTypesSet.add(skill.detectionType)
      }
      if (
        !highestConfidence ||
        CONFIDENCE_RANK[skill.confidence] > CONFIDENCE_RANK[highestConfidence]
      ) {
        highestConfidence = skill.confidence
      }
    }

    const skillDetected = skillInstanceCount > 0 || hasSkillListing
    if (!skillInstanceCount && !hasSkillListing) {
      highestConfidence = null
    }
    const skillNames = Array.from(skillNamesSet).sort()

    const summary = {
      skill_detected: skillDetected,
      skill_detection_confidence: skillDetected ? highestConfidence : null,
      skill_detection_rule_version: RULE_VERSION,
      skill_detection_types: Array.from(detectionTypesSet).sort(),
      skill_names: skillNames,
      skill_count: skillNames.length,
      skill_injection_count: skillInstanceCount,
      skill_chars: totalSkillChars,
      skill_newly_injected_count: newlyInjectedCount,
      skill_reinjected_count: reinjectedCount,
      skill_rehydrated: skillRehydrated,
      system_reminder_detected: reminderInstanceCount > 0,
      system_reminder_count: reminderInstanceCount,
      system_reminder_detection_types: Array.from(reminderDetectionTypesSet).sort(),
      system_reminder_chars: totalReminderChars,
      system_reminder_newly_injected_count: reminderNewlyCount,
      system_reminder_reinjected_count: reminderReinjectedCount,
      analysis_duration_ms: Date.now() - analysisStartedAt,
      analysis_scanned_chars: scannedChars,
      analysis_truncated: analysisTruncated
    }

    return {
      summary,
      skillRecords
    }
  }
}

const defaultSkillPromptAnalyzer = new SkillPromptAnalyzer()

module.exports = defaultSkillPromptAnalyzer
module.exports.SkillPromptAnalyzer = SkillPromptAnalyzer
module.exports.RULE_VERSION = RULE_VERSION
module.exports.buildAgentStateKey = buildAgentStateKey
module.exports.classifyPromptSource = classifyPromptSource
module.exports.extractSkillsFromText = extractSkillsFromText
module.exports.parseInvokedSkills = parseInvokedSkills
module.exports.parseCommandMarkers = parseCommandMarkers
module.exports.stripOuterSystemReminder = stripOuterSystemReminder
