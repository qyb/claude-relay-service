const {
  normalizeConcurrencyLimitMultiple,
  normalizePromotionModels,
  isPromotionModel,
  getEffectiveConcurrencyLimit,
  getPeakConcurrencyOverride,
  resolvePeakConcurrencyPolicy,
  formatPeakTrafficWindow,
  formatPeakTrafficResumeTime,
  formatPeakTrafficRecommendation
} = require('../src/utils/concurrencyLimitMultiple')

describe('concurrency limit multiple', () => {
  test.each([
    [100, 100],
    [50, 50],
    [0, 0],
    [undefined, 100],
    [-1, 100],
    [101, 100]
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeConcurrencyLimitMultiple(input)).toBe(expected)
  })

  test.each([
    [1, 50, 1],
    [3, 50, 2],
    [5, 50, 3],
    [100, 7, 7],
    [5, 100, 5],
    [5, 0, 0]
  ])('uses ceil for limit %p at %p%%', (limit, multiple, expected) => {
    expect(getEffectiveConcurrencyLimit(limit, multiple)).toBe(expected)
  })

  test('returns the retry delay during the UTC+8 peak window', () => {
    const override = getPeakConcurrencyOverride(new Date('2026-08-24T07:30:00.000Z'))

    expect(override).toEqual({ retryAfterSeconds: 5400 })
  })

  test.each(['2026-08-24T06:59:59.000Z', '2026-08-24T09:00:00.000Z'])(
    'does not override outside the peak window: %s',
    (date) => {
      expect(getPeakConcurrencyOverride(new Date(date))).toBeNull()
    }
  )

  test('derives displayed peak times from the shared window definition', () => {
    const window = { timeZone: 'Asia/Shanghai', startHour: 13, endHour: 16 }

    expect(formatPeakTrafficWindow(window)).toBe('13:00–16:00（UTC+8）')
    expect(formatPeakTrafficResumeTime(window)).toBe('16:00（UTC+8）')
  })

  test('normalizes and deduplicates promotion models', () => {
    expect(
      normalizePromotionModels([' promotionmodel1 ', 'PromotionModel1', '', 'promotionmodel2'])
    ).toEqual(['promotionmodel1', 'promotionmodel2'])
  })

  test('matches promotion models exactly and case-insensitively', () => {
    expect(isPromotionModel(' PROMOTIONMODEL1 ', ['promotionmodel1'])).toBe(true)
    expect(isPromotionModel('promotionmodel1-latest', ['promotionmodel1'])).toBe(false)
  })

  test('promotion models use the original concurrency limit during the peak window', () => {
    const policy = resolvePeakConcurrencyPolicy({
      now: new Date('2026-08-24T07:30:00.000Z'),
      configuredMultiple: 0,
      requestedModel: 'promotionmodel1',
      promotionModels: ['promotionmodel1', 'promotionmodel2']
    })

    expect(policy.concurrencyLimitMultiple).toBe(100)
    expect(policy.promotionModel).toBe(true)
    expect(policy.peakConcurrencyOverride).not.toBeNull()
  })

  test('other models still use the configured multiple during the peak window', () => {
    const policy = resolvePeakConcurrencyPolicy({
      now: new Date('2026-08-24T07:30:00.000Z'),
      configuredMultiple: 25,
      requestedModel: 'regular-model',
      promotionModels: ['promotionmodel1', 'promotionmodel2']
    })

    expect(policy.concurrencyLimitMultiple).toBe(25)
    expect(policy.promotionModel).toBe(false)
    expect(formatPeakTrafficRecommendation(policy.promotionModels)).toBe(
      '高峰期限流, 仅推荐使用 promotionmodel1, promotionmodel2。'
    )
  })
})
