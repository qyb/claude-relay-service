/**
 * Request Purpose Classifier — 判定请求目的（P0-1）。
 *
 * 判定优先级（高到低）：
 * 1. 客户端显式 header `x-crs-request-purpose`（枚举校验，未来的标准通道）；
 * 2. 真实日志取证的机器模板指纹（完整固定短语，不做自然语言猜测）；
 * 3. 最新 user 文本带强技能证据（skill-format / 恢复结构 / Base directory）→
 *    skill_execution。v4 起仅命令标记（/clear、/model 等）不再判为
 *    skill_execution（promptSourceClassifier v4 拆分），此类请求走
 *    context_role / skill_instance / structure 分支；
 * 4. 上下文角色：同一根 session 下非主上下文 → subagent（P0-2 的
 *    agent_context_id 派生使这成为可靠信号，无需读正文）；
 * 5. 最新 user 文本为员工自然语言 → human；
 * 6. 无新人工文本但存在 SKILL 实例 → skill_execution（SKILL 驱动的延续）；
 * 7. 无新人工文本且存在历史消息 → background；否则 unknown。
 *
 * [TODO]/[BUG]/[API] 等研发常用前缀没有模板指纹，走默认 human，
 * 不会误杀员工输入。只有 human 进入 user_prompt_observed，
 * 其余目的写无正文的 machine_prompt_observed 统计。
 *
 * 输入口径：latestUserText 必须来自"只读最后一条 user 消息"的严格提取器
 * （promptLogger.extractLatestUserMessageText）。跨消息回溯会把工具续跑
 * 请求（尾部 tool_result-only）错归因到历史人工 Prompt。
 *
 * 主上下文选举（临时启发式，直到客户端提供真实 agent ID）：
 * primary 在该 root session 内首次出现"可信 human 主上下文"时一次性固定
 * （无模板命中、无 header 机器目的、文本为员工自然语言）。命中模板的
 * Auto/recap/suggestion 请求不参与选举——否则 Auto 先到会吞掉主上下文，
 * 且 primary 不能随请求数重新挑选，否则高频子代理会翻转角色。
 * 置信度通过 agent_context_role_source 表达：elected_primary（本请求
 * 自我当选，低置信度——父子请求并发或乱序时先到的自然语言子代理也会
 * 当选）与 registry_primary（命中已固定的注册表）。消费方应据此决定
 * 是否信任 primary/subagent 归类。
 */

const crypto = require('crypto')
const LRUCache = require('./lruCache')
const { classifyPromptSource } = require('./promptSourceClassifier')

const PURPOSE_RULE_VERSION = 4
const PURPOSE_TYPES = [
  'human',
  'auto_classifier',
  'recap',
  'suggestion',
  'skill_execution',
  'subagent',
  'background',
  'unknown'
]

// purpose 判定来源，用于消费方评估置信度（header/template 为强信号，
// context_role/structure 为启发式）
const PURPOSE_SOURCES = [
  'header',
  'template',
  'skill_marker',
  'context_role',
  'human_text',
  'skill_instance',
  'structure'
]

const PURPOSE_HEADER_NAME = 'x-crs-request-purpose'

// 模板命中时 prompt_source 同步为对应机器来源，
// 避免 request_purpose 与 prompt_source 相互矛盾
const TEMPLATE_PROMPT_SOURCE = {
  auto_classifier: 'auto_classifier',
  recap: 'recap',
  suggestion: 'suggestion',
  background: 'system'
}

