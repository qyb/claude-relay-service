const redis = require('../models/redis')
const apiKeyService = require('./apiKeyService')
const { getStoredOrCalculatedCost } = require('./billingCostService')
const logger = require('../utils/logger')

class CostInitService {
  /**
   * 初始化所有API Key的费用数据
   * 扫描历史使用记录并计算费用
   */
  async initializeAllCosts() {
    try {
      logger.info('💰 Starting cost initialization for all API Keys...')

      const apiKeys = await apiKeyService.getAllApiKeys()
      const client = redis.getClientSafe()

      let processedCount = 0
      let errorCount = 0

      for (const apiKey of apiKeys) {
        try {
          await this.initializeApiKeyCosts(apiKey.id, client)
          processedCount++

          if (processedCount % 10 === 0) {
            logger.info(`💰 Processed ${processedCount} API Keys...`)
          }
        } catch (error) {
          errorCount++
          logger.error(`❌ Failed to initialize costs for API Key ${apiKey.id}:`, error)
        }
      }

      logger.success(
        `💰 Cost initialization completed! Processed: ${processedCount}, Errors: ${errorCount}`
      )
      return { processed: processedCount, errors: errorCount }
    } catch (error) {
      logger.error('❌ Failed to initialize costs:', error)
      throw error
    }
  }

  /**
   * 初始化单个API Key的费用数据
   */
  async initializeApiKeyCosts(apiKeyId, client) {
    // 获取所有时间的模型使用统计
    const modelKeys = await client.keys(`usage:${apiKeyId}:model:*:*:*`)

    // 按日期分组统计
    const dailyCosts = new Map() // date -> cost
    const monthlyCosts = new Map() // month -> cost
    const hourlyCosts = new Map() // hour -> cost
    const unavailablePeriods = {
      daily: new Set(),
      monthly: new Set(),
      hourly: new Set()
    }

    for (const key of modelKeys) {
      // 解析key格式: usage:{keyId}:model:{period}:{model}:{date}
      const match = key.match(
        /usage:(.+):model:(daily|monthly|hourly):(.+):(\d{4}-\d{2}(?:-\d{2})?(?::\d{2})?)$/
      )
      if (!match) {
        continue
      }

      const [, , period, model, dateStr] = match

      // 获取使用数据
      const data = await client.hgetall(key)
      if (!data || Object.keys(data).length === 0) {
        continue
      }

      // 计算费用
      const usage = {
        input_tokens: parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0,
        output_tokens: parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0,
        cache_creation_input_tokens:
          parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0,
        cache_read_input_tokens:
          parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
      }

      const costResult = getStoredOrCalculatedCost({
        usage,
        model,
        stored: data
      })

      if (!costResult.available) {
        unavailablePeriods[period]?.add(dateStr)
        logger.warn(
          `💰 Skipping ${period} cost initialization for ${apiKeyId}/${model}/${dateStr}: pricing unavailable`
        )
        continue
      }

      const cost = costResult.totalCost

      // 根据period分组累加费用
      if (period === 'daily') {
        const currentCost = dailyCosts.get(dateStr) || 0
        dailyCosts.set(dateStr, currentCost + cost)
      } else if (period === 'monthly') {
        const currentCost = monthlyCosts.get(dateStr) || 0
        monthlyCosts.set(dateStr, currentCost + cost)
      } else if (period === 'hourly') {
        const currentCost = hourlyCosts.get(dateStr) || 0
        hourlyCosts.set(dateStr, currentCost + cost)
      }
    }

    // 将计算出的费用写入Redis
    const promises = []

    // 写入每日费用
    for (const [date, cost] of dailyCosts) {
      if (unavailablePeriods.daily.has(date)) {
        continue
      }
      const key = `usage:cost:daily:${apiKeyId}:${date}`
      promises.push(
        client.set(key, cost.toString()),
        client.expire(key, 86400 * 30) // 30天过期
      )
    }

    // 写入每月费用
    for (const [month, cost] of monthlyCosts) {
      if (unavailablePeriods.monthly.has(month)) {
        continue
      }
      const key = `usage:cost:monthly:${apiKeyId}:${month}`
      promises.push(
        client.set(key, cost.toString()),
        client.expire(key, 86400 * 90) // 90天过期
      )
    }

    // 写入每小时费用
    for (const [hour, cost] of hourlyCosts) {
      if (unavailablePeriods.hourly.has(hour)) {
        continue
      }
      const key = `usage:cost:hourly:${apiKeyId}:${hour}`
      promises.push(
        client.set(key, cost.toString()),
        client.expire(key, 86400 * 7) // 7天过期
      )
    }

    // 计算总费用
    let totalCost = 0
    for (const cost of dailyCosts.values()) {
      totalCost += cost
    }

    // 写入总费用 - 修复：只在总费用不存在时初始化，避免覆盖现有累计值
    const hasUnavailableCost = Object.values(unavailablePeriods).some((periods) => periods.size > 0)
    if (totalCost > 0 && !hasUnavailableCost) {
      const totalKey = `usage:cost:total:${apiKeyId}`
      // 先检查总费用是否已存在
      const existingTotal = await client.get(totalKey)

      if (!existingTotal || parseFloat(existingTotal) === 0) {
        // 仅在总费用不存在或为0时才初始化
        promises.push(client.set(totalKey, totalCost.toString()))
        logger.info(`💰 Initialized total cost for API Key ${apiKeyId}: $${totalCost.toFixed(6)}`)
      } else {
        // 如果总费用已存在，保持不变，避免覆盖累计值
        // 注意：这个逻辑防止因每日费用键过期（30天）导致的错误覆盖
        // 如果需要强制重新计算，请先手动删除 usage:cost:total:{keyId} 键
        const existing = parseFloat(existingTotal)
        const calculated = totalCost

        if (calculated > existing * 1.1) {
          // 如果计算值比现有值大 10% 以上，记录警告（可能是数据不一致）
          logger.warn(
            `💰 Total cost mismatch for API Key ${apiKeyId}: existing=$${existing.toFixed(6)}, calculated=$${calculated.toFixed(6)} (from last 30 days). Keeping existing value to prevent data loss.`
          )
        } else {
          logger.debug(
            `💰 Skipping total cost initialization for API Key ${apiKeyId} - existing: $${existing.toFixed(6)}, calculated: $${calculated.toFixed(6)}`
          )
        }
      }
    }

    await Promise.all(promises)

    logger.debug(
      `💰 Initialized costs for API Key ${apiKeyId}: Daily entries: ${dailyCosts.size}, Total cost: $${totalCost.toFixed(2)}`
    )
  }

