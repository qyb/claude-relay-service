jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const billingCostService = require('../src/services/billingCostService')

describe('billing cost aggregation', () => {
  const usage = {
    input_tokens: 1000000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  }

  it('uses a persisted non-zero cost without recalculating it', () => {
    const result = billingCostService.getStoredOrCalculatedCost({
      usage,
      model: 'glm-5.3',
      stored: { costUsd: '1.2345' }
    })

    expect(result.source).toBe('stored')
    expect(result.status).toBe('resolved')
    expect(result.available).toBe(true)
    expect(result.totalCost).toBeCloseTo(1.2345)
  })

  it('does not treat a persisted zero with pricing failures as a resolved cost', () => {
    const result = billingCostService.getStoredOrCalculatedCost({
      usage,
      model: 'glm-5.3',
      stored: {
        costUsd: '0',
        pricingUnavailableRequests: '1'
      }
    })

    expect(result.source).toBe('stored')
    expect(result.status).toBe('unavailable')
    expect(result.available).toBe(false)
    expect(result.totalCost).toBe(0)
  })

  it('accepts a persisted zero when pricing was explicitly resolved', () => {
    const result = billingCostService.getStoredOrCalculatedCost({
      usage,
      model: 'glm-5.3',
      stored: {
        costUsd: '0',
        pricingResolvedRequests: '1'
      }
    })

    expect(result.status).toBe('resolved')
    expect(result.available).toBe(true)
    expect(result.totalCost).toBe(0)
  })

  it('does not invent regional pricing for legacy data without context', () => {
    const result = billingCostService.getStoredOrCalculatedCost({
      usage,
      model: 'glm-5.3'
    })

    expect(result.source).toBe('unavailable')
    expect(result.status).toBe('unavailable')
    expect(result.available).toBe(false)
  })

  it('calculates regional pricing when context is available', () => {
    const result = billingCostService.getStoredOrCalculatedCost({
      usage,
      model: 'glm-5.3',
      pricingContext: { apiUrl: 'https://api.z.ai/api/anthropic' }
    })

    expect(result.source).toBe('calculated')
    expect(result.status).toBe('resolved')
    expect(result.available).toBe(true)
    expect(result.totalCost).toBeCloseTo(1.4)
  })
})
