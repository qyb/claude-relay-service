const axios = require('axios')
const redis = require('../models/redis')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const ProxyHelper = require('../utils/proxyHelper')
const logger = require('../utils/logger')
const {
  ZHIPU_QUOTA_URL,
  ZHIPU_SUBSCRIPTION_URL,
  isZhipuClaudeConsoleEndpoint,
  parseZhipuUsageLimits
} = require('../utils/zhipuUsageLimits')

const FRESH_TTL_MS = 5 * 60 * 1000
const CACHE_RETENTION_SECONDS = 24 * 60 * 60
const FETCH_TIMEOUT_MS = 12_000
const BATCH_CONCURRENCY = 5

const ERROR_MESSAGES = {
  unauthorized: 'Zhipu API Key 无效或无权查询限额',
  rate_limited: 'Zhipu 限额查询接口暂时限流',
  unavailable: 'Zhipu 限额查询接口暂时不可用'
}

class ZhipuUsageLimitError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'ZhipuUsageLimitError'
    this.code = code
    this.statusCode = statusCode
  }
}

class ZhipuUsageLimitService {
  constructor(options = {}) {
    this.redis = options.redis || redis
    this.accountService = options.accountService || claudeConsoleAccountService
    this.httpClient = options.httpClient || axios
    this.proxyHelper = options.proxyHelper || ProxyHelper
    this.logger = options.logger || logger
    this.now = options.now || Date.now
    this.fetchTimeoutMs = options.fetchTimeoutMs || FETCH_TIMEOUT_MS
    this.freshTtlMs = options.freshTtlMs || FRESH_TTL_MS
    this.cacheRetentionSeconds = options.cacheRetentionSeconds || CACHE_RETENTION_SECONDS
    this.batchConcurrency = options.batchConcurrency || BATCH_CONCURRENCY
  }

  async getAllUsageLimits() {
    const accounts = await this.accountService.getAllAccounts()
    const applicable = accounts.filter((account) => isZhipuClaudeConsoleEndpoint(account?.apiUrl))

    const rows = await this._mapWithConcurrency(applicable, this.batchConcurrency, (account) =>
      this.getUsageLimits(account.id)
    )

    const result = {}
    for (const row of rows) {
      if (row?.accountId) {
        result[row.accountId] = row
      }
    }
    return result
  }

  async getUsageLimits(accountId, options = {}) {
    const forceRefresh = options.forceRefresh === true
    const account = await this.accountService.getAccount(accountId)
    if (!account) {
      throw new ZhipuUsageLimitError('account_not_found', 'Account not found', 404)
    }
    if (!isZhipuClaudeConsoleEndpoint(account.apiUrl)) {
      throw new ZhipuUsageLimitError(
        'not_applicable',
        '该账户不是受支持的 Zhipu Claude Console endpoint',
        422
      )
    }

    const cached = await this.redis.getZhipuUsageLimits(accountId)
    if (!forceRefresh && this._isFresh(cached)) {
      return this._fromCache(cached, false)
    }

    const fetched = await this._fetchUsageLimits(account)
    if (fetched.status === 'ok') {
      const updatedAtMs = this.now()
      const snapshot = {
        accountId,
        provider: 'zhipu',
        plan: fetched.plan,
        status: 'ok',
        updatedAt: new Date(updatedAtMs).toISOString(),
        freshUntil: new Date(updatedAtMs + this.freshTtlMs).toISOString(),
        windows: fetched.windows,
        errorCode: null,
        errorMessage: null
      }
      await this.redis.setZhipuUsageLimits(accountId, snapshot, this.cacheRetentionSeconds)
      return { ...snapshot, source: 'api', stale: false }
    }

    if (cached?.accountId && Array.isArray(cached.windows) && cached.windows.length > 0) {
      return {
        ...cached,
        status: fetched.status,
        source: 'cache',
        stale: true,
        errorCode: fetched.status,
        errorMessage: ERROR_MESSAGES[fetched.status]
      }
    }

    return {
      accountId,
      provider: 'zhipu',
      plan: null,
      status: fetched.status,
      source: 'none',
      stale: false,
      updatedAt: null,
      freshUntil: null,
      windows: [],
      errorCode: fetched.status,
      errorMessage: ERROR_MESSAGES[fetched.status]
    }
  }

