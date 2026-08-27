const PEAK_TRAFFIC_WINDOW = Object.freeze({
  timeZone: 'Asia/Shanghai',
  startHour: 15,
  endHour: 17
})

function getDateTimeParts(now, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
}

function normalizeConcurrencyLimitMultiple(value) {
  const multiple = Number(value)
  return Number.isFinite(multiple) && multiple >= 0 && multiple <= 100 ? multiple : 100
}

function normalizePromotionModels(value) {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set()
  return value.reduce((models, item) => {
    if (typeof item !== 'string') {
      return models
    }

    const model = item.trim()
    const normalizedModel = model.toLowerCase()
    if (!model || seen.has(normalizedModel)) {
      return models
    }

    seen.add(normalizedModel)
    models.push(model)
    return models
  }, [])
}

function isPromotionModel(requestedModel, promotionModels) {
  if (typeof requestedModel !== 'string') {
    return false
  }

  const normalizedRequestedModel = requestedModel.trim().toLowerCase()
  return (
    normalizedRequestedModel.length > 0 &&
    normalizePromotionModels(promotionModels).some(
      (model) => model.toLowerCase() === normalizedRequestedModel
    )
  )
}

function getEffectiveConcurrencyLimit(configuredLimit, multiple) {
  return Math.ceil((configuredLimit * multiple) / 100)
}

function formatPeakTrafficWindow(window = PEAK_TRAFFIC_WINDOW) {
  const timeZoneLabel = window.timeZone === 'Asia/Shanghai' ? 'UTC+8' : window.timeZone
  const formatHour = (hour) => `${String(hour).padStart(2, '0')}:00`
  return `${formatHour(window.startHour)}–${formatHour(window.endHour)}（${timeZoneLabel}）`
}

function formatPeakTrafficResumeTime(window = PEAK_TRAFFIC_WINDOW) {
  const timeZoneLabel = window.timeZone === 'Asia/Shanghai' ? 'UTC+8' : window.timeZone
  return `${String(window.endHour).padStart(2, '0')}:00（${timeZoneLabel}）`
}

function getPeakConcurrencyOverride(now = new Date(), window = PEAK_TRAFFIC_WINDOW) {
  const parts = getDateTimeParts(now, window.timeZone)
  const hour = Number(parts.hour)

  if (hour < window.startHour || hour >= window.endHour) {
    return null
  }

  // 当前唯一窗口为 UTC+8；该时区没有夏令时。
  const utcEndHour = window.endHour - 8
  const peakEndAt = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    utcEndHour
  )
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((peakEndAt - now.getTime()) / 1000))
  }
}

function resolvePeakConcurrencyPolicy({
  now = new Date(),
  window = PEAK_TRAFFIC_WINDOW,
  configuredMultiple,
  requestedModel,
  promotionModels
} = {}) {
  const peakConcurrencyOverride = getPeakConcurrencyOverride(now, window)
  const normalizedPromotionModels = normalizePromotionModels(promotionModels)
  const promotionModel =
    peakConcurrencyOverride !== null && isPromotionModel(requestedModel, normalizedPromotionModels)
  const concurrencyLimitMultiple =
    peakConcurrencyOverride && !promotionModel
      ? normalizeConcurrencyLimitMultiple(configuredMultiple)
      : 100

  return {
    peakConcurrencyOverride,
    concurrencyLimitMultiple,
    promotionModel,
    promotionModels: normalizedPromotionModels
  }
}

function formatPeakTrafficRecommendation(promotionModels) {
  const normalizedPromotionModels = normalizePromotionModels(promotionModels)
  return normalizedPromotionModels.length > 0
    ? `高峰期限流, 仅推荐使用 ${normalizedPromotionModels.join(', ')}。`
    : '高峰期限流。'
}

module.exports = {
  PEAK_TRAFFIC_WINDOW,
  normalizeConcurrencyLimitMultiple,
  normalizePromotionModels,
  isPromotionModel,
  getEffectiveConcurrencyLimit,
  getPeakConcurrencyOverride,
  resolvePeakConcurrencyPolicy,
  formatPeakTrafficWindow,
  formatPeakTrafficResumeTime,
  formatPeakTrafficRecommendation
}
