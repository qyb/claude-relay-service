/**
 * Agent Context — 从请求体派生叶级上下文标识。
 *
 * 同一根 session 下可能并存多个代理上下文（父代理、子代理、Auto 分类器），
 * 它们共享 client_session_id 但 system prompt / 工具集合 / 首条用户消息
 * 不同。用这三个组件的哈希组合出稳定的 agent_context_id，供 SKILL 增量
 * 状态隔离与 request_purpose 判定使用；客户端将来提供真实 agent ID 后
 * 可直接替换。
 *
 * 身份稳定性分层：
 * - system + tool schema 是主身份：上下文生命周期内不变；
 * - 首条用户消息只是同配置兄弟上下文的辅助分支。上下文压缩会把首条
 *   消息替换为 continuation summary，AgentContextResolver 为该场景维护
 *   alias 迁移：同 scope（apiKey + root session）同 system/tool 配置下，
 *   summary 首消息回退到已登记的原始分支，避免压缩打断 SKILL 状态链。
 *   该 alias 仅在配置下只观察到一个首消息分支时生效——已观察到多个
 *   分支（同配置兄弟上下文）时无证据指向哪个分支，禁止 alias 到
 *   canonical，退化为以 summary 自身指纹为独立新分支。
 *
 * 三个组件指纹均使用 hmacKeyring 的独立用途密钥（agent-context:v1）
 * 计算 HMAC，并输出 context_key_id 供密钥轮换后的分析对齐：固定系统
 * 提示词 / 工具 schema 与低熵 Prompt 一样可被普通 SHA 前缀的离线字典
 * 枚举，防护口径必须一致。
 *
 * 2026-08-15 生产日志验证：同一 session 内 79 工具主上下文与 0 工具
 * Auto 上下文的 system/tool_schema 哈希完全可区分。
 */

const crypto = require('crypto')
const LRUCache = require('./lruCache')
const { getKeyId, getPurposeKey } = require('./hmacKeyring')
const { classifyPromptSource } = require('./promptSourceClassifier')

const COMPONENT_HASH_LENGTH = 12
const AGENT_CONTEXT_ID_LENGTH = 16
const DEFAULT_RESOLVER_CACHE_SIZE = 10000
const DEFAULT_RESOLVER_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// 每 scope + system/tool 配置登记的首消息分支上限：仅用于歧义判定
// （0 / 1 / 多个），超量后不再新增登记，歧义分支保持"多个"语义
const MAX_BRANCHES_PER_BASE = 32