  /**
   * 检查是否需要初始化费用数据
   */
  async needsInitialization() {
    try {
      const client = redis.getClientSafe()

      // 检查是否有任何费用数据
      const costKeys = await client.keys('usage:cost:*')

      // 如果没有费用数据，需要初始化
      if (costKeys.length === 0) {
        logger.info('💰 No cost data found, initialization needed')
        return true
      }

      // 检查是否有使用数据但没有对应的费用数据
      const sampleKeys = await client.keys('usage:*:model:daily:*:*')
      if (sampleKeys.length > 10) {
        // 抽样检查
        const sampleSize = Math.min(10, sampleKeys.length)
        for (let i = 0; i < sampleSize; i++) {
          const usageKey = sampleKeys[Math.floor(Math.random() * sampleKeys.length)]
          const match = usageKey.match(/usage:(.+):model:daily:(.+):(\d{4}-\d{2}-\d{2})$/)
          if (match) {
            const [, keyId, , date] = match
            const costKey = `usage:cost:daily:${keyId}:${date}`
            const hasCost = await client.exists(costKey)
            if (!hasCost) {
              logger.info(
                `💰 Found usage without cost data for key ${keyId} on ${date}, initialization needed`
              )
              return true
            }
          }
        }
      }

      logger.info('💰 Cost data appears to be up to date')
      return false
    } catch (error) {
      logger.error('❌ Failed to check initialization status:', error)
      return false
    }
  }
}

module.exports = new CostInitService()