  _isFresh(snapshot) {
    if (!snapshot?.freshUntil) {
      return false
    }
    const freshUntil = Date.parse(snapshot.freshUntil)
    return Number.isFinite(freshUntil) && freshUntil > this.now()
  }

  _fromCache(snapshot, stale) {
    return {
      ...snapshot,
      source: 'cache',
      stale,
      errorCode: stale ? snapshot.errorCode || 'unavailable' : null,
      errorMessage: stale ? snapshot.errorMessage || ERROR_MESSAGES.unavailable : null
    }
  }

  async _fetchUsageLimits(account) {
    if (!account.apiKey) {
      return { status: 'unauthorized', plan: null, windows: [] }
    }

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json'
      },
      timeout: this.fetchTimeoutMs
    }

    const proxyAgent = this.proxyHelper.createProxyAgent(account.proxyConfig || account.proxy)
    if (proxyAgent) {
      requestConfig.httpAgent = proxyAgent
      requestConfig.httpsAgent = proxyAgent
      requestConfig.proxy = false
    }

    let quotaResponse
    try {
      quotaResponse = await this.httpClient.get(ZHIPU_QUOTA_URL, requestConfig)
    } catch (error) {
      const status = this._normalizeRequestError(error)
      this._logRequestFailure(account.id, ZHIPU_QUOTA_URL, error?.response?.status, status)
      return { status, plan: null, windows: [] }
    }

    if (quotaResponse?.status !== 200) {
      const status = this._normalizeHttpStatus(quotaResponse?.status)
      this._logRequestFailure(account.id, ZHIPU_QUOTA_URL, quotaResponse?.status, status)
      return { status, plan: null, windows: [] }
    }

    let subscriptionBody = null
    try {
      const subscriptionResponse = await this.httpClient.get(ZHIPU_SUBSCRIPTION_URL, requestConfig)
      if (subscriptionResponse?.status === 200) {
        subscriptionBody = subscriptionResponse.data
      } else {
        this._logRequestFailure(
          account.id,
          ZHIPU_SUBSCRIPTION_URL,
          subscriptionResponse?.status,
          this._normalizeHttpStatus(subscriptionResponse?.status)
        )
      }
    } catch (error) {
      this._logRequestFailure(
        account.id,
        ZHIPU_SUBSCRIPTION_URL,
        error?.response?.status,
        this._normalizeRequestError(error)
      )
    }

    const parsed = parseZhipuUsageLimits(quotaResponse.data, subscriptionBody)
    if (!parsed.windows.length) {
      return { status: 'unavailable', plan: parsed.plan, windows: [] }
    }

    return { status: 'ok', plan: parsed.plan, windows: parsed.windows }
  }

  _normalizeRequestError(error) {
    return this._normalizeHttpStatus(error?.response?.status)
  }

  _normalizeHttpStatus(httpStatus) {
    if (httpStatus === 401 || httpStatus === 403) {
      return 'unauthorized'
    }
    if (httpStatus === 429) {
      return 'rate_limited'
    }
    return 'unavailable'
  }

  _logRequestFailure(accountId, url, httpStatus, status) {
    this.logger.warn('Zhipu usage limits request failed', {
      accountId,
      path: new URL(url).pathname,
      httpStatus: httpStatus || null,
      status
    })
  }

  async _mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length)
    let nextIndex = 0

    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        try {
          results[index] = await mapper(items[index], index)
        } catch (error) {
          const accountId = items[index]?.id
          this.logger.warn('Failed to load Zhipu usage limits for account', {
            accountId,
            code: error?.code || 'unavailable'
          })
          if (accountId) {
            results[index] = {
              accountId,
              provider: 'zhipu',
              plan: null,
              status: 'unavailable',
              source: 'none',
              stale: false,
              updatedAt: null,
              freshUntil: null,
              windows: [],
              errorCode: 'unavailable',
              errorMessage: ERROR_MESSAGES.unavailable
            }
          }
        }
      }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
  }
}

const zhipuUsageLimitService = new ZhipuUsageLimitService()

module.exports = zhipuUsageLimitService
module.exports.ZhipuUsageLimitService = ZhipuUsageLimitService
module.exports.ZhipuUsageLimitError = ZhipuUsageLimitError
module.exports.constants = {
  FRESH_TTL_MS,
  CACHE_RETENTION_SECONDS,
  FETCH_TIMEOUT_MS,
  BATCH_CONCURRENCY
}
