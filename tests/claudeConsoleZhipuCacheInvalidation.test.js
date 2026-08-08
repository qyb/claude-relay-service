jest.useFakeTimers()

const mockClient = {
  hset: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(1),
  sadd: jest.fn().mockResolvedValue(undefined),
  srem: jest.fn().mockResolvedValue(undefined)
}

jest.mock(
  '../config/config',
  () => ({
    security: { encryptionKey: 'unit-test-encryption-key' },
    system: { timezoneOffset: 8 },
    proxy: {}
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => mockClient),
  deleteZhipuUsageLimits: jest.fn().mockResolvedValue(1),
  getDateStringInTimezone: jest.fn(() => '2026-08-08')
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')
const claudeConsoleAccountService = require('../src/services/claudeConsoleAccountService')

describe('Claude Console Zhipu cache invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue({
      id: 'account-1',
      name: 'Zhipu account',
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      accountType: 'shared',
      isActive: true
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  test('clears the snapshot when apiUrl changes', async () => {
    await claudeConsoleAccountService.updateAccount('account-1', {
      apiUrl: 'https://api.example.com'
    })

    expect(mockClient.hset).toHaveBeenCalledWith(
      'claude_console_account:account-1',
      expect.objectContaining({ apiUrl: 'https://api.example.com' })
    )
    expect(redis.deleteZhipuUsageLimits).toHaveBeenCalledWith('account-1')
  })

  test('does not clear the snapshot for unrelated account changes', async () => {
    await claudeConsoleAccountService.updateAccount('account-1', { priority: 80 })

    expect(redis.deleteZhipuUsageLimits).not.toHaveBeenCalled()
  })

  test('clears the snapshot and redacts apiKey update logs', async () => {
    await claudeConsoleAccountService.updateAccount('account-1', {
      apiKey: 'synthetic-secret-key'
    })

    expect(redis.deleteZhipuUsageLimits).toHaveBeenCalledWith('account-1')
    const debugOutput = logger.debug.mock.calls.flat().join('\n')
    expect(debugOutput).toContain('[REDACTED]')
    expect(debugOutput).not.toContain('synthetic-secret-key')
  })

  test('deletes the account and its Zhipu snapshot together', async () => {
    await claudeConsoleAccountService.deleteAccount('account-1')

    expect(mockClient.del).toHaveBeenCalledWith(
      'claude_console_account:account-1',
      'zhipu_usage_limits:account-1'
    )
    expect(mockClient.srem).toHaveBeenCalledWith('shared_claude_console_accounts', 'account-1')
  })
})
