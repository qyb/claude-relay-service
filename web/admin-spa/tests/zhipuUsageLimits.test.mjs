import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatZhipuResetRemaining,
  isZhipuClaudeConsoleAccount,
  mergeZhipuUsageLimitMap,
  normalizeZhipuUsageWindows
} from '../src/utils/zhipuUsageLimits.js'

test('matches only the supported Zhipu Claude Console endpoint', () => {
  const account = (apiUrl, platform = 'claude-console') => ({ platform, apiUrl })

  assert.equal(isZhipuClaudeConsoleAccount(account('https://open.bigmodel.cn/api/anthropic')), true)
  assert.equal(
    isZhipuClaudeConsoleAccount(account('https://open.bigmodel.cn/api/anthropic/')),
    true
  )
  assert.equal(
    isZhipuClaudeConsoleAccount(account('https://open.bigmodel.cn.evil/api/anthropic')),
    false
  )
  assert.equal(isZhipuClaudeConsoleAccount(account('http://open.bigmodel.cn/api/anthropic')), false)
  assert.equal(
    isZhipuClaudeConsoleAccount(account('https://open.bigmodel.cn/api/anthropic', 'claude')),
    false
  )
})

test('normalizes window order, percentages and duplicate kinds', () => {
  const windows = normalizeZhipuUsageWindows([
    { kind: 'mcp', usedPercent: 1.125, remainingPercent: 98.875 },
    { kind: 'weekly', usedPercent: 120, remainingPercent: -20 },
    { kind: 'session', usedPercent: '10' },
    { kind: 'session', usedPercent: 30 },
    { kind: 'unknown', usedPercent: 50 },
    { kind: 'weekly', usedPercent: 'invalid' }
  ])

  assert.deepEqual(
    windows.map((window) => window.kind),
    ['session', 'weekly', 'mcp']
  )
  assert.equal(windows[0].usedPercent, 10)
  assert.equal(windows[0].remainingPercent, 90)
  assert.equal(windows[1].usedPercent, 100)
  assert.equal(windows[1].remainingPercent, 0)
})

test('merges usage data by account id without touching other accounts', () => {
  const zhipu = {
    id: 'zhipu-1',
    platform: 'claude-console',
    apiUrl: 'https://open.bigmodel.cn/api/anthropic'
  }
  const other = {
    id: 'other-1',
    platform: 'claude-console',
    apiUrl: 'https://api.example.com'
  }
  const result = mergeZhipuUsageLimitMap([zhipu, other], {
    'zhipu-1': { accountId: 'zhipu-1', status: 'ok' },
    'other-1': { accountId: 'other-1', status: 'ok' }
  })

  assert.notEqual(result[0], zhipu)
  assert.equal(result[0].zhipuUsageLimits.status, 'ok')
  assert.equal(result[1], other)
  assert.equal(result[1].zhipuUsageLimits, undefined)
})

test('preserves an existing snapshot when a partial map omits the account', () => {
  const account = {
    id: 'zhipu-1',
    platform: 'claude-console',
    apiUrl: 'https://open.bigmodel.cn/api/anthropic',
    zhipuUsageLimits: { status: 'ok' }
  }

  const result = mergeZhipuUsageLimitMap([account], {})
  assert.equal(result[0], account)
})

test('formats reset countdowns and invalid timestamps', () => {
  const now = Date.parse('2026-08-08T00:00:00.000Z')
  assert.equal(formatZhipuResetRemaining('2026-08-09T02:30:00.000Z', now), '1天2小时')
  assert.equal(formatZhipuResetRemaining('2026-08-08T01:15:00.000Z', now), '1小时15分钟')
  assert.equal(formatZhipuResetRemaining('2026-08-07T00:00:00.000Z', now), '已到重置时间')
  assert.equal(formatZhipuResetRemaining('invalid', now), '--')
  assert.equal(formatZhipuResetRemaining(null, now), '--')
})
