const ZHIPU_ANTHROPIC_URL = 'https://open.bigmodel.cn/api/anthropic'
const ZHIPU_QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const ZHIPU_SUBSCRIPTION_URL = 'https://open.bigmodel.cn/api/biz/subscription/list'

function isZhipuClaudeConsoleEndpoint(apiUrl) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    return false
  }

  try {
    const parsed = new URL(apiUrl.trim())
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'

    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'open.bigmodel.cn' &&
      (parsed.port === '' || parsed.port === '443') &&
      pathname === '/api/anthropic' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value) {
  const parsed = numberOrNull(value)
  if (parsed === null) {
    return null
  }
  return Math.max(0, Math.min(100, parsed))
}

function windowMinutes(unitValue, numberValue) {
  const unit = numberOrNull(unitValue)
  const number = numberOrNull(numberValue)
  if (unit === null || number === null || number <= 0) {
    return null
  }
  if (unit === 5) {
    return number
  }
  if (unit === 3) {
    return number * 60
  }
  if (unit === 1) {
    return number * 24 * 60
  }
  if (unit === 6) {
    return number * 7 * 24 * 60
  }
  return null
}

function toIso(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = numberOrNull(value)
  const date =
    numeric !== null && /^\s*[-+]?\d+(?:\.\d+)?\s*$/.test(String(value))
      ? new Date(numeric < 20_000_000_000 ? numeric * 1000 : numeric)
      : new Date(String(value))

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function usageValues(limit) {
  const total = numberOrNull(limit?.usage)
  const remaining = numberOrNull(limit?.remaining)
  const currentValue = numberOrNull(limit?.currentValue ?? limit?.current_value)
  let used = null
  let usedPercent = null

  if (total !== null && total > 0) {
    if (remaining !== null) {
      used = total - remaining
    }
    if (currentValue !== null) {
      used = used === null ? currentValue : Math.max(used, currentValue)
    }
    if (used !== null) {
      used = Math.max(0, Math.min(total, used))
      usedPercent = (used / total) * 100
    }
  }

  if (usedPercent === null) {
    usedPercent = clampPercent(limit?.percentage ?? limit?.usedPercent ?? limit?.used_percent)
  }

  if (usedPercent === null) {
    return null
  }

  usedPercent = Math.max(0, Math.min(100, usedPercent))
  return {
    total,
    used,
    remaining,
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent))
  }
}

function firstSubscription(subscriptionBody) {
  const rows = Array.isArray(subscriptionBody?.data) ? subscriptionBody.data : []
  return rows.find((row) => row && typeof row === 'object') || null
}

function firstTextField(source, fields) {
  if (!source || typeof source !== 'object') {
    return null
  }
  for (const field of fields) {
    const value = String(source[field] || '').trim()
    if (value) {
      return value
    }
  }
  return null
}

function planFromResponses(quotaBody, subscriptionBody) {
  const subscription = firstSubscription(subscriptionBody)
  const subscriptionPlan = firstTextField(subscription, [
    'product_name',
    'productName',
    'plan_name',
    'planName',
    'package_name',
    'packageName',
    'plan',
    'plan_type',
    'planType',
    'level'
  ])
  if (subscriptionPlan) {
    return subscriptionPlan
  }

  return firstTextField(quotaBody?.data, [
    'planName',
    'plan_name',
    'packageName',
    'package_name',
    'plan',
    'plan_type',
    'planType',
    'level'
  ])
}

function subscriptionResetAt(subscriptionBody) {
  const subscription = firstSubscription(subscriptionBody)
  return toIso(subscription?.next_renew_time ?? subscription?.nextRenewTime)
}

function normalizedWindow(limit, kind, options = {}) {
  const values = usageValues(limit)
  if (!values) {
    return null
  }

  const resetsAt =
    toIso(limit?.nextResetTime ?? limit?.next_reset_time) || options.fallbackResetAt || null

  return {
    kind,
    upstreamType: String(limit?.type || limit?.limit_type || '')
      .trim()
      .toUpperCase(),
    windowMinutes:
      options.includeWindowMinutes === false ? null : windowMinutes(limit?.unit, limit?.number),
    ...values,
    resetsAt,
    resetCadence: options.resetCadence || null
  }
}

function parseZhipuUsageLimits(quotaBody, subscriptionBody = null) {
  const limits = Array.isArray(quotaBody?.data?.limits) ? quotaBody.data.limits : []
  const tokenLimits = []
  let mcpLimit = null

  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') {
      continue
    }

    const type = String(limit.type || limit.limit_type || '')
      .trim()
      .toUpperCase()
    if (type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') {
      if (usageValues(limit)) {
        tokenLimits.push(limit)
      }
    } else if (type === 'TIME_LIMIT' && usageValues(limit)) {
      mcpLimit = limit
    }
  }

  tokenLimits.sort((left, right) => {
    const leftMinutes = windowMinutes(left.unit, left.number) ?? Number.MAX_SAFE_INTEGER
    const rightMinutes = windowMinutes(right.unit, right.number) ?? Number.MAX_SAFE_INTEGER
    return leftMinutes - rightMinutes
  })

  const sessionLimit = tokenLimits.find((limit) => {
    const minutes = windowMinutes(limit.unit, limit.number)
    return minutes !== null && minutes <= 6 * 60
  })
  const weeklyCandidates = tokenLimits.filter((limit) => limit !== sessionLimit)
  const weeklyLimit = weeklyCandidates.length
    ? weeklyCandidates[weeklyCandidates.length - 1]
    : sessionLimit
      ? null
      : tokenLimits[tokenLimits.length - 1] || null

  const windows = []
  const session = sessionLimit && normalizedWindow(sessionLimit, 'session')
  if (session) {
    windows.push(session)
  }

  const weekly = weeklyLimit && normalizedWindow(weeklyLimit, 'weekly')
  if (weekly) {
    windows.push(weekly)
  }

  const mcp =
    mcpLimit &&
    normalizedWindow(mcpLimit, 'mcp', {
      includeWindowMinutes: false,
      fallbackResetAt: subscriptionResetAt(subscriptionBody),
      resetCadence: 'monthly'
    })
  if (mcp) {
    windows.push(mcp)
  }

  return {
    plan: planFromResponses(quotaBody, subscriptionBody),
    windows
  }
}

module.exports = {
  ZHIPU_ANTHROPIC_URL,
  ZHIPU_QUOTA_URL,
  ZHIPU_SUBSCRIPTION_URL,
  isZhipuClaudeConsoleEndpoint,
  parseZhipuUsageLimits
}
