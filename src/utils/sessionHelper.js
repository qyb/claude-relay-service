/**
 * SessionHelper — Claude Code 会话 ID 提取与 sticky session 工具
 *
 * 提取优先级（与 Claude Code 源码保持一致）：
 *   1. Header  X-Claude-Code-Session-Id  （最精确）
 *   2. body.metadata.user_id JSON 解析，读取 session_id 字段
 *   3. 兼容旧格式：metadata.user_id 中匹配 session_<uuid> 尾部
 *   4. 内容 hash fallback（命名为 sticky_session_key，不是真实 session UUID）
 */

const crypto = require('crypto')
const logger = require('./logger')

class SessionHelper {
  /**
   * 从请求中提取客户端 session ID
   *
   * @param {Object} headers - req.headers
   * @param {Object} requestBody - req.body
   * @returns {{
   *   clientSessionId: string|null,
   *   source: 'header'|'metadata_json'|'legacy_pattern'|'none',
   *   stickySessionKey: string|null
   * }}
   */
  extractClientSessionId(headers, requestBody) {
    // --- 步骤 1：Header X-Claude-Code-Session-Id ---
    const headerSessionId =
      headers?.['x-claude-code-session-id'] || headers?.['X-Claude-Code-Session-Id']

    if (headerSessionId && this._isValidUuid(headerSessionId)) {
      const stickyKey = this._computeStickyKey(requestBody, headerSessionId)
      logger.debug(`[sessionHelper] session extracted from header: ${headerSessionId}`)
      return {
        clientSessionId: headerSessionId,
        source: 'header',
        stickySessionKey: stickyKey
      }
    }

    // --- 步骤 2：metadata.user_id JSON 解析 ---
    const userId = requestBody?.metadata?.user_id
    if (userId && typeof userId === 'string') {
      // Claude Code 当前格式：JSON 字符串，含 session_id 字段
      try {
        const parsed = JSON.parse(userId)
        if (
          parsed &&
          typeof parsed.session_id === 'string' &&
          this._isValidUuid(parsed.session_id)
        ) {
          const stickyKey = this._computeStickyKey(requestBody, parsed.session_id)
          logger.debug(`[sessionHelper] session extracted from metadata JSON: ${parsed.session_id}`)
          return {
            clientSessionId: parsed.session_id,
            source: 'metadata_json',
            stickySessionKey: stickyKey
          }
        }
      } catch (_) {
        // 不是 JSON，继续走 legacy 匹配
      }

      // --- 步骤 3：兼容旧格式 session_<uuid> 尾部匹配 ---
      const legacyMatch = userId.match(/session_([a-f0-9-]{36})/i)
      if (legacyMatch && legacyMatch[1]) {
        const sessionId = legacyMatch[1]
        const stickyKey = this._computeStickyKey(requestBody, sessionId)
        logger.debug(`[sessionHelper] session extracted from legacy pattern: ${sessionId}`)
        return {
          clientSessionId: sessionId,
          source: 'legacy_pattern',
          stickySessionKey: stickyKey
        }
      }
    }

    // --- 步骤 4：内容 hash fallback（仅用于 sticky routing，不代表真实 session UUID）---
    const stickyKey = this._computeContentHash(requestBody)
    logger.debug(`[sessionHelper] no session ID found, sticky_key=${stickyKey}`)
    return {
      clientSessionId: null,
      source: 'none',
      stickySessionKey: stickyKey
    }
  }

  /**
   * 生成会话哈希，兼容旧调用方（只需要 sticky key）
   * 优先使用精确的 clientSessionId，否则用内容 hash
   *
   * @param {Object} requestBody - req.body
   * @param {Object} [headers] - req.headers（可选，新调用方传入以获得精确 session）
   * @returns {string|null}
   */
  generateSessionHash(requestBody, headers) {
    const info = this.extractClientSessionId(headers || {}, requestBody)
    return info.stickySessionKey
  }

  // ─── 私有工具 ────────────────────────────────────────────────────

  /**
   * 计算 sticky routing key：
   * 有精确 session ID 时直接用它（保证同一会话路由到同一账户）；
   * 否则用内容 hash。
   */
  _computeStickyKey(requestBody, sessionId) {
    if (sessionId) {
      return sessionId
    }
    return this._computeContentHash(requestBody)
  }

  /**
   * 内容 hash fallback（与旧版 generateSessionHash 逻辑一致）
   * 优先 ephemeral cache_control 内容 → system → 首条消息
   */
  _computeContentHash(requestBody) {
    if (!requestBody || typeof requestBody !== 'object') {
      return null
    }

    const system = requestBody.system || ''
    const messages = requestBody.messages || []

    // 尝试提取 ephemeral cache_control 内容
    let cacheableContent = ''
    if (Array.isArray(system)) {
      for (const part of system) {
        if (part?.cache_control?.type === 'ephemeral') {
          cacheableContent += part.text || ''
        }
      }
    }
    // 保持旧版 fallback 行为：即使 system 已有 ephemeral 内容，只要 messages
    // 中也存在 cache breakpoint，仍追加第一条非空消息文本。
    for (const msg of messages) {
      const content = msg.content || ''
      let hasCacheControl = false
      if (Array.isArray(content)) {
        hasCacheControl = content.some((p) => p?.cache_control?.type === 'ephemeral')
      } else if (typeof content === 'string' && msg.cache_control?.type === 'ephemeral') {
        hasCacheControl = true
      }
      if (hasCacheControl) {
        for (const m of messages) {
          const text =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((p) => p.type === 'text')
                    .map((p) => p.text || '')
                    .join('')
                : ''
          if (text) {
            cacheableContent += text
            break
          }
        }
        break
      }
    }
    if (cacheableContent) {
      return this._sha256x32(cacheableContent)
    }

    // Fallback: system
    const systemText =
      typeof system === 'string'
        ? system
        : Array.isArray(system)
          ? system.map((p) => p.text || '').join('')
          : ''
    if (systemText) {
      return this._sha256x32(systemText)
    }

    // Fallback: 首条消息
    if (messages.length > 0) {
      const first = messages[0]
      const text =
        typeof first.content === 'string'
          ? first.content
          : Array.isArray(first.content)
            ? first.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text || '')
                .join('')
            : ''
      if (text) {
        return this._sha256x32(text)
      }
    }

    return null
  }

  _sha256x32(str) {
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 32)
  }

  _isValidUuid(str) {
    return (
      typeof str === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
    )
  }

  /**
   * 获取会话的Redis键名（兼容旧调用）
   */
  getSessionRedisKey(sessionHash) {
    return `sticky_session:${sessionHash}`
  }

  /**
   * 验证会话哈希格式（兼容旧调用）
   */
  isValidSessionHash(sessionHash) {
    return (
      typeof sessionHash === 'string' &&
      sessionHash.length === 32 &&
      /^[a-f0-9]{32}$/.test(sessionHash)
    )
  }
}

module.exports = new SessionHelper()
