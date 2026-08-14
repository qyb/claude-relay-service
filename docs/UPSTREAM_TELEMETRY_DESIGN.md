# CRS 上游调用 Telemetry 设计（Upstream Telemetry）

本文档描述 CRS 如何在现有用户侧 telemetry 的基础上，补全**上游账号调用、重试、failover 与 sticky session 生命周期**的可观测性。

现有 telemetry（见 `CLAUDE_CODE_REQUEST_SESSION_TELEMETRY.md`）只覆盖"最终返回给用户的那一次调用"，上游调度层发生的事件目前完全不可见。

## 一、背景：7 天生产数据的验证

对 2026-08-08 ~ 2026-08-14 共 14,517 条 `llm_request_completed` 事件的分析结论：

| 事实                                 | 数据                 |
| ------------------------------------ | -------------------- |
| `attempt_count` 全部为 1             | 14,517/14,517        |
| `retry_reason` / `error_type` 全为空 | 14,517/14,517        |
| `upstream_status_code` 为 null       | 13,389/14,517（93%） |
| `cost` 全部为 null                   | 14,517/14,517        |
| `queue_request_id` 全部为 null       | 14,517/14,517        |

但通过 `account_id` 时间线间接还原，同期实际发生了：

- **120 次会话内账号漂移**（同一 `client_session_id` 的请求跨上游账号）。
- **A 型漂移 51 次**：并发限流震荡（gap < 60s、前 10 分钟 50–135 个请求），由并行 subagent 风暴触发账号 `temp_error` 所致。
- **B 型漂移 45 次**：sticky TTL（默认 1h）过期后重新调度，导致整个会话上下文（15–45 万 token）按全价 input 冷重建，合计约 **5M token/周**的全价损失。
- **4 个跨用户同时漂移簇**：某账号被标记 `temp_error` 时，映射在该账号上的**所有**用户的 sticky 映射被一并删除，造成"一人触发限流、多人缓存重建"的连坐。

结论：**故障真实发生且代价可观，但现有日志无法直接回答"哪个账号、什么错误码、重试了几次、谁的 sticky 被删"**。李玉峰的限流漂移事故只能靠时间线推断还原。

## 二、目标与非目标

### 2.1 目标

- 每个用户请求都有上游尝试摘要：尝试次数、最终账号、最终状态码、重试原因与总延迟。完整的逐次尝试明细不属于第一版范围。
- 账号 failover（切换、限流、temp_error、unauthorized、blocked）作为独立事件落盘，携带受影响的 session。
- sticky session 的关键生命周期（set / miss / expired / deleted）可观测；不对每次命中记录事件。
- 上游事件可与用户侧事件通过 `gateway_request_id` / `session_hash` join，合并为一条时间线。

单请求 `cost` 回填、逐次上游尝试明细和 sticky 命中率属于后续扩展，不阻塞第一版故障排查能力。

### 2.2 非目标

- 不记录上游请求/响应正文（与现有 telemetry 原则一致）。
- 不改变调度与 sticky 策略本身（TTL 续期等行为变更属于配置调整，见第六节，但本设计的事件先行，用于度量变更收益）。
- 不做实时告警管道（事件先落盘，告警消费后续另立设计）。

## 三、事件设计

沿用现有 JSONL 逐行落盘方式与 `schema_version` 字段。新增事件类型不破坏旧消费方（`llmTelemetry.js` 的 `VALID_EVENT_TYPES` 白名单需同步扩充）。

### 3.1 填充现有 `llm_request_completed` 预留字段（最小改动，优先实施）

`attempt_count`、`retry_reason`、`upstream_status_code`、`queue_request_id` 字段已存在但从未赋值。实施方式：

- `attempt_count` 按上游实际尝试次数计数，初始尝试计为 1；每次重试或换账号再加 1。
- 记录**最后一次**上游尝试的 `upstream_status_code`；若曾发生非 2xx，可在 `retry_reason` 记录触发重试的原因（`rate_limit` / `temp_error` / `upstream_5xx` / `connection_error` 等）。
- `queue_request_id` 由 relay 层在队列锁成功后通过请求 observer 回填；内部 403 重试、credential retry 以及路由层递归重试通过同一 observer 的 `noteRetry()` 回填 `attempt_count` / `retry_reason`。

