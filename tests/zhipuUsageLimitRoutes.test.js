const express = require('express')
const request = require('supertest')

jest.mock('../src/services/zhipuUsageLimitService', () => ({
  getAllUsageLimits: jest.fn(),
  getUsageLimits: jest.fn()
}))

jest.mock('../src/services/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => {
    if (req.get('x-test-admin') === 'allowed') {
      return next()
    }
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
}))

const zhipuUsageLimitService = require('../src/services/zhipuUsageLimitService')
const claudeConsoleAccountsRouter = require('../src/routes/admin/claudeConsoleAccounts')

describe('Claude Console Zhipu usage limits routes', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/admin', claudeConsoleAccountsRouter)
  })

  test('requires admin authentication', async () => {
    const response = await request(app).get('/admin/claude-console-accounts/usage-limits')

    expect(response.status).toBe(401)
    expect(zhipuUsageLimitService.getAllUsageLimits).not.toHaveBeenCalled()
  })

  test('returns the batch usage-limit map', async () => {
    const data = {
      'account-1': {
        accountId: 'account-1',
        provider: 'zhipu',
        status: 'ok',
        source: 'cache',
        stale: false,
        windows: [{ kind: 'weekly', usedPercent: 66 }]
      }
    }
    zhipuUsageLimitService.getAllUsageLimits.mockResolvedValue(data)

    const response = await request(app)
      .get('/admin/claude-console-accounts/usage-limits')
      .set('x-test-admin', 'allowed')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data })
  })

  test('forces a refresh for one account', async () => {
    const data = {
      accountId: 'account-1',
      provider: 'zhipu',
      status: 'ok',
      source: 'api',
      stale: false,
      windows: [{ kind: 'session', usedPercent: 10 }]
    }
    zhipuUsageLimitService.getUsageLimits.mockResolvedValue(data)

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/usage-limits/refresh')
      .set('x-test-admin', 'allowed')
      .send({})

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data })
    expect(zhipuUsageLimitService.getUsageLimits).toHaveBeenCalledWith('account-1', {
      forceRefresh: true
    })
  })

  test.each([
    ['account_not_found', 404, 'Account not found'],
    ['not_applicable', 422, '该账户不是受支持的 Zhipu Claude Console endpoint']
  ])('maps %s refresh errors to HTTP %s', async (code, statusCode, message) => {
    zhipuUsageLimitService.getUsageLimits.mockRejectedValue(
      Object.assign(new Error(message), { code, statusCode })
    )

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/usage-limits/refresh')
      .set('x-test-admin', 'allowed')
      .send({})

    expect(response.status).toBe(statusCode)
    expect(response.body).toEqual({ success: false, error: message, code })
  })

  test('does not expose unexpected backend errors', async () => {
    zhipuUsageLimitService.getAllUsageLimits.mockRejectedValue(
      new Error('internal detail should stay private')
    )

    const response = await request(app)
      .get('/admin/claude-console-accounts/usage-limits')
      .set('x-test-admin', 'allowed')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: 'Failed to get Zhipu usage limits'
    })
    expect(JSON.stringify(response.body)).not.toContain('internal detail')
  })
})
