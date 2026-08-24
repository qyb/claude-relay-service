const {
  normalizeConcurrencyLimitMultiple,
  getEffectiveConcurrencyLimit,
  getPeakConcurrencyOverride,
  formatPeakTrafficWindow,
  formatPeakTrafficResumeTime
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
})
