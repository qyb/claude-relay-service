/**
 * SKILL Prompt Analyzer — 网关侧分析 Anthropic Messages 中的 SKILL 注入。
 *
 * 识别 Claude Code 注入的 SKILL 文本标记，进行三级置信度判定与增量对比分类，
 * 统计大小，生成 telemetry 摘要与待落盘明文记录。
 */

const crypto = require('crypto')
const LRUCache = require('./lruCache')
const { buildPromptSessionKey } = require('./promptLogger')

const RULE_VERSION = 1
const MAX_SKILL_NAME_LENGTH = 128
const MAX_SKILL_PATH_LENGTH = 128
const MAX_SKILL_BODY_CHARS = 512 * 1024
const MAX_SKILL_ITEMS = 64

const DEFAULT_CACHE_SIZE = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const CONFIDENCE_RANK = {
  exact_marker: 3,
  strong_pattern: 2,
  heuristic: 1
}

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
 * 分类单个文本块的来源
 */
function classifyPromptSource(textBlock) {
  if (typeof textBlock !== 'string' || !textBlock.trim()) {
    return 'unknown_meta'
  }

  const raw = textBlock.trim()
  const normalized = normalizeNewlines(raw)

  // 1. 明确的 SKILL 命令/标记
  if (
    normalized.includes('<command-message>') ||
    normalized.includes('<command-name>') ||
    normalized.includes('<skill-format>') ||
    normalized.includes('<command-args>') ||
    normalized.includes('<command-contents>') ||
    normalized.includes('<local-command-stdout>') ||
    /The following skills were invoked in this session:/i.test(normalized)
  ) {
    return 'skill_injection'
  }

  // 2. SKILL 列表/发现
  if (/The following skills are available for use with the Skill tool:/i.test(normalized)) {
    return 'system_reminder'
  }

  // 3. 系统提醒标签包裹
  if (normalized.startsWith('<system-reminder>') && normalized.endsWith('</system-reminder>')) {
    return 'system_reminder'
  }

  if (normalized.includes('<system-reminder>')) {
    return 'system_reminder'
  }

  return 'human'
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
   * @returns {{ summary: Object, skillRecords: Array }}
   */
  analyze(requestBody = {}, sessionInfo = {}, apiKeyId = null) {
    const detectedSkills = []
    const messageHashes = []
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : []

    // 1. 扫描 messages 中的文本块
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx += 1) {
      const message = messages[msgIdx]
      const content = message?.content
      let msgTextCombined = ''

      if (typeof content === 'string') {
        msgTextCombined = content
        const extracted = extractSkillsFromText(content)
        for (const item of extracted) {
          detectedSkills.push({ ...item, messageIndex: msgIdx })
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            msgTextCombined += (msgTextCombined ? '\n' : '') + block.text
            const extracted = extractSkillsFromText(block.text)
            for (const item of extracted) {
              detectedSkills.push({ ...item, messageIndex: msgIdx })
            }
          }
        }
      }

      messageHashes.push(hashContent(msgTextCombined))
    }

    // 2. 扫描 system prompt（如果存在），并保存整体 hash 用于跨请求延续判断
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
      const systemExtracted = extractSkillsFromText(systemText)
      for (const item of systemExtracted) {
        detectedSkills.push({ ...item, messageIndex: -1 })
      }
    }

    // 截断最大数量
    const cappedSkills = detectedSkills.slice(0, MAX_SKILL_ITEMS)

    // 3. 增量对比
    const sessionKey = buildPromptSessionKey(apiKeyId, sessionInfo?.clientSessionId)
    const previousState = sessionKey ? this.cache.get(sessionKey) : null

    let newlyInjectedCount = 0
    let reinjectedCount = 0
    let skillRehydrated = false
    const skillRecords = []
    const currentSeenSkills = {}
    const currentSeenSkillNames = {}
    const activeSkillHashes = {}
    const activeSkillNames = {}

    const previousActiveSkills = previousState?.activeSkills || {}
    const previousActiveHashes = previousActiveSkills.hashes || {}
    const previousActiveNames = previousActiveSkills.names || {}

    for (const skill of cappedSkills) {
      const contentHash = hashContent(skill.body)
      skill.contentHash = contentHash

      let injectionKind = 'newly_injected'

      if (previousState) {
        const prevMsgHashAtIndex = previousState.messageHashes?.[skill.messageIndex]
        const currentMsgHash = messageHashes[skill.messageIndex]

        // 之前以其它标记格式（如 command marker）出现过的同名 SKILL。
        // 原始注入与恢复注入的包装结构不同，内容 hash 无法跨格式匹配，
        // 需要按名称回溯。
        const seenByName = skill.name ? previousState.seenSkillNames?.[skill.name] : undefined

        const sameLocation =
          skill.messageIndex >= 0
            ? Boolean(contentHash && prevMsgHashAtIndex && prevMsgHashAtIndex === currentMsgHash)
            : Boolean(
                previousState.systemHash && systemHash && previousState.systemHash === systemHash
              )

        // 如果在相同位置且消息内容 hash 一致 -> carried_over
        if (sameLocation) {
          injectionKind = 'carried_over'
        } else {
          const wasHistoricallySeen =
            Boolean(contentHash && previousState.seenSkills?.[contentHash]) || Boolean(seenByName)
          const wasActiveInPreviousRequest =
            Boolean(contentHash && previousActiveHashes[contentHash]) ||
            Boolean(skill.name && previousActiveNames[skill.name])

          // 只有此前见过、且上一请求已经消失，本次再次出现才是 re_injected。
          // 上一请求仍存在但出现在新位置，属于 newly_injected 的新增实例。
          if (wasHistoricallySeen && !wasActiveInPreviousRequest) {
            injectionKind = 're_injected'
          } else {
            injectionKind = 'newly_injected'
          }
        }
      } else {
        injectionKind = 'newly_injected'
      }

      skill.injectionKind = injectionKind

      if (injectionKind === 'newly_injected') {
        newlyInjectedCount += 1
      } else if (injectionKind === 're_injected') {
        reinjectedCount += 1
        if (skill.formatType === 'rehydrate_structure') {
          skillRehydrated = true
        }
      }

      if (contentHash) {
        currentSeenSkills[contentHash] = {
          name: skill.name,
          path: skill.path,
          formatType: skill.formatType
        }
      }
      if (skill.name) {
        currentSeenSkillNames[skill.name] = skill.formatType
        activeSkillNames[skill.name] = true
      }
      if (contentHash) {
        activeSkillHashes[contentHash] = true
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
          prompt_source:
            skill.detectionType === 'generic_system_reminder'
              ? 'system_reminder'
              : 'skill_injection',
          skill_injection_kind: injectionKind,
          skill_rehydrated:
            injectionKind === 're_injected' && skill.formatType === 'rehydrate_structure',
          skill_chars: skill.chars,
          prompt: skill.body
        })
      }
    }

    // 更新 LRU 状态（名称表跨请求保留，用于压缩恢复后的跨格式匹配）
    if (sessionKey) {
      const mergedSeenSkills = {
        ...(previousState?.seenSkills || {}),
        ...currentSeenSkills
      }
      const mergedSeenSkillNames = {
        ...(previousState?.seenSkillNames || {}),
        ...currentSeenSkillNames
      }
      this.cache.set(
        sessionKey,
        {
          messageHashes,
          systemHash,
          activeSkills: {
            hashes: activeSkillHashes,
            names: activeSkillNames
          },
          seenSkills: mergedSeenSkills,
          seenSkillNames: mergedSeenSkillNames
        },
        this.cacheTtlMs
      )
    }

    // 4. 汇总 telemetry 摘要
    const skillDetected = cappedSkills.length > 0
    let highestConfidence = null
    const detectionTypesSet = new Set()
    const skillNamesSet = new Set()
    let totalSkillChars = 0

    for (const skill of cappedSkills) {
      if (
        !highestConfidence ||
        CONFIDENCE_RANK[skill.confidence] > CONFIDENCE_RANK[highestConfidence]
      ) {
        highestConfidence = skill.confidence
      }
      if (skill.detectionType) {
        detectionTypesSet.add(skill.detectionType)
      }
      if (skill.name) {
        skillNamesSet.add(skill.name)
      }
      // listing / discovery 不计入字符数
      if (skill.detectionType !== 'skill_listing' && skill.detectionType !== 'skill_discovery') {
        totalSkillChars += skill.chars
      }
    }

    const skillNames = Array.from(skillNamesSet).sort()

    const summary = {
      skill_detected: skillDetected,
      skill_detection_confidence: highestConfidence,
      skill_detection_rule_version: RULE_VERSION,
      skill_detection_types: Array.from(detectionTypesSet).sort(),
      skill_names: skillNames,
      skill_count: skillNames.length,
      skill_chars: totalSkillChars,
      skill_newly_injected_count: newlyInjectedCount,
      skill_reinjected_count: reinjectedCount,
      skill_rehydrated: skillRehydrated
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
module.exports.classifyPromptSource = classifyPromptSource
module.exports.extractSkillsFromText = extractSkillsFromText
module.exports.parseInvokedSkills = parseInvokedSkills
module.exports.parseCommandMarkers = parseCommandMarkers
module.exports.stripOuterSystemReminder = stripOuterSystemReminder
