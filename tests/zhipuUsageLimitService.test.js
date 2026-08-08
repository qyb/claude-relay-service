jest.mock('../src/services/claudeConsoleAccountService', () => ({
  getAllAccounts: jest.fn(),
  getAccount: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getZhipuUsageLimits: jest.fn(),
  setZhipuUsageLimits: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const {
  ZhipuUsageLimitService,
  ZhipuUsageLimitError
} = require('../src/services/zhipuUsageLimitService')
const { ZHIPU_QUOTA_URL, ZHIPU_SUBSCRIPTION_URL } = require('../src/utils/zhipuUsageLimits')

describe('ZhipuUsageLimitService', () => {
  const nowMs = Date.parse('2026-08-08T07:16:26.000Z')

  const buildDependencies = () => {
    const redis = {
      getZhipuUsageLimits: jest.fn().mockResolvedValue(null),
      setZhipuUsageLimits: jest.fn().mockResolvedValue(undefined)
    }
    const accountService = {
      getAllAccounts: jest.fn().mockResolvedValue([]),
      getAccount: jest.fn().mockResolvedValue({
        id: 'account-1',
        platform: 'claude-console',
        apiUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'synthetic-test-key',
        proxy: null
      })
    }
    const httpClient = { get: jest.fn() }
    const proxyHelper = { createProxyAgent: jest.fn().mockReturnValue(null) }
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const service = new ZhipuUsageLimitService({
      redis,
      accountService,
      httpClient,
      proxyHelper,
      logger,
      now: () => nowMs
    })
    return { service, redis, accountService, httpClient, proxyHelper, logger }
  }

  const quotaBody = {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
        {
          type: 'TOKENS_LIMIT',
          unit: 6,
          number: 1,
          percentage: 66,
          nextResetTime: 1786518986997
        }
      ]
    }
  }

  test('returns a fresh cached snapshot without querying Zhipu', async () => {
    const { service, redis, httpClient } = buildDependencies()
    redis.getZhipuUsageLimits.mockResolvedValue({
      accountId: 'account-1',
      provider: 'zhipu',
      plan: 'Cached Plan',
      status: 'ok',
      updatedAt: '2026-08-08T07:15:00.000Z',
      freshUntil: '2026-08-08T07:20:00.000Z',
      windows: [{ kind: 'weekly', usedPercent: 60 }],
      errorCode: null,
      errorMessage: null
    })

    const result = await service.getUsageLimits('account-1')

    expect(result).toMatchObject({ source: 'cache', stale: false, plan: 'Cached Plan' })
    expect(httpClient.get).not.toHaveBeenCalled()
  })

  test('queries quota and subscription, then caches normalized data', async () => {
    const { service, redis, httpClient, proxyHelper } = buildDependencies()
    httpClient.get.mockResolvedValueOnce({ status: 200, data: quotaBody }).mockResolvedValueOnce({
      status: 200,
      data: { data: [{ product_name: 'GLM Coding Max' }] }
    })

    const result = await service.getUsageLimits('account-1')

    expect(result).toMatchObject({
      accountId: 'account-1',
      provider: 'zhipu',
      plan: 'GLM Coding Max',
      status: 'ok',
      source: 'api',
      stale: false,
      freshUntil: '2026-08-08T07:21:26.000Z'
    })
    expect(result.windows.map((window) => window.kind)).toEqual(['session', 'weekly'])
    expect(httpClient.get).toHaveBeenNthCalledWith(
      1,
      ZHIPU_QUOTA_URL,
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer synthetic-test-key',
          Accept: 'application/json'
        },
        timeout: 12000
      })
    )
    expect(httpClient.get).toHaveBeenNthCalledWith(2, ZHIPU_SUBSCRIPTION_URL, expect.any(Object))
    expect(proxyHelper.createProxyAgent).toHaveBeenCalledWith(null)
    expect(redis.setZhipuUsageLimits).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ status: 'ok' }),
      86400
    )
    const cachedSnapshot = redis.setZhipuUsageLimits.mock.calls[0][1]
    expect(cachedSnapshot).not.toHaveProperty('source')
    expect(cachedSnapshot).not.toHaveProperty('stale')
  })

  test('keeps quota data when the optional subscription request fails', async () => {
    const { service, httpClient } = buildDependencies()
    httpClient.get
      .mockResolvedValueOnce({ status: 200, data: quotaBody })
      .mockRejectedValueOnce(new Error('subscription unavailable'))

    const result = await service.getUsageLimits('account-1')

    expect(result.status).toBe('ok')
    expect(result.plan).toBeNull()
    expect(result.windows).toHaveLength(2)
  })

  test('returns a stale snapshot when forced refresh is rate limited', async () => {
    const { service, redis, httpClient } = buildDependencies()
    redis.getZhipuUsageLimits.mockResolvedValue({
      accountId: 'account-1',
      provider: 'zhipu',
      plan: 'Old Plan',
      status: 'ok',
      updatedAt: '2026-08-08T06:00:00.000Z',
      freshUntil: '2026-08-08T06:05:00.000Z',
      windows: [{ kind: 'weekly', usedPercent: 60 }],
      errorCode: null,
      errorMessage: null
    })
    httpClient.get.mockRejectedValue({ response: { status: 429 } })

    const result = await service.getUsageLimits('account-1', { forceRefresh: true })

    expect(result).toMatchObject({
      status: 'rate_limited',
      source: 'cache',
      stale: true,
      errorCode: 'rate_limited',
      plan: 'Old Plan'
    })
    expect(result.windows).toHaveLength(1)
    expect(redis.setZhipuUsageLimits).not.toHaveBeenCalled()
  })

  test.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'unavailable']
  ])('maps upstream HTTP %s to %s without a cache', async (httpStatus, expectedStatus) => {
    const { service, httpClient } = buildDependencies()
    httpClient.get.mockRejectedValue({ response: { status: httpStatus } })

    const result = await service.getUsageLimits('account-1', { forceRefresh: true })

    expect(result).toMatchObject({
      status: expectedStatus,
      source: 'none',
      stale: false,
      windows: [],
      errorCode: expectedStatus
    })
  })

  test('rejects missing and non-Zhipu accounts with typed errors', async () => {
    const { service, accountService } = buildDependencies()
    accountService.getAccount.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'account-2',
      platform: 'claude-console',
      apiUrl: 'https://api.example.com',
      apiKey: 'synthetic-test-key'
    })

    await expect(service.getUsageLimits('missing')).rejects.toMatchObject({
      code: 'account_not_found',
      statusCode: 404
    })
    await expect(service.getUsageLimits('account-2')).rejects.toMatchObject({
      code: 'not_applicable',
      statusCode: 422
    })
    expect(ZhipuUsageLimitError).toBeDefined()
  })

  test('batch query includes only applicable accounts and isolates failures', async () => {
    const { service, accountService } = buildDependencies()
    accountService.getAllAccounts.mockResolvedValue([
      {
        id: 'zhipu-1',
        apiUrl: 'https://open.bigmodel.cn/api/anthropic'
      },
      { id: 'other-1', apiUrl: 'https://api.example.com' },
      {
        id: 'zhipu-2',
        apiUrl: 'https://open.bigmodel.cn/api/anthropic/'
      }
    ])
    jest
      .spyOn(service, 'getUsageLimits')
      .mockResolvedValueOnce({ accountId: 'zhipu-1', status: 'ok' })
      .mockRejectedValueOnce(new Error('boom'))

    const result = await service.getAllUsageLimits()

    expect(service.getUsageLimits).toHaveBeenCalledTimes(2)
    expect(result['zhipu-1']).toEqual({ accountId: 'zhipu-1', status: 'ok' })
    expect(result['zhipu-2']).toMatchObject({
      accountId: 'zhipu-2',
      status: 'unavailable',
      source: 'none'
    })
    expect(result['other-1']).toBeUndefined()
  })
})
