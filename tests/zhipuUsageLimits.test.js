const {
  isZhipuClaudeConsoleEndpoint,
  parseZhipuUsageLimits
} = require('../src/utils/zhipuUsageLimits')

describe('zhipuUsageLimits', () => {
  describe('isZhipuClaudeConsoleEndpoint', () => {
    test.each([
      'https://open.bigmodel.cn/api/anthropic',
      'https://open.bigmodel.cn/api/anthropic/',
      'https://open.bigmodel.cn:443/api/anthropic'
    ])('accepts %s', (url) => {
      expect(isZhipuClaudeConsoleEndpoint(url)).toBe(true)
    })

    test.each([
      'http://open.bigmodel.cn/api/anthropic',
      'https://open.bigmodel.cn.evil.example/api/anthropic',
      'https://open.bigmodel.cn/api/anthropic/v1',
      'https://open.bigmodel.cn/api/anthropic?region=cn',
      'https://user:password@open.bigmodel.cn/api/anthropic',
      'not-a-url',
      ''
    ])('rejects %s', (url) => {
      expect(isZhipuClaudeConsoleEndpoint(url)).toBe(false)
    })
  })

  test('parses CREDIT_LIMIT session and weekly windows plus MCP', () => {
    const quota = {
      data: {
        limits: [
          {
            type: 'TIME_LIMIT',
            unit: 5,
            number: 1,
            usage: 4000,
            currentValue: 45,
            remaining: 3955,
            percentage: 1
          },
          {
            type: 'CREDIT_LIMIT',
            unit: 6,
            number: 1,
            percentage: '66',
            nextResetTime: 1786518986997
          },
          {
            type: 'CREDIT_LIMIT',
            unit: 3,
            number: 5,
            usage: '1000',
            current_value: '200',
            remaining: '800',
            next_reset_time: '1786086986.997'
          }
        ]
      }
    }
    const subscription = {
      data: [{ product_name: 'GLM Coding Max', next_renew_time: '2026-10-28' }]
    }

    const result = parseZhipuUsageLimits(quota, subscription)

    expect(result.plan).toBe('GLM Coding Max')
    expect(result.windows.map((window) => window.kind)).toEqual(['session', 'weekly', 'mcp'])

    expect(result.windows[0]).toMatchObject({
      upstreamType: 'CREDIT_LIMIT',
      windowMinutes: 300,
      total: 1000,
      used: 200,
      remaining: 800,
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: '2026-08-07T07:16:26.997Z'
    })
    expect(result.windows[1]).toMatchObject({
      upstreamType: 'CREDIT_LIMIT',
      windowMinutes: 10080,
      usedPercent: 66,
      remainingPercent: 34,
      resetsAt: '2026-08-12T07:16:26.997Z'
    })
    expect(result.windows[2]).toMatchObject({
      upstreamType: 'TIME_LIMIT',
      windowMinutes: null,
      total: 4000,
      used: 45,
      remaining: 3955,
      usedPercent: 1.125,
      remainingPercent: 98.875,
      resetsAt: '2026-10-28T00:00:00.000Z',
      resetCadence: 'monthly'
    })
  })

  test('parses TOKENS_LIMIT windows regardless of input order', () => {
    const result = parseZhipuUsageLimits({
      data: {
        plan_name: 'Coding Plan',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 75 },
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }
        ]
      }
    })

    expect(result.plan).toBe('Coding Plan')
    expect(result.windows).toHaveLength(2)
    expect(result.windows[0]).toMatchObject({ kind: 'session', usedPercent: 10 })
    expect(result.windows[1]).toMatchObject({ kind: 'weekly', usedPercent: 75 })
  })

  test('uses the longest token window as weekly when no session window exists', () => {
    const result = parseZhipuUsageLimits({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 1, number: 1, percentage: 25 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 50 }
        ]
      }
    })

    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]).toMatchObject({
      kind: 'weekly',
      windowMinutes: 10080,
      usedPercent: 50
    })
  })

  test('ignores unknown limits and values without a usable percentage', () => {
    const result = parseZhipuUsageLimits({
      data: {
        limits: [
          { type: 'UNKNOWN', percentage: 10 },
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 'invalid' },
          null
        ]
      }
    })

    expect(result).toEqual({ plan: null, windows: [] })
  })
})
