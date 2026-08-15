jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const pricingService = require('../src/services/pricingService')
const CostCalculator = require('../src/utils/costCalculator')
const logger = require('../src/utils/logger')
const regionalPricingConfig = require('../config/pricing/model-pricing.json')

describe('regional model pricing', () => {
  beforeEach(() => {
    pricingService.pricingData = {}
    pricingService.missingPricingCounts.clear()
    logger.warn.mockClear()
  })

  it('uses CN GLM-5-Turbo tier at the 32K boundary', () => {
    const below = pricingService.getModelPricing('glm-5-turbo', {
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      usage: { input_tokens: 31999, output_tokens: 1 }
    })
    const at = pricingService.getModelPricing('glm-5-turbo', {
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      usage: { input_tokens: 32000, output_tokens: 1 }
    })

    expect(below.input_cost_per_token).toBeCloseTo((5 * 0.1483) / 1000000)
    expect(at.input_cost_per_token).toBeCloseTo((7 * 0.1483) / 1000000)
  })

  it('uses GLM-4.7 output tier at 0.2M tokens', () => {
    const pricing = pricingService.getModelPricing('glm-4.7', {
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      usage: { input_tokens: 1000, output_tokens: 200000 }
    })

    expect(pricing.input_cost_per_token).toBeCloseTo((3 * 0.1483) / 1000000)
    expect(pricing.output_cost_per_token).toBeCloseTo((14 * 0.1483) / 1000000)
  })

  it('uses glm-5.2 pricing as provisional pricing for glm-5.3', () => {
    const result = pricingService.calculateCost(
      { input_tokens: 1000000, output_tokens: 0 },
      'glm-5.3',
      { apiUrl: 'https://api.z.ai/api/anthropic' }
    )

    expect(result.hasPricing).toBe(true)
    expect(result.pricing_model).toBe('glm-5.2')
    expect(result.provisionalPricing).toBe(true)
    expect(result.totalCost).toBeCloseTo(1.4)
  })

  it('returns zero cost for an unknown regional model', () => {
    const result = CostCalculator.calculateCost(
      { input_tokens: 1000000, output_tokens: 0 },
      'glm-not-configured',
      { apiUrl: 'https://open.bigmodel.cn/api/anthropic' }
    )

    expect(result.hasPricing).toBe(false)
    expect(result.costs.total).toBe(0)
  })

  it('does not fall through to LiteLLM when a covered model misses its regional tier', () => {
    pricingService.pricingData = {
      'deepinfra/zai-org/GLM-4.5-Air': {
        input_cost_per_token: 0.0000002,
        output_cost_per_token: 0.0000011,
        litellm_provider: 'deepinfra'
      }
    }

    const result = CostCalculator.calculateCost(
      { input_tokens: 128000, output_tokens: 1 },
      'glm-4.5-air',
      { apiUrl: 'https://open.bigmodel.cn/api/anthropic' }
    )

    expect(result.hasPricing).toBe(false)
    expect(result.costs.total).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Regional pricing unavailable')
    )
    expect(pricingService.missingPricingCounts.get('cn:glm-4.5-air')).toBe(1)
  })

  it('treats a covered model without region information as missing pricing', () => {
    pricingService.pricingData = {
      'deepinfra/zai-org/GLM-4.5-Air': {
        input_cost_per_token: 0.0000002,
        output_cost_per_token: 0.0000011,
        litellm_provider: 'deepinfra'
      }
    }

    const result = CostCalculator.calculateCost(
      { input_tokens: 1000, output_tokens: 1 },
      'glm-4.5-air'
    )

    expect(result.hasPricing).toBe(false)
    expect(result.costs.total).toBe(0)
    expect(pricingService.missingPricingCounts.get('unknown:glm-4.5-air')).toBe(1)
  })

  it('validates configured tiers and rejects overlapping ranges', () => {
    expect(() => pricingService.validateRegionalPricingData(regionalPricingConfig)).not.toThrow()

    const invalidConfig = {
      reporting_currency: 'USD',
      exchange_rates: { USD: { to_reporting: 1 } },
      models: {
        test: {
          intl: {
            currency: 'USD',
            tiers: [
              { when: { input_length: { lt: 100 } }, input: 1, cached: 0, output: 1 },
              { when: { input_length: { gte: 50 } }, input: 1, cached: 0, output: 1 }
            ]
          }
        }
      }
    }

    expect(() => pricingService.validateRegionalPricingData(invalidConfig)).toThrow(
      'Overlapping tiers'
    )
  })
})
