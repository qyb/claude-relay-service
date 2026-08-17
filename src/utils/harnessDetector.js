/**
 * Harness 识别 — 从请求头推断客户端 harness（claude-code / zcode / codex 等）。
 *
 * 识别优先级：显式 header（x-crs-harness / x-crs-harness-version）> User-Agent
 * 前缀指纹。prompt-log 与 telemetry 共用本模块，保证两条链路对同一请求
 * 给出相同的 harness 归因。
 */

const MAX_HARNESS_ID_LENGTH = 64
const MAX_HARNESS_VERSION_LENGTH = 64

const HARNESS_USER_AGENT_PATTERNS = [
  { regex: /^claude-cli\/([a-zA-Z0-9.-]+)/i, id: 'claude-code' },
  { regex: /^zcode\/([a-zA-Z0-9.-]+)(?:\s|$)/i, id: 'zcode' },
  { regex: /^codex_cli_rs\/([a-zA-Z0-9.-]+)/i, id: 'codex-cli' },
  { regex: /^codex_vscode\/([a-zA-Z0-9.-]+)/i, id: 'codex-vscode' },
  { regex: /^factory-cli\/([a-zA-Z0-9.-]+)/i, id: 'droid' }
]

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

function sanitizeToken(value, maxLength) {
  if (typeof value !== 'string') {
    return null
  }
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
  return sanitized ? sanitized.slice(0, maxLength) : null
}

function detectHarness(headers = {}) {
  const explicitId = sanitizeToken(getHeader(headers, 'x-crs-harness'), MAX_HARNESS_ID_LENGTH)
  const explicitVersion = sanitizeToken(
    getHeader(headers, 'x-crs-harness-version'),
    MAX_HARNESS_VERSION_LENGTH
  )

  if (explicitId) {
    return {
      harness_id: explicitId.toLowerCase(),
      harness_version: explicitVersion,
      harness_source: 'explicit_header'
    }
  }

  const userAgent = getHeader(headers, 'user-agent') || ''
  for (const pattern of HARNESS_USER_AGENT_PATTERNS) {
    const match = userAgent.match(pattern.regex)
    if (match) {
      return {
        harness_id: pattern.id,
        harness_version: sanitizeToken(match[1], MAX_HARNESS_VERSION_LENGTH),
        harness_source: 'user_agent'
      }
    }
  }

  return {
    harness_id: 'unknown',
    harness_version: null,
    harness_source: 'unknown'
  }
}

module.exports = {
  detectHarness,
  HARNESS_USER_AGENT_PATTERNS,
  MAX_HARNESS_ID_LENGTH,
  MAX_HARNESS_VERSION_LENGTH
}