该字段组只提供请求级摘要。如果一次请求发生多个失败原因，`retry_reason` 记录最终触发重试或 failover 的原因；需要完整尝试序列时，后续另增 `upstream_attempt` 事件，避免把多个原因压缩进现有字段。

此改动无需新 schema，即可回答"这次请求重试了几次、为什么"。

### 3.2 新增事件：`account_failover`

在上游账号状态变更处打点：

```json
{
  "schema_version": 1,
  "event_type": "account_failover",
  "timestamp": "2026-08-20T03:14:15.922Z",
  "gateway_request_id": "u3t0g4gecj",
  "session_hash": "<sticky_session key 中的 hash>",
  "account_id": "a0025034-...",
  "account_type": "claude-console",
  "reason": "rate_limit | temp_error | unauthorized | blocked | expired_token",
  "upstream_status_code": 429,
  "sticky_deleted": true
}
```

第一版只要求记录枚举化的 `reason` 和状态码，不记录错误消息指纹。`affected_session_count` 可作为后续扩展字段；如果暂时无法保证与 Redis 删除操作的一致性，不应作为第一版的精确指标。

打点位置：

| 位置                                                                               | 说明                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `unifiedClaudeScheduler.js` `markAccountRateLimited`                               | Claude 官方 / Console / CCR 限流标记                 |
| `unifiedClaudeScheduler.js` `markAccountTemporarilyUnavailable`                    | 5xx / timeout 临时不可用，记录为 `temp_error`        |
| `unifiedClaudeScheduler.js` `markAccountUnauthorized` / `markAccountBlocked`       | Claude 官方 / Console 认证失败与封禁；CCR 仅认证失败 |
| `claudeConsoleRelayService.js` / `ccrRelayService.js` 的错误分支                   | 统一转发到上述调度器，并传递请求关联键               |
| `unifiedGeminiScheduler.js` / `unifiedOpenAIScheduler.js` `markAccountRateLimited` | Gemini / OpenAI 限流标记                             |

如果后续补充 `affected_session_count`，可直接度量"连坐"规模，替代现在靠 30 秒窗口聚类推断；第一版暂不依赖该字段。Claude Console 与 CCR relay 的账号错误旁路已统一收口到 `unifiedClaudeScheduler`，不再把 Console/CCR 无事件误读为无故障。

### 3.3 新增事件：`sticky_session_lifecycle`

```json
{
  "schema_version": 1,
  "event_type": "sticky_session_lifecycle",
  "timestamp": "2026-08-20T03:14:15.922Z",
  "action": "set | miss | expired | deleted",
  "session_hash": "<hash>",
  "account_id": "a0025034-...",
  "ttl_seconds": 3600,
  "reason": "failover | account_error | ttl_lapse | first_assign | unknown_or_expired", // deleted/expired/miss 时按语义填写
  "gateway_request_id": "u3t0g4gecj" // 可关联时携带
}
```

打点位置：三个统一调度器的 `_setSessionMapping`、`_deleteSessionMapping`、映射查询未命中处和确认 TTL 过期处。`_extendSessionMappingTTL` 的 `renewed` 事件暂缓，待 TTL 滑动续期行为启用后再增加。

语义约定：

- `miss`：hash 无映射（新会话或已过期，区分不了时记 `miss`，`reason: unknown_or_expired`）。由于 `miss` 只发生在没有映射的路径，不记录每次正常命中，控制事件量。
- `expired`：仅在能确认（如已读到映射后、TTL 检查路径发现竞态过期）时记录，正常 TTL 过期通常只表现为 `miss`，不能仅靠该事件计量。
- `deleted`：必须带 `reason`，区分 failover 主动删除与账号错误被动删除。

