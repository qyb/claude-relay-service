#!/usr/bin/env node

/**
 * 上游 telemetry（llm-telemetry JSONL）消费分析脚本。
 *
 * 对应 docs/UPSTREAM_TELEMETRY_DESIGN.md 第八节验证方案与 6.2 消费分析：
 *   1. attempt_count>1 占比与 retry_reason 分布
 *   2. failure_stage / 三层状态码 / 稳定错误码分布
 *   3. 账号健康时间线（摘除/恢复时长、提前恢复、恢复来源）
 *   4. 漂移（A 型）与冷重建（B 型）top 会话
 *   5. upstream_attempt retry/failover 链与失败 attempt 成本
 *
 * 用法：
 *   node scripts/analyze-upstream-telemetry.js [日志文件...] [--top N]
 *   未指定文件时默认读取 logs/llm-telemetry*.log（支持 .gz）
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const zlib = require('zlib')

// 漂移判定窗口：deleted 后 60s 内重新 set 视为 A 型漂移（与设计文档口径一致）
const DRIFT_WINDOW_MS = 60 * 1000
// 提前恢复阈值：实际摘除时长 < 预期的一半视为提前恢复
const EARLY_RECOVERY_RATIO = 0.5

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  magenta: '\x1b[35m'
}

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  warn: (msg) => console.warn(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`)
}

function parseArgs(argv) {
  const files = []
  let top = 10
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--top') {
      top = parseInt(argv[i + 1], 10) || 10
      i += 1
    } else {
      files.push(argv[i])
    }
  }
  return { files, top }
}

function defaultLogFiles() {
  const candidates = ['logs', '.']
  const files = []
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      continue
    }
    for (const name of fs.readdirSync(dir)) {
      if (/^llm-telemetry.*\.log(\.gz)?$/.test(name)) {
        files.push(path.join(dir, name))
      }
    }
    if (files.length > 0) {
      break
    }
  }
  return files.sort()
}

function increment(map, key, weight = 1) {
  const normalized = key === undefined || key === null || key === '' ? '(null)' : String(key)
  map.set(normalized, (map.get(normalized) || 0) + weight)
  return map
}

function printHistogram(title, map, limit = 15) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (entries.length === 0) {
    console.log(`  ${title}: 无数据`)
    return
  }
  const maxKeyLen = Math.min(60, Math.max(...entries.map(([key]) => key.length)))
  console.log(`  ${title}:`)
  for (const [key, count] of entries) {
    const display = key.length > maxKeyLen ? `${key.slice(0, maxKeyLen - 3)}...` : key
    console.log(`    ${display.padEnd(maxKeyLen)} ${String(count).padStart(8)}`)
  }
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return null
  }
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length))
  return sortedValues[idx]
}

class UpstreamTelemetryAnalyzer {
  constructor() {
    this.eventCounts = new Map()
    this.badLines = 0
    this.totalLines = 0

    // 请求事件
    this.requestTotal = 0
    this.requestErrors = 0
    this.retryReasons = new Map()
    this.attemptCountHist = new Map()
    this.failureStages = new Map()
    this.errorCodes = new Map()
    this.statusLayerCombos = new Map()
    this.upstreamErrorCodes = new Map()
    this.upstreamMessageTemplates = new Map()
    // session_hash → 请求的 input/cache token（用于 B 型冷重建代价）
    this.sessionRebuildTokens = new Map()

    // sticky 生命周期
    this.stickyActions = new Map()
    this.stickyBySession = new Map() // hash → [{action, reason, ts, accountId}]
    this.stickyDeletedWithoutFollowUp = 0

    // 账号生命周期
    this.accounts = new Map() // accountId → { suppressions, recoveries, detected }
    this.detectedErrorCodes = new Map()
    this.detectedTemplates = new Map()

    // upstream_attempt
    this.attemptTotal = 0
    this.attemptFailed = 0
    this.attemptChains = new Map() // gateway_request_id → attempts[]
  }

  account(accountId) {
    if (!this.accounts.has(accountId)) {
      this.accounts.set(accountId, {
        suppressions: [],
        recoveries: [],
        failovers: 0
      })
    }
    return this.accounts.get(accountId)
  }

  observe(event) {
    increment(this.eventCounts, event.event_type)

    switch (event.event_type) {
      case 'llm_request_completed':
      case 'llm_request_error':
        this.observeRequest(event)
        break
      case 'sticky_session_lifecycle':
        this.observeSticky(event)
        break
      case 'account_rate_limit_detected':
        this.observeDetected(event)
        break
      case 'account_suppressed':
        this.observeSuppressed(event)
        break
      case 'account_recovered':
        this.observeRecovered(event)
        break
      case 'account_failover':
        if (event.account_id) {
          this.account(event.account_id).failovers += 1
        }
        break
      case 'upstream_attempt':
        this.observeAttempt(event)
        break
      default:
        break
    }
  }

  observeRequest(event) {
    this.requestTotal += 1
    if (event.event_type === 'llm_request_error') {
      this.requestErrors += 1
      increment(this.failureStages, event.failure_stage)
      increment(this.errorCodes, event.error_code)
      increment(
        this.statusLayerCombos,
        `client=${event.client_status_code ?? event.status_code} gateway=${
          event.gateway_status_code ?? '-'
        } upstream=${event.upstream_status_code ?? '-'}`
      )
    }
    increment(this.attemptCountHist, event.attempt_count)
    if (event.attempt_count > 1) {
      increment(this.retryReasons, event.retry_reason)
    }
    if (event.upstream_error_code) {
      increment(this.upstreamErrorCodes, event.upstream_error_code)
    }
    if (event.upstream_message_template) {
      increment(this.upstreamMessageTemplates, event.upstream_message_template)
    }

    // 记录每个会话的重建候选请求（高 input、低 cache read 的请求最有冷重建嫌疑）
    if (event.sticky_session_key && event.usage_available) {
      const current = this.sessionRebuildTokens.get(event.sticky_session_key) || {
        requests: 0,
        fullPriceInputTokens: 0
      }
      current.requests += 1
      current.fullPriceInputTokens +=
        (event.input_tokens || 0) + (event.cache_creation_input_tokens || 0)
      this.sessionRebuildTokens.set(event.sticky_session_key, current)
    }
  }

  observeSticky(event) {
    increment(this.stickyActions, event.action)
    if (!event.session_hash) {
      return
    }
    const list = this.stickyBySession.get(event.session_hash) || []
    list.push({
      action: event.action,
      reason: event.reason,
      ts: new Date(event.timestamp).getTime(),
      accountId: event.account_id
    })
    this.stickyBySession.set(event.session_hash, list)
  }

  observeDetected(event) {
    if (!event.account_id) {
      return
    }
    this.account(event.account_id).detected.push(event)
    increment(this.detectedErrorCodes, event.upstream_error_code)
    if (event.upstream_message_template) {
      increment(this.detectedTemplates, event.upstream_message_template)
    }
  }

  observeSuppressed(event) {
    if (!event.account_id) {
      return
    }
    this.account(event.account_id).suppressions.push({
      ts: new Date(event.timestamp).getTime(),
      reason: event.reason,
      configuredDurationSeconds: event.configured_duration_seconds,
      expectedRecoveryAt: event.expected_recovery_at
        ? new Date(event.expected_recovery_at).getTime()
        : null,
      suppressionId: event.suppression_id,
      affectedSessionCount: event.affected_session_count
    })
  }

  observeRecovered(event) {
    if (!event.account_id) {
      return
    }
    this.account(event.account_id).recoveries.push({
      ts: new Date(event.timestamp).getTime(),
      recoverySource: event.recovery_source,
      expectedRecoveryAt: event.expected_recovery_at
        ? new Date(event.expected_recovery_at).getTime()
        : null,
      actualSuppressionSeconds: event.actual_suppression_seconds,
      suppressionId: event.suppression_id
    })
  }

  observeAttempt(event) {
    this.attemptTotal += 1
    if (!event.success) {
      this.attemptFailed += 1
    }
    const chain = this.attemptChains.get(event.gateway_request_id) || []
    chain.push(event)
    this.attemptChains.set(event.gateway_request_id, chain)
  }

  /**
   * A 型漂移：deleted(failover/account_error) 后 60s 内同 hash 重新 set。
   * B 型漂移（冷重建）：miss 之前同 hash 有过 set 且中间没有 deleted（miss_after_prior_set）。
   */
  analyzeDrift(top) {
    const driftA = []
    const driftB = []
    for (const [hash, events] of this.stickyBySession) {
      const sorted = events.slice().sort((a, b) => a.ts - b.ts)
      let lastSetTs = null
      let lastDeleted = null
      for (const evt of sorted) {
        if (evt.action === 'set') {
          if (lastDeleted && evt.ts - lastDeleted.ts <= DRIFT_WINDOW_MS) {
            driftA.push({
              hash,
              gapMs: evt.ts - lastDeleted.ts,
              reason: lastDeleted.reason,
              accountId: evt.accountId
            })
          }
          if (
            lastSetTs !== null &&
            lastDeleted === null &&
            sorted.some((e) => e.action === 'miss' && e.ts > lastSetTs && e.ts < evt.ts)
          ) {
            driftB.push({ hash, accountId: evt.accountId })
          }
          lastSetTs = evt.ts
          lastDeleted = null
        } else if (evt.action === 'deleted') {
          lastDeleted = evt
        }
      }
      if (lastDeleted) {
        this.stickyDeletedWithoutFollowUp += 1
      }
    }
    return { driftA, driftB, top }
  }

  async analyzeFile(filePath) {
    let stream = fs.createReadStream(filePath)
    if (filePath.endsWith('.gz')) {
      stream = stream.pipe(zlib.createGunzip())
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      this.totalLines += 1
      try {
        this.observe(JSON.parse(trimmed))
      } catch (_) {
        this.badLines += 1
      }
    }
  }

  report(top) {
    console.log(`\n${colors.bright}═══ 上游 Telemetry 分析报告 ═══${colors.reset}\n`)

    console.log(`${colors.bright}[1] 事件总量${colors.reset}`)
    printHistogram('事件类型', this.eventCounts)
    if (this.badLines > 0) {
      log.warn(`无法解析的行：${this.badLines}/${this.totalLines}`)
    }

    console.log(`\n${colors.bright}[2] 请求事件与重试${colors.reset}`)
    const retried = [...this.attemptCountHist.entries()]
      .filter(([count]) => Number(count) > 1)
      .reduce((sum, [, n]) => sum + n, 0)
    console.log(`  请求总数: ${this.requestTotal}，其中 llm_request_error: ${this.requestErrors}`)
    console.log(
      `  attempt_count>1 的请求: ${retried}（${this.requestTotal > 0 ? ((retried / this.requestTotal) * 100).toFixed(2) : '0.00'}%）`
    )
    printHistogram('attempt_count 分布', this.attemptCountHist)
    printHistogram('retry_reason', this.retryReasons)

    if (this.requestErrors > 0) {
      console.log(
        `\n${colors.bright}[3] 失败分层（failure_stage / 三层状态码 / 错误码）${colors.reset}`
      )
      printHistogram('failure_stage', this.failureStages)
      printHistogram('error_code', this.errorCodes)
      printHistogram('client/gateway/upstream 状态组合', this.statusLayerCombos)
      printHistogram('请求级 upstream_error_code', this.upstreamErrorCodes)
      printHistogram('请求级 upstream_message_template', this.upstreamMessageTemplates)
    }

    console.log(`\n${colors.bright}[4] 账号健康时间线${colors.reset}`)
    const earlyRecoveries = []
    for (const [accountId, data] of this.accounts) {
      const suppressionsBySuppressionId = new Map()
      for (const sup of data.suppressions) {
        suppressionsBySuppressionId.set(sup.suppressionId ?? String(sup.ts), sup)
      }
      const lines = []
      for (const rec of data.recoveries) {
        const sup = suppressionsBySuppressionId.get(rec.suppressionId ?? String(rec.ts)) || null
        let early = false
        if (sup && sup.expectedRecoveryAt && rec.actualSuppressionSeconds !== null) {
          const expectedSeconds = Math.max(1, Math.round((sup.expectedRecoveryAt - sup.ts) / 1000))
          early = rec.actualSuppressionSeconds < expectedSeconds * EARLY_RECOVERY_RATIO
          if (early) {
            earlyRecoveries.push({ accountId, rec, expectedSeconds })
          }
        }
        lines.push(
          `    恢复 @${new Date(rec.ts).toISOString()} source=${rec.recovery_source} 实际摘除=${
            rec.actualSuppressionSeconds ?? '?'
          }s${early ? '（提前恢复）' : ''}`
        )
      }
      if (data.suppressions.length === 0 && data.recoveries.length === 0 && data.failovers === 0) {
        continue
      }
      console.log(
        `  账号 ${accountId}: failover=${data.failovers}, 摘除=${data.suppressions.length}, 恢复=${data.recoveries.length}`
      )
      for (const sup of data.suppressions) {
        console.log(
          `    摘除 @${new Date(sup.ts).toISOString()} reason=${sup.reason} 计划=${
            sup.configuredDurationSeconds ?? '?'
          }s 波及会话=${sup.affectedSessionCount ?? '?'}`
        )
      }
      for (const line of lines) {
        console.log(line)
      }
    }
    printHistogram('限流检测 upstream_error_code', this.detectedErrorCodes)
    printHistogram('限流检测消息模板', this.detectedTemplates)
    console.log(`  提前恢复次数（实际 < 预期×${EARLY_RECOVERY_RATIO}）: ${earlyRecoveries.length}`)

    console.log(`\n${colors.bright}[5] 漂移与冷重建 top 会话${colors.reset}`)
    const { driftA, driftB } = this.analyzeDrift(top)
    console.log(
      `  A 型漂移（deleted→短间隔 set，窗口 ${DRIFT_WINDOW_MS / 1000}s）: ${driftA.length} 次`
    )
    const driftAByReason = new Map()
    driftA.forEach((d) => increment(driftAByReason, d.reason))
    printHistogram('A 型漂移 deleted reason', driftAByReason)
    console.log(
      `  B 型冷重建（miss_after_prior_set→set 新账号）: ${driftB.length} 次；deleted 后无后续 set/miss: ${this.stickyDeletedWithoutFollowUp} 个会话`
    )

    const bCosts = driftB
      .map((d) => {
        const usage = this.sessionRebuildTokens.get(d.hash)
        return {
          hash: d.hash,
          accountId: d.accountId,
          requests: usage?.requests || 0,
          fullPriceInputTokens: usage?.fullPriceInputTokens || 0
        }
      })
      .sort((a, b) => b.fullPriceInputTokens - a.fullPriceInputTokens)
      .slice(0, top)
    if (bCosts.length > 0) {
      console.log(`  B 型冷重建 top${top}（按全价 input token 估算，含该会话全部请求）:`)
      for (const item of bCosts) {
        console.log(
          `    ${item.hash.slice(0, 16)}... input+cache_create=${item.fullPriceInputTokens} tokens / ${item.requests} 请求 (账号 ${item.accountId ?? '?'})`
        )
      }
    }

    if (this.attemptTotal > 0) {
      console.log(`\n${colors.bright}[6] 逐次 upstream_attempt${colors.reset}`)
      console.log(
        `  attempt 总数: ${this.attemptTotal}，失败: ${this.attemptFailed}（${((this.attemptFailed / this.attemptTotal) * 100).toFixed(2)}%）`
      )
      const multiChains = [...this.attemptChains.values()].filter((chain) => chain.length > 1)
      console.log(`  多 attempt 请求链: ${multiChains.length}（可还原完整 retry/failover 链）`)
      const failedCost = [...this.attemptChains.values()]
        .flat()
        .filter((attempt) => !attempt.success && typeof attempt.cost === 'number')
        .reduce((sum, attempt) => sum + attempt.cost, 0)
      if (failedCost > 0) {
        console.log(`  失败 attempt 累计成本: $${failedCost.toFixed(4)}`)
      }
      const upstreamLatencies = [...this.attemptChains.values()]
        .flat()
        .map((attempt) => attempt.upstream_latency_ms)
        .filter((ms) => typeof ms === 'number')
        .sort((a, b) => a - b)
      if (upstreamLatencies.length > 0) {
        console.log(
          `  upstream 延迟 p50=${percentile(upstreamLatencies, 50)}ms p95=${percentile(upstreamLatencies, 95)}ms`
        )
      }
    }

    console.log(`\n${colors.bright}[7] sticky 生命周期${colors.reset}`)
    printHistogram('action 分布', this.stickyActions)
  }
}

async function main() {
  const { files, top } = parseArgs(process.argv.slice(2))
  const logFiles = files.length > 0 ? files : defaultLogFiles()
  if (logFiles.length === 0) {
    log.error(
      '未找到 llm-telemetry 日志文件。用法: node scripts/analyze-upstream-telemetry.js <日志文件...> [--top N]'
    )
    process.exit(1)
  }

  const analyzer = new UpstreamTelemetryAnalyzer()
  for (const file of logFiles) {
    log.info(`读取 ${file}`)
    await analyzer.analyzeFile(file)
  }
  analyzer.report(top)
}

if (require.main === module) {
  main().catch((error) => {
    log.error(error.message)
    process.exit(1)
  })
}

module.exports = { UpstreamTelemetryAnalyzer, parseArgs, defaultLogFiles }