// 与 llmTelemetry.hashValue 相同口径的稳定序列化（key 顺序无关），
// 独立实现以避免引入 logger/pricing 依赖链
function stableSerialize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
  return `{${entries.join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function extractSystemText(requestBody) {
  if (typeof requestBody?.system === 'string') {
    return requestBody.system
  }
  if (Array.isArray(requestBody?.system)) {
    return requestBody.system
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

/**
 * 首条包含普通文本的 user 消息（跳过 tool_result-only 消息）。
 */
function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }

  for (const message of messages) {
    if (message?.role !== 'user') {
      continue
    }
    const { content } = message
    if (typeof content === 'string' && content.trim()) {
      return content
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim()) {
        return text
      }
    }
  }
  return ''
}

/**
 * 首条用户消息是否为压缩/延续 summary。
 * Claude Code 压缩后首条消息形如
 * "This session is being continued from a previous conversation..."，
 * 由 promptSourceClassifier 的 recap 规则覆盖。
 */
function isContinuationSummaryText(text) {
  return typeof text === 'string' && text.trim() && classifyPromptSource(text) === 'recap'
}

// 所有组件统一走用途隔离 HMAC，防止离线字典枚举还原
function componentFingerprint(value) {
  const key = getPurposeKey('agent-context:v1')
  return crypto
    .createHmac('sha256', key)
    .update(stableSerialize(value))
    .digest('hex')
    .slice(0, COMPONENT_HASH_LENGTH)
}

function buildResult(systemPromptHash, toolSchemaHash, firstUserMessageHash) {
  if (!systemPromptHash && !toolSchemaHash && !firstUserMessageHash) {
    return {
      agentContextId: null,
      contextFingerprint: null,
      contextKeyId: null,
      systemPromptHash: null,
      toolSchemaHash: null,
      firstUserMessageHash: null
    }
  }

  const contextFingerprint = [
    `sys:${systemPromptHash || '-'}`,
    `tools:${toolSchemaHash || '-'}`,
    `first:${firstUserMessageHash || '-'}`
  ].join('|')

  return {
    agentContextId: sha256(contextFingerprint).slice(0, AGENT_CONTEXT_ID_LENGTH),
    contextFingerprint,
    // 指纹密钥 id（ek- 前缀为配置密钥，ephemeral- 为进程随机密钥），
    // 密钥轮换后按它分组，避免跨密钥比较指纹
    contextKeyId: getKeyId('agent-context:v1'),
    systemPromptHash,
    toolSchemaHash,
    firstUserMessageHash
  }
}

/**
 * 无状态派生：不做压缩 alias 迁移。scope 不可用（无 session / 无 API Key）
 * 或调用方无需跨请求稳定时的回退路径。
 */
function deriveAgentContext(requestBody = {}) {
  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : []
  const systemText = extractSystemText(requestBody)
  const firstUserText = extractFirstUserMessageText(requestBody?.messages)

  return buildResult(
    systemText ? componentFingerprint(systemText) : null,
    tools.length > 0 ? componentFingerprint(tools) : null,
    firstUserText ? componentFingerprint(firstUserText) : null
  )
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 有状态解析：在同一 scope（apiKey + root session 的哈希）内维护
 * system/tool 配置到首条用户消息分支的登记：
 * - 首条消息是原始 Prompt：登记为该配置的分支，首个分支即 canonical；
 * - 首条消息被压缩 summary 替换（或为空）：配置下只登记过一个分支时
 *   alias 回该分支（跨压缩稳定）；已登记多个分支（同配置兄弟上下文）
 *   时无证据指向哪个分支，禁止 alias 到 canonical，退化为以 summary
 *   自身指纹为独立新分支，避免把 B 的请求/SKILL 状态串到 A。
 */
class AgentContextResolver {
  constructor(options = {}) {
    const cacheSize = parsePositiveInteger(
      options.cacheSize ?? process.env.PROMPT_LOG_CACHE_SIZE,
      DEFAULT_RESOLVER_CACHE_SIZE
    )
    this.cacheTtlMs = parsePositiveInteger(
      options.cacheTtlMs ?? process.env.PROMPT_LOG_CACHE_TTL_MS,
      DEFAULT_RESOLVER_CACHE_TTL_MS
    )
    this.cache = options.cache || new LRUCache(cacheSize)
  }

  resolve(requestBody = {}, scopeKey = null) {
    const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : []
    const systemText = extractSystemText(requestBody)
    const firstUserText = extractFirstUserMessageText(requestBody?.messages)

    const systemPromptHash = systemText ? componentFingerprint(systemText) : null
    const toolSchemaHash = tools.length > 0 ? componentFingerprint(tools) : null
    const rawFirstUserHash = firstUserText ? componentFingerprint(firstUserText) : null

    if (!scopeKey || (!systemPromptHash && !toolSchemaHash && !rawFirstUserHash)) {
      return buildResult(systemPromptHash, toolSchemaHash, rawFirstUserHash)
    }

    const baseKey = `sys:${systemPromptHash || '-'}|tools:${toolSchemaHash || '-'}`
    const cacheKey = `${scopeKey}\u0000${baseKey}`
    const entry = this.cache.get(cacheKey)

    let effectiveFirstHash = rawFirstUserHash
    if (rawFirstUserHash && !isContinuationSummaryText(firstUserText)) {
      // 首条消息仍是原始 Prompt：登记为该配置的分支（兄弟分支各自保留
      // 自己的指纹，不覆盖 canonical）
      const branchHashes = entry ? { ...entry.branchHashes } : {}
      if (
        !(rawFirstUserHash in branchHashes) &&
        Object.keys(branchHashes).length < MAX_BRANCHES_PER_BASE
      ) {
        branchHashes[rawFirstUserHash] = true
      }
      const nextEntry = {
        canonicalFirstHash: entry?.canonicalFirstHash || rawFirstUserHash,
        branchHashes
      }
      this.cache.set(cacheKey, nextEntry, this.cacheTtlMs)
    } else if (entry?.canonicalFirstHash && Object.keys(entry.branchHashes).length === 1) {
      // summary 替换首消息且配置下只有一个已登记分支：alias 到 canonical
      effectiveFirstHash = entry.canonicalFirstHash
      this.cache.set(cacheKey, entry, this.cacheTtlMs)
    } else {
      // 无登记分支，或同配置已存在多个兄弟分支：无证据 alias，退化为以
      // summary 自身指纹（或空）为独立分支
    }

    return buildResult(systemPromptHash, toolSchemaHash, effectiveFirstHash)
  }

  getCacheStats() {
    return this.cache.getStats()
  }
}

const defaultAgentContextResolver = new AgentContextResolver()

module.exports = {
  AGENT_CONTEXT_ID_LENGTH,
  COMPONENT_HASH_LENGTH,
  MAX_BRANCHES_PER_BASE,
  AgentContextResolver,
  defaultAgentContextResolver,
  deriveAgentContext,
  extractFirstUserMessageText,
  extractSystemText,
  isContinuationSummaryText
}