// 已在生产日志中取证确认的模板（stage-2 未在本地日志出现，指纹足够特异，命中即归类）
const MACHINE_TEMPLATE_FINGERPRINTS = [
  {
    id: 'auto_stage1_block',
    purpose: 'auto_classifier',
    pattern: /Err on the side of blocking\.\s*Stage 1/i
  },
  {
    id: 'auto_stage2_review',
    purpose: 'auto_classifier',
    pattern: /Review the classification process/i
  },
  {
    id: 'recap_stepped_away',
    purpose: 'recap',
    pattern: /The user stepped away and is coming back/i
  },
  {
    id: 'suggestion_mode',
    purpose: 'suggestion',
    pattern: /^\[suggestion mode\b/i
  },
  {
    id: 'user_interrupted',
    purpose: 'background',
    pattern: /^User: \[Request interrupted by user\]/m
  }
]

const DEFAULT_CACHE_SIZE = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// 每 root session 的上下文计数条目上限：首条消息变化、动态 system/tool
// 或大量子代理都可能派生新上下文 id，超量时淘汰计数最少的非 primary 条目
const MAX_CONTEXTS_PER_SESSION = 64

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return null
  }
  const direct = headers[name] ?? headers[name.toLowerCase()]
  if (typeof direct === 'string') {
    return direct
  }
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name)
  const value = matchingKey ? headers[matchingKey] : null
  return typeof value === 'string' ? value : null
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function matchTemplateFingerprint(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null
  }
  for (const template of MACHINE_TEMPLATE_FINGERPRINTS) {
    if (template.pattern.test(text)) {
      return template
    }
  }
  return null
}

/**
 * 注册表 key：apiKeyId + rootSessionId 的哈希。
 * 不同 API Key 复用相同 session id 时，role 判断互不影响。
 */
function buildRegistryKey(apiKeyId, rootSessionId) {
  if (typeof rootSessionId !== 'string' || !rootSessionId.trim()) {
    return null
  }
  const apiKeyPart =
    (typeof apiKeyId === 'string' || typeof apiKeyId === 'number') && String(apiKeyId).trim()
      ? String(apiKeyId)
      : ''
  return crypto
    .createHash('sha256')
    .update(`${apiKeyPart}\u0000anthropic\u0000${rootSessionId.trim().toLowerCase()}`)
    .digest('hex')
}

class RequestPurposeClassifier {
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
   * 判定请求目的并维护根 session 的上下文注册表。
   *
   * @param {Object} input
   * @param {Object} input.headers - 请求头（可选）
   * @param {string} input.latestUserText - 最后一条 user 消息的文本（严格提取，不回溯）
   * @param {boolean} input.skillInstanceDetected - SKILL 分析器是否检出实例
   * @param {number} input.toolsOfferedCount - 本次请求提供的工具数
   * @param {number} input.messageCount - 消息数
   * @param {string} input.rootSessionId - 根 session id（client_session_id）
   * @param {string|number|null} input.apiKeyId - API Key 记录 id（注册表隔离范围）
   * @param {string|null} input.agentContextId - 派生的叶级上下文 id
   */
  classify(input = {}) {
    const headerPurpose = this.resolveHeaderPurpose(input.headers)
    const text = input.latestUserText
    const contentSource = classifyPromptSource(text)
    const template = matchTemplateFingerprint(text)
    // 模板命中时同步 prompt_source，保持与 request_purpose 一致的机器口径
    const promptSource = template ? TEMPLATE_PROMPT_SOURCE[template.purpose] : contentSource

    const agentContextId = input.agentContextId || null
    const registryKey = buildRegistryKey(input.apiKeyId, input.rootSessionId)
    let registry = registryKey
      ? this.cache.get(registryKey) || { primaryContextId: null, contextCounts: {} }
      : null

    // "可信 human 主上下文"：无模板指纹、无 header 机器目的、正文为员工
    // 自然语言。primary 只在该信号首次出现时选举一次，此后不再变更。
    const isCredibleHumanContext =
      Boolean(agentContextId) &&
      !template &&
      (!headerPurpose || headerPurpose === 'human') &&
      contentSource === 'human' &&
      typeof text === 'string' &&
      text.trim().length > 0

    let agentContextRole = null
    let agentContextRoleSource = null
    if (registry) {
      if (registry.primaryContextId) {
        if (agentContextId) {
          agentContextRole = agentContextId === registry.primaryContextId ? 'primary' : 'secondary'
          agentContextRoleSource = 'registry_primary'
        }
      } else if (isCredibleHumanContext) {
        registry.primaryContextId = agentContextId
        agentContextRole = 'primary'
        // 低置信度：本请求自我当选。父子请求并发或乱序时，先到的
        // 自然语言子代理也会当选，真正主上下文随后被判 subagent
        agentContextRoleSource = 'elected_primary'
      }
      // primary 未选出且当前请求不可信（模板命中 / 无上下文 id / 机器文本）
      // 时不给角色：Auto 先到不能吞掉后续真正主上下文的选举资格

      registry = this.bumpContextCount(registry, agentContextId)
      this.cache.set(registryKey, registry, this.cacheTtlMs)
    }

    let requestPurpose
    let purposeSource
    let templateId = null

    if (headerPurpose) {
      requestPurpose = headerPurpose
      purposeSource = 'header'
    } else if (template) {
      requestPurpose = template.purpose
      purposeSource = 'template'
      templateId = template.id
    } else if (contentSource === 'skill') {
      // 最新 user 文本带强技能证据（skill-format / 恢复结构 / Base directory）
      // → 本次请求由 SKILL 触发。仅命令标记（/clear 等）不走此分支
      requestPurpose = 'skill_execution'
      purposeSource = 'skill_marker'
    } else if (agentContextRole === 'secondary') {
      requestPurpose = 'subagent'
      purposeSource = 'context_role'
    } else if (contentSource === 'human' && typeof text === 'string' && text.trim()) {
      requestPurpose = 'human'
      purposeSource = 'human_text'
    } else if (input.skillInstanceDetected === true) {
      // 无新人工文本但上下文中存在 SKILL 实例 → SKILL 驱动的延续请求
      requestPurpose = 'skill_execution'
      purposeSource = 'skill_instance'
    } else {
      // 无新人工文本（或未识别的机器包装）且存在历史消息 → 延续性后台请求
      const messageCount = Number.isInteger(input.messageCount) ? input.messageCount : 0
      requestPurpose = messageCount > 1 ? 'background' : 'unknown'
      purposeSource = 'structure'
    }

    return {
      request_purpose: requestPurpose,
      purpose_rule_version: PURPOSE_RULE_VERSION,
      purpose_source: purposeSource,
      template_id: templateId,
      agent_context_role: agentContextRole,
      agent_context_role_source: agentContextRoleSource,
      prompt_source: promptSource
    }
  }