`account_failover` 记录账号状态变化，`sticky_session_lifecycle` 记录具体映射变化；两者可以通过 `session_hash` 关联，但不要求每个 failover 都产生一条生命周期事件。批量删除多个映射时，应按实际删除的映射逐条记录 `deleted`，而不是仅记录一个汇总事件。

该事件通过消费端 join 区分 A/B 两型漂移：A 型表现为 `deleted(reason=failover)` 后短间隔 `set`；B 型表现为 `miss` 后 `set` 新账号，且该 `miss` 之前同一 `session_hash` 曾有 `set`、自上次 `set` 后没有对应 `deleted`，标记为 `miss_after_prior_set`。新会话的首次 `miss` 不计入 B 型冷重建。

### 3.4 `cost` 回填

在 `llm_request_completed` 落盘时，复用现有 api-keys 成本口径（token 单价 × input/output/cache read/cache create）计算单请求成本写入 `cost` 字段。跨账号重试时按各次尝试的 token 分别累加。缓存重建（B 型漂移）的全价 input 将因此直接体现在成本上。

## 四、字段与 join 约定

- 上游事件统一携带 `gateway_request_id`（请求级）或 `session_hash`（会话级，至少其一）。
- 公共事件写入入口拒绝同时缺少 `gateway_request_id` 和 `session_hash` 的事件；relay 层负责把请求 ID 传入调度器的 `mark*` 路径。
- `session_hash` 与各调度器 Redis sticky 映射键中的 hash 一致（键前缀可能是 `unified_claude_session_mapping:`、`unified_gemini_session_mapping:` 或 `unified_openai_session_mapping:`），不记录原始 session ID。
- 不记录 API Key 明文、OAuth token、上游错误正文（只落枚举化的 `reason`）。

## 五、实施顺序

1. **P0 – 填充现有字段**（3.1）：改动最小，事故排查立即受益。
2. **P0 – `sticky_session_lifecycle`**（3.3）：先于 TTL 续期配置上线，作为该变更的度量基线。
3. **P1 – `account_failover`**（3.2）：调度器各 mark\* 函数统一接入。
4. **P2 – `cost` 回填**（3.4）：依赖成本单价配置的就绪程度，单独校验重试与缓存 token 的计费口径。
5. **P2 – 消费端**：管理台增加"漂移/冷重建 top 会话"、"账号健康时间线"视图（另行设计）。

第一版不包含：每次 sticky `hit`、`renewed` 事件，错误消息指纹，`affected_session_count` 精确汇总，以及逐次上游尝试事件。

## 六、后续配套（行为变更，非本设计范围）

- 开启 sticky TTL 滑动续期：`renewalThresholdMinutes > 0`（`redis.js` `extendSessionAccountMappingTTL` 已实现，默认关闭）。预期消除大部分 B 型漂移，收益以 `expired`/`miss` 事件前后对比验证，按生产数据预估约 3–5M 全价 token/周。启用后再评估是否增加 `renewed` 事件。
- temp_error 账号恢复后记录 preferred account，减少漂移不回迁问题。
- 高并发用户（并行 subagent 风暴）的 per-key 并发上限或独立账号池。

## 七、验证方案

上线后用以下查询自检（可用 `scripts/` 下新增分析脚本）：

1. `attempt_count > 1` 的请求占比 > 0（与 relay 重试日志及 `retry_reason` 分布交叉验证）。
2. 每次 `sticky_session_lifecycle deleted` 都能找到同 `session_hash` 的后续 `set`/`miss`，或能解释为会话结束。
3. 人为触发一次账号限流（测试 key 高并发），确认 `account_failover` 与对应 `deleted` 事件正确。
4. 第一版事件量与原有 `llm_request_completed` 量级可控，确认没有因 `hit` 路径产生一请求一事件的膨胀。
5. 开启 TTL 续期前后各取一周，对比 `miss_after_prior_set` 数量与 B 型冷重建 token 量；`expired` 仅作为 Redis 竞态辅助指标，不作为 TTL 续期收益的主指标。
