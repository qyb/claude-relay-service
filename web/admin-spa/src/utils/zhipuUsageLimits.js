const ZHIPU_HOSTNAME = 'open.bigmodel.cn'
const ZHIPU_ANTHROPIC_PATH = '/api/anthropic'
const WINDOW_ORDER = ['session', 'weekly', 'mcp']

export const ZHIPU_WINDOW_META = {
  session: {
    label: '5h',
    badgeClass: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300',
    barClass: 'bg-gradient-to-r from-indigo-500 to-blue-500'
  },
  weekly: {
    label: '周限',
    badgeClass: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300',
    barClass: 'bg-gradient-to-r from-emerald-500 to-teal-500'
  },
  mcp: {
    label: 'MCP',
    badgeClass: 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300',
    barClass: 'bg-gradient-to-r from-purple-500 to-fuchsia-500'
  }
}

export function isZhipuClaudeConsoleAccount(account) {
  if (account?.platform !== 'claude-console' || typeof account.apiUrl !== 'string') {
    return false
  }

  try {
    const parsed = new URL(account.apiUrl.trim())
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === ZHIPU_HOSTNAME &&
      (parsed.port === '' || parsed.port === '443') &&
      pathname === ZHIPU_ANTHROPIC_PATH &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

function clampPercent(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.max(0, Math.min(100, parsed))
}

export function normalizeZhipuUsageWindows(windows) {
  if (!Array.isArray(windows)) {
    return []
  }

  const byKind = new Map()
  for (const window of windows) {
    if (!window || !WINDOW_ORDER.includes(window.kind) || byKind.has(window.kind)) {
      continue
    }
    const usedPercent = clampPercent(window.usedPercent)
    if (usedPercent === null) {
      continue
    }
    const remainingPercent = clampPercent(window.remainingPercent)
    byKind.set(window.kind, {
      ...window,
      usedPercent,
      remainingPercent: remainingPercent ?? 100 - usedPercent
    })
  }

  return WINDOW_ORDER.map((kind) => byKind.get(kind)).filter(Boolean)
}

export function mergeZhipuUsageLimitMap(accounts, usageMap) {
  if (!Array.isArray(accounts) || !usageMap || typeof usageMap !== 'object') {
    return Array.isArray(accounts) ? accounts : []
  }

  return accounts.map((account) => {
    if (!isZhipuClaudeConsoleAccount(account)) {
      return account
    }
    if (!Object.prototype.hasOwnProperty.call(usageMap, account.id)) {
      return account
    }
    return { ...account, zhipuUsageLimits: usageMap[account.id] }
  })
}

export function formatZhipuResetRemaining(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) {
    return '--'
  }
  const resetMs = Date.parse(resetsAt)
  if (!Number.isFinite(resetMs)) {
    return '--'
  }

  let seconds = Math.max(0, Math.floor((resetMs - nowMs) / 1000))
  if (seconds === 0) {
    return '已到重置时间'
  }

  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)

  if (days > 0) {
    return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`
  }
  if (minutes > 0) {
    return `${minutes}分钟`
  }
  return `${seconds}秒`
}
