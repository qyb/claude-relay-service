const pricingService = require('./pricingService')
const CostCalculator = require('../utils/costCalculator')

const COST_STATUS = Object.freeze({
  RESOLVED: 'resolved',
  UNAVAILABLE: 'unavailable'
})

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hasUsage(usage = {}) {
  return (
    Number(usage.input_tokens || 0) > 0 ||
    Number(usage.output_tokens || 0) > 0 ||
    Number(usage.cache_creation_input_tokens || 0) > 0 ||
    Number(usage.cache_read_input_tokens || 0) > 0
  )
}

function hasRegionalPricing(model) {
  try {
    return Boolean(
      pricingService.getRegionalPricingCoverage(model) || pricingService.isRegionalModelName(model)
    )
  } catch (_error) {
    return false
  }
}

function hasPricingContext(pricingContext = {}) {
  return Boolean(pricingContext.apiUrl || pricingContext.region)
}

function readStoredCost(stored = {}, usage = {}) {
  const totalCost = toFiniteNumber(stored.costUsd)
  if (totalCost === null) {
    return null
  }

  const unavailableRequests = toFiniteNumber(stored.pricingUnavailableRequests) || 0
  const resolvedRequests = toFiniteNumber(stored.pricingResolvedRequests) || 0

  // 新数据明确记录了定价失败，不能把聚合值当成完整账单。
  if (unavailableRequests > 0) {
    return {
      source: 'stored',
      status: COST_STATUS.UNAVAILABLE,
      available: false,
      totalCost
    }
  }

  // 已明确成功计价，哪怕费用为 0 也必须保留为可信结果。
  if (resolvedRequests > 0 || totalCost !== 0 || !hasUsage(usage)) {
    return {
      source: 'stored',
      status: COST_STATUS.RESOLVED,
      available: true,
      totalCost
    }
  }

  // 兼容旧数据：costUsd=0 且有 token，但没有状态标记，无法判断是免费还是定价失败。
  return {
    source: 'stored',
    status: COST_STATUS.UNAVAILABLE,
    available: false,
    totalCost
  }
}

function getStoredOrCalculatedCost({
  usage = {},
  model = 'unknown',
  stored = null,
  pricingContext = {}
} = {}) {
  const storedResult = readStoredCost(stored || {}, usage)
  if (storedResult) {
    return storedResult
  }

  // 区域模型的历史聚合数据没有保存原始 apiUrl，不能事后猜测区域。
  if (hasRegionalPricing(model) && !hasPricingContext(pricingContext)) {
    return {
      source: 'unavailable',
      status: COST_STATUS.UNAVAILABLE,
      available: false,
      totalCost: 0
    }
  }

  const costData = CostCalculator.calculateCost(usage, model, pricingContext)
  const totalCost = toFiniteNumber(costData?.costs?.total) || 0
  const available = costData?.hasPricing === true

  return {
    source: 'calculated',
    status: available ? COST_STATUS.RESOLVED : COST_STATUS.UNAVAILABLE,
    available,
    totalCost,
    costData
  }
}

function pricingStatusFromResult(costResult, totalTokens) {
  if (Number(totalTokens || 0) <= 0 || costResult?.hasPricing === true) {
    return COST_STATUS.RESOLVED
  }
  return COST_STATUS.UNAVAILABLE
}

module.exports = {
  COST_STATUS,
  getStoredOrCalculatedCost,
  pricingStatusFromResult,
  readStoredCost
}