  resolveHeaderPurpose(headers) {
    const raw = getHeader(headers, PURPOSE_HEADER_NAME)
    if (typeof raw !== 'string') {
      return null
    }
    const normalized = raw.trim().toLowerCase()
    return PURPOSE_TYPES.includes(normalized) ? normalized : null
  }

  bumpContextCount(registry, agentContextId) {
    const next = {
      primaryContextId: registry.primaryContextId || null,
      contextCounts: { ...registry.contextCounts }
    }
    const key = agentContextId || '_unattributed'
    const counts = next.contextCounts
    if (!(key in counts) && Object.keys(counts).length >= MAX_CONTEXTS_PER_SESSION) {
      // 淘汰计数最少的非 primary 条目；_unattributed 保留（无上下文 id 的
      // 请求回退用它，删除会导致计数重置）
      let victim = null
      for (const [contextId, count] of Object.entries(counts)) {
        if (contextId === registry.primaryContextId || contextId === '_unattributed') {
          continue
        }
        if (victim === null || count < counts[victim]) {
          victim = contextId
        }
      }
      if (victim !== null) {
        delete counts[victim]
      }
    }
    counts[key] = (counts[key] || 0) + 1
    return next
  }
}

const defaultRequestPurposeClassifier = new RequestPurposeClassifier()

module.exports = defaultRequestPurposeClassifier
module.exports.RequestPurposeClassifier = RequestPurposeClassifier
module.exports.PURPOSE_RULE_VERSION = PURPOSE_RULE_VERSION
module.exports.PURPOSE_SOURCES = PURPOSE_SOURCES
module.exports.PURPOSE_TYPES = PURPOSE_TYPES
module.exports.MAX_CONTEXTS_PER_SESSION = MAX_CONTEXTS_PER_SESSION
module.exports.buildRegistryKey = buildRegistryKey
module.exports.matchTemplateFingerprint = matchTemplateFingerprint
