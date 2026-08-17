# CRS 上游调用 Telemetry 设计（Upstream Telemetry）

本文档描述 CRS 如何在现有用户侧 telemetry 的基础上，补全**上游账号调用、重试、failover 与 sticky session 生命周期**的可观测性，并维护当前实现状态与后续演进计划。

本文档最初基于 2026-08-08 ~ 2026-08-14 的生产数据提出。核心事件已在 `llm-telemetry` schema v2 中落地；2026-08-17 起请求失败分层（三层状态码 / `failure_stage` / 稳定错误码）、逐次 `upstream_attempt` 与账号恢复生命周期（detected / suppressed / recovered）均已实现，剩余工作见 5.2。

状态标记：

- ✅ 已实现：代码与测试已落地，生产日志中已有对应数据。
- 🟡 部分实现：已有字段或事件，但生产覆盖、字段语义或关联信息仍不完整。
- ⬜ 未实现：保留为后续 TODO。

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

### 1.1 截至 2026-08-17 的实现状态

| 能力 | 状态 | 当前实现与生产验证 |
| ---- | ---- | ------------------ |
| `llm_request_completed` / `llm_request_error` | ✅ | 请求成功、失败、usage、延迟和客户端断开均已落盘。 |
| 单请求 `cost` 与价格元数据 | ✅ | schema v2 已写入 `cost`、`has_pricing`、`pricing_model`、`pricing_region` 和 `provisional_pricing`。 |
| 三层状态码与 `failure_stage` | ✅ | 2026-08-17 起拆分 `client_status_code` / `gateway_status_code` / `upstream_status_code`（旧 `status_code` 保留为 client 语义，待弃用），并增加 `failure_stage` 六枚举；账号选择快速失败不再被误读为上游 `500`。 |
| 稳定调度错误码 | ✅ | `NO_ELIGIBLE_ACCOUNT` / `MODEL_NOT_SUPPORTED` / `ALL_ACCOUNTS_RATE_LIMITED` / `CONSOLE_ACCOUNT_CONCURRENCY_FULL` 等进入 `error_code`，不再只有 `error_type=Error`。 |
| `queue_request_id` | ✅ | relay 成功、超时（`queue_timeout`）与后端错误路径均回填；超时单独标记 `failure_stage=queue`。 |
| `attempt_count` / `retry_reason` | ✅ | 内部 403 重试、credential retry、路由层递归重试均经 `noteRetry()` 计数并携带枚举化原因，待生产数据复核占比。 |
| 上游错误脱敏字段 | ✅ | 请求事件与 `account_failover` 均携带 `upstream_error_type/code`、`upstream_message_template`（数字/ID 归一为 `<n>`/`<id>`）与 `upstream_request_id`；智谱 `1302` 模板直接可查。 |
| `account_failover` | ✅ | 携带真实 `upstream_status_code`、上游错误码/模板、`expected_recovery_at` 与 `affected_session_count`（基于账号→会话反向索引，见 3.2）。 |
| `sticky_session_lifecycle` | ✅ | `miss`、`set`、`deleted`、`expired` 已接入统一调度器；`renewed` 在真实续期时记录，`hit` 按配置采样（默认关闭）。 |
| 账号摘除与恢复生命周期 | ✅ | `account_rate_limit_detected` / `account_suppressed` / `account_recovered` 三事件携带 `configured_duration_seconds`、`expected/actual_recovery_at`、`actual_suppression_seconds`、`recovery_source` 与 `suppression_id`（三事件可串联）。 |
| 逐次 `upstream_attempt` | ✅ | 每次真实上游尝试（官方 403/credential 重试、Console、CCR 的流式与非流式）立即落盘，含 attempt 序号、账号、延迟、状态、错误码、usage 与 attempt 级 cost。 |
| 消费分析 | 🟡 | `scripts/analyze-upstream-telemetry.js` 已支持失败分层、账号健康时间线、A/B 型漂移与 attempt 链分析；管理台视图另行设计。 |

2026-08-17 的联合日志还暴露出以下语义缺口（**加粗项已在本次实现中补齐**，其余为当时背景）：

- **12 次真实上游 HTTP `429` 的正文均为智谱 `1302`**（“您的账户已达到速率限制，请您控制请求频率”）：错误码与消息模板现已进入 `account_rate_limit_detected` 与请求事件。
- **25 次网关生成的 `429` 已有 `ALL_ACCOUNTS_RATE_LIMITED`**：现携带 `failure_stage=account_selection`，可与真实上游 429 区分。
- **52 次账号选择阶段的快速失败最终被 observer 记为 `http_500`**：现记为 `gateway_status_code=500` + `failure_stage=account_selection` + 稳定错误码，`upstream_status_code=null`。
- `1302` 不携带可解析的重置时间，当前按账号 `rateLimitDuration`（默认 60 分钟）恢复；并行中的成功响应又可能提前清除限流状态——**提前恢复竞态现可通过 `account_recovered.recovery_source=successful_inflight_response` + 触发请求 ID 直接审计**，行为修复单独评审。

## 二、目标与非目标

### 2.1 目标

- ✅ 每个用户请求都有上游尝试摘要：尝试次数、最终账号、最终状态码、重试原因与总延迟（三层状态码与 `failure_stage` 已区分客户端/网关/上游）。
- ✅ 账号 failover（切换、限流、temp_error、unauthorized、blocked）作为独立事件落盘，携带受影响的 session 数、真实上游状态与错误详情、预期恢复时间。
- ✅ sticky session 的关键生命周期（set / miss / expired / deleted / renewed / 采样 hit）可观测；不对每次命中无条件记录事件。
- ✅ 上游事件可与用户侧事件通过 `gateway_request_id` / `session_hash` join，合并为一条时间线；账号生命周期事件另可用 `account_id` + `suppression_id` 串联。

单请求 `cost` 已回填，逐次上游尝试明细（`upstream_attempt`）与账号恢复生命周期已落地；sticky 命中率依赖采样配置（默认关闭）。

### 2.2 非目标

- 不记录上游请求/响应正文（与现有 telemetry 原则一致）。
- 不改变调度与 sticky 策略本身（TTL 续期等行为变更属于配置调整，见第七节，但本设计的事件先行，用于度量变更收益）。
- 不做实时告警管道（事件先落盘，告警消费后续另立设计）。

## 三、事件设计

沿用现有 JSONL 逐行落盘方式与 `schema_version` 字段。新增事件类型不破坏旧消费方（`llmTelemetry.js` 的 `VALID_EVENT_TYPES` 白名单需同步扩充）。

### 3.1 ✅ 填充现有请求事件预留字段

`attempt_count`、`retry_reason`、`upstream_status_code`、`queue_request_id` 字段与 observer 承载能力已存在，调用链已补齐：

- `attempt_count` 按上游实际尝试次数计数，初始尝试计为 1；每次重试或换账号再加 1。内部 403 重试、credential retry、路由层并发满额递归重试均经 `noteRetry()` 计数。
- 记录**最后一次**上游尝试的 `upstream_status_code`；若曾发生非 2xx，在 `retry_reason` 记录触发重试的原因（`rate_limit` / `temp_error` / `upstream_5xx` / `connection_error` / `upstream_403` / `credential_retry` / `console_account_concurrency_full` 等）。
- `queue_request_id` 由 relay 层在队列锁成功后通过 `observeQueue()` 回填；队列超时与后端错误路径同样上报并标记 `failure_stage=queue`。
- 失败分层：`failure_stage ∈ { account_selection, queue, upstream_http, upstream_stream, relay, client_disconnect }`，由 observer 依据稳定错误码、上游状态与断开信号推导，路由层可显式覆盖。
- 三层状态码：`client_status_code` / `gateway_status_code` / `upstream_status_code`；旧 `status_code` 保留（等于 client 语义）兼容期使用，消费方应迁移。
- 上游错误脱敏：`upstream_error_type`、`upstream_error_code`、`upstream_message_template`（数字/UUID/十六进制串归一为 `<n>`/`<id>`，控制字符折叠，不落原文）、`upstream_request_id`。

该字段组只提供请求级摘要。一次请求的多个失败原因通过 `upstream_attempt` 事件（3.5）还原完整序列。

### 3.2 ✅ 新增事件：`account_failover`

在上游账号状态变更处打点：

```json
{
  "schema_version": 2,
  "event_type": "account_failover",
  "timestamp": "2026-08-20T03:14:15.922Z",
  "gateway_request_id": "u3t0g4gecj",
  "session_hash": "<sticky_session key 中的 hash>",
  "account_id": "a0025034-...",
  "account_type": "claude-console",
  "reason": "rate_limit | temp_error | unauthorized | blocked | expired_token",
  "upstream_status_code": 429,
  "upstream_error_code": "1302",
  "upstream_message_template": "[<n>][您的账户已达到速率限制，请您控制请求频率][r-<n>]",
  "sticky_deleted": true,
  "expected_recovery_at": "2026-08-20T04:14:15.922Z",
  "affected_session_count": 4
}
```

`affected_session_count` 基于 Redis ZSET 反向索引（`unified_*_account_sessions:{type}:{accountId}`，score=映射过期时刻，读取前先剪除过期成员）计算"当前仍映射在该账号上的会话数"，即摘除的连坐半径。索引只用于观测：**不**主动批量删除其他会话的映射，各会话仍按自身请求节奏产生 `deleted(account_error)` 生命周期事件，因此计数可被逐条 `deleted` 事件交叉验证。

打点位置：

| 位置                                                                               | 说明                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `unifiedClaudeScheduler.js` `markAccountRateLimited`                               | Claude 官方 / Console / CCR 限流标记                 |
| `unifiedClaudeScheduler.js` `markAccountTemporarilyUnavailable`                    | 5xx / timeout 临时不可用，记录为 `temp_error`        |
| `unifiedClaudeScheduler.js` `markAccountUnauthorized` / `markAccountBlocked`       | Claude 官方 / Console 认证失败与封禁；CCR 仅认证失败 |
| `claudeConsoleRelayService.js` / `ccrRelayService.js` 的错误分支                   | 统一转发到上述调度器，并传递请求关联键               |
| `unifiedGeminiScheduler.js` / `unifiedOpenAIScheduler.js` `markAccountRateLimited` | Gemini / OpenAI 限流标记                             |

如果后续补充 `affected_session_count`，可直接度量"连坐"规模，替代现在靠 30 秒窗口聚类推断；第一版暂不依赖该字段。Claude Console 与 CCR relay 的账号错误旁路已统一收口到 `unifiedClaudeScheduler`，不再把 Console/CCR 无事件误读为无故障。

### 3.3 ✅ 新增事件：`sticky_session_lifecycle`

```json
{
  "schema_version": 2,
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

打点位置：三个统一调度器的 `_setSessionMapping`、`_deleteSessionMapping`、映射查询未命中处和确认 TTL 过期处。`_extendSessionMappingTTL` 在真实续期时记录 `renewed`（`renewalThresholdMinutes` 默认 0，无事件量风险）；`hit` 按 `session.stickyHitSampleRate`（默认 0）低比例采样记录，不默认开启一请求一事件的全量 `hit`。

语义约定：

- `miss`：hash 无映射（新会话或已过期，区分不了时记 `miss`，`reason: unknown_or_expired`）。由于 `miss` 只发生在没有映射的路径，不记录每次正常命中，控制事件量。
- `expired`：仅在能确认（如已读到映射后、TTL 检查路径发现竞态过期）时记录，正常 TTL 过期通常只表现为 `miss`，不能仅靠该事件计量。
- `deleted`：必须带 `reason`，区分 failover 主动删除与账号错误被动删除。
- `renewed`：仅在 `renewalThresholdMinutes > 0` 且剩余 TTL 低于阈值、实际执行 `EXPIRE` 续期时记录。
- `hit`：仅采样命中路径（`reason: sampled_hit`），用于估算命中率与验证续期收益。

`account_failover` 记录账号状态变化，`sticky_session_lifecycle` 记录具体映射变化；两者可以通过 `session_hash` 关联，但不要求每个 failover 都产生一条生命周期事件。批量删除多个映射时，应按实际删除的映射逐条记录 `deleted`，而不是仅记录一个汇总事件。

该事件通过消费端 join 区分 A/B 两型漂移：A 型表现为 `deleted(reason=failover)` 后短间隔 `set`；B 型表现为 `miss` 后 `set` 新账号，且该 `miss` 之前同一 `session_hash` 曾有 `set`、自上次 `set` 后没有对应 `deleted`，标记为 `miss_after_prior_set`。新会话的首次 `miss` 不计入 B 型冷重建。

### 3.4 ✅ `cost` 回填

在 `llm_request_completed` 落盘时，复用现有价格服务按 input/output/cache read/cache create token 计算单请求成本。未知价格保留 `cost=null`，并通过 `has_pricing` 与 `provisional_pricing` 区分价格覆盖情况。

当前成本只覆盖最终请求事件中可获得的 usage。跨账号重试的各次 token 已通过 `upstream_attempt`（3.6）按次记录，attempt 级 cost 可与请求级 `cost` 通过 `gateway_request_id` 关联求和。

### 3.5 ✅ 新增事件：账号生命周期（detected / suppressed / recovered）

限流从检测到恢复的完整链路拆为三个事件，用 `suppression_id`（调度器在摘除时生成并持久化到账号记录 `rateLimitStateId`，兜底用 `rateLimitedAt`）串联：

```json
{
  "schema_version": 2,
  "event_type": "account_rate_limit_detected",
  "timestamp": "2026-08-20T03:14:15.922Z",
  "gateway_request_id": "u3t0g4gecj",
  "session_hash": "<hash>",
  "account_id": "a0025034-...",
  "account_type": "claude-console",
  "upstream_status_code": 429,
  "upstream_error_code": "1302",
  "upstream_message_template": "[<n>][您的账户已达到速率限制，请您控制请求频率][r-<n>]",
  "upstream_request_id": "...",
  "suppression_id": "1755659655922",
  "reset_timestamp": "2026-08-20T04:14:15.000Z"
}
```

`account_suppressed` 携带 `reason`（rate_limit / temp_error / unauthorized / blocked）、`configured_duration_seconds`（计划摘除时长，由预期恢复时间与摘除时刻差计算）、`expected_recovery_at`、`suppression_id` 和 `affected_session_count`。`account_recovered` 携带：

```text
recovery_source             timer_expired | upstream_reset_time | successful_inflight_response | manual
expected_recovery_at        计划恢复时间（摘除时写入）
actual_recovery_at          实际恢复时间
actual_suppression_seconds  实际摘除时长
suppression_id              与 suppressed 事件关联
gateway_request_id          触发恢复的请求（recovery_source=successful_inflight_response 时非空）
```

`recovery_source` 语义：

- `timer_expired`：懒检查发现按账号配置时长（`rateLimitDuration`）已到期。
- `upstream_reset_time`：懒检查发现上游提供的 `rateLimitEndAt`（如智谱 1310/1308 携带的重置时间、`anthropic-ratelimit-unified-reset` 头）已到期。
- `successful_inflight_response`：摘除期间并行在途请求成功，relay 成功路径主动清除限流（**提前恢复竞态的直接审计入口**，携带触发请求 ID）。
- `manual`：管理台/接口人工清除。
- `quota_refresh`：额度刷新路径（预留）。
- temp_error（Redis TTL 键）与 service_restart 的恢复不可观测，不在事件中伪造。

打点位置：`unifiedClaudeScheduler.markAccountRateLimited`（detected + suppressed）、`markAccountTemporarilyUnavailable` / `markAccountUnauthorized` / `markAccountBlocked`（suppressed）、各账号服务 `removeAccountRateLimit`（recovered，定时器/人工/在途成功路径统一收口）。Gemini/OpenAI 调度器在 mark/remove 层对齐同口径事件。

### 3.6 ✅ 新增事件：`upstream_attempt`

每次真实上游尝试结束时**立即**落盘（不等请求终态，长流式请求的重试链也完整）：

```json
{
  "schema_version": 2,
  "event_type": "upstream_attempt",
  "timestamp": "2026-08-20T03:14:16.400Z",
  "gateway_request_id": "u3t0g4gecj",
  "attempt_number": 2,
  "attempt_id": "u3t0g4gecj#a2",
  "account_id": "a0025034-...",
  "account_type": "claude-console",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "queue_request_id": "queue-1",
  "queue_wait_ms": 120,
  "upstream_latency_ms": 450,
  "upstream_status_code": 200,
  "success": true,
  "upstream_error_type": null,
  "upstream_error_code": null,
  "upstream_message_template": null,
  "upstream_request_id": "req-1",
  "input_tokens": 1000,
  "output_tokens": 20,
  "cache_creation_input_tokens": null,
  "cache_read_input_tokens": null,
  "usage_available": true,
  "cost": 0.0014,
  "has_pricing": true
}
```

覆盖路径：官方 Claude 非流式的 403/credential 重试循环（每次 `_makeClaudeRequest` 返回即一条）、官方流式的递归重试与终态、Console 非流式/流式、CCR 非流式/流式（各单次尝试）。失败 attempt 的 usage/cost 为 null（上游 429/5xx 不返回 usage）；成功 attempt 携带该次真实 usage 与按次计算的 cost。`gateway_request_id + attempt_number/attempt_id` 即可还原完整 retry/failover 链，不再把多个失败原因压缩进单个 `retry_reason`。

## 四、字段与 join 约定

- 上游事件统一携带 `gateway_request_id`（请求级）或 `session_hash`（会话级，至少其一）。
- 公共事件写入入口拒绝同时缺少 `gateway_request_id` 和 `session_hash` 的事件；relay 层负责把请求 ID 传入调度器的 `mark*` 路径。
- `session_hash` 与各调度器 Redis sticky 映射键中的 hash 一致（键前缀可能是 `unified_claude_session_mapping:`、`unified_gemini_session_mapping:` 或 `unified_openai_session_mapping:`），不记录原始 session ID。
- 不记录 API Key 明文、OAuth token、上游错误正文（只落枚举化的 `reason`）。

## 五、已完成项与剩余工作

### 5.1 已完成

1. ✅ `llm_request_completed` / `llm_request_error` 统一请求事件。
2. ✅ `sticky_session_lifecycle` 核心事件及调度器打点（含 `renewed`/采样 `hit`）。
3. ✅ `account_failover` 基础事件及 Claude/Gemini/OpenAI 调度器接入（含上游错误详情、`expected_recovery_at`、`affected_session_count`）。
4. ✅ 单请求 usage、cost 和价格来源元数据。
5. ✅ request observer 的 `observeUpstream()`、`observeError()`、`noteRetry()`、`observeQueue()`、`observeAttempt()`、`observeGatewayStatus()` 以及 queue/上游字段承载能力。
6. ✅ 三层状态码拆分、`failure_stage` 与稳定调度错误码（v1）。
7. ✅ 上游错误脱敏字段（`upstream_error_type/code`、`upstream_message_template`、`upstream_request_id`）。
8. ✅ 账号生命周期事件（detected / suppressed / recovered）与 `recovery_source`、`suppression_id` 关联（v1）。
9. ✅ 逐次 `upstream_attempt` 事件与 attempt 级 usage/cost（v2）。
10. ✅ `scripts/analyze-upstream-telemetry.js` 消费分析脚本（失败分层、账号健康时间线、A/B 型漂移、attempt 链）。

### 5.2 仍需完成

1. 🟡 生产数据复核：`attempt_count > 1` 占比、`failure_stage` 分布与 relay 日志对齐（事件已落盘，待积累数据）。
2. 🟡 `status_code` 旧字段弃用计划：三层字段上线稳定后通知消费方迁移并移除旧字段。
3. ⬜ 管理台增加“漂移/冷重建 top 会话”和“账号健康时间线”视图（另行设计）。
4. ⬜ 账号池指标告警管道（事件已可支撑，告警消费另立设计）。

## 六、TODO 路线图

以下 `v1` / `v2` 是交付阶段，不对应日志的 `schema_version`。

### 6.1 v1：状态语义与账号生命周期（✅ 已实现）

- [x] 将当前 `status_code` 明确拆分为 `client_status_code`、`gateway_status_code` 和 `upstream_status_code`；兼容期保留旧字段并标记弃用计划（旧字段=client 语义，迁移完成后移除）。
- [x] 增加 `failure_stage`：`account_selection` / `queue` / `upstream_http` / `upstream_stream` / `relay` / `client_disconnect`（observer 依据错误码/上游状态/断开信号推导，路由可显式覆盖）。
- [x] 为调度失败补充稳定错误码：`NO_ELIGIBLE_ACCOUNT`、`MODEL_NOT_SUPPORTED`、`ALL_ACCOUNTS_RATE_LIMITED`（含 `CONSOLE_ACCOUNT_CONCURRENCY_FULL`、`CLAUDE_DEDICATED_RATE_LIMITED`、`SESSION_BINDING_ACCOUNT_UNAVAILABLE`、`queue_timeout`），不再仅记录 `error_type=Error`。
- [x] 上游错误记录脱敏后的 `upstream_error_type`、`upstream_error_code`、`upstream_message_template` 和 `upstream_request_id`；智谱 `1302` 只保留消息模板（数字/ID 归一为 `<n>`/`<id>`），不重复保存每条 request ID。
- [x] 所有真实上游调用都更新 `attempt_count`；重试或换账号时写入枚举化 `retry_reason`（生产占比复核待数据积累，见 5.2）。
- [x] 补齐 `queue_request_id` 的 relay 成功、超时和后端错误路径（`observeQueue()`，超时/错误标记 `failure_stage=queue`）。
- [x] 新增账号生命周期事件：`account_rate_limit_detected`、`account_suppressed`、`account_recovered`，记录 `configured_duration_seconds`、`expected_recovery_at`、`actual_recovery_at`、`actual_suppression_seconds` 和 `recovery_source`。
- [x] `recovery_source` 使用稳定枚举：`timer_expired` / `upstream_reset_time` / `successful_inflight_response` / `manual` / `service_restart`（不可观测，预留）/ `quota_refresh`（预留）。
- [x] 为限流状态更新增加可关联的状态版本（`suppression_id` 持久化于账号记录 `rateLimitStateId`）与触发请求 ID，"并行成功响应提前恢复限流账号"的竞态可直接审计；行为修复单独评审。
- [x] 对账号池临时不可用、全账号限流和模型不支持分别使用准确的网关错误码；对外 HTTP 状态调整属于接口行为变更，未改动。

### 6.2 v2：逐次 attempt 与消费分析

- [x] 新增 `upstream_attempt` 事件，每次真实上游尝试记录 attempt 序号、账号、provider、模型、queue/upstream 延迟、状态、错误码、usage 和 cost。
- [x] 使用 `gateway_request_id` + `attempt_id`（`attempt_number`）还原完整 retry/failover 链，不再把多个失败原因压缩进单个 `retry_reason`。
- [x] 为 `account_failover` 增加可验证的 `affected_session_count`（Redis ZSET 反向索引，读取前剪除过期成员；不改变调度行为，可用逐条 `deleted` 事件交叉验证）。
- [x] sticky `renewed` 事件（真实续期时记录）与低比例采样的 `hit` 事件（`session.stickyHitSampleRate`，默认 0 不开启）。
- [x] `scripts/analyze-upstream-telemetry.js`：失败分层/三层状态码/错误码分布、账号健康时间线（含提前恢复）、A/B 型漂移与冷重建 top 会话、attempt 链与失败 attempt 成本。
- [ ] 建立账号池指标和告警管道：可用账号数、真实上游 `429`、网关合成 `429`、账号选择失败、failover 频率、实际摘除时长和提前恢复次数（分析脚本已可产出上述指标，持续告警需另立设计）。
- [ ] 管理台账号健康时间线、漂移/冷重建 top 会话及跨用户受影响范围视图（另行设计）。

## 七、后续配套（行为变更，非本设计范围）

- 开启 sticky TTL 滑动续期：`renewalThresholdMinutes > 0`（`redis.js` `extendSessionAccountMappingTTL` 已实现，默认关闭）。预期消除大部分 B 型漂移，收益以 `expired`/`miss` 事件前后对比验证，按生产数据预估约 3–5M 全价 token/周。`renewed` 事件已实现，续期开启后自动产生度量数据。
- temp_error 账号恢复后记录 preferred account，减少漂移不回迁问题。
- 高并发用户（并行 subagent 风暴）的 per-key 并发上限或独立账号池。

## 八、验证方案

上线后用以下查询自检（用 `scripts/analyze-upstream-telemetry.js logs/llm-telemetry-*.log`）：

1. `attempt_count > 1` 的请求占比 > 0（与 relay 重试日志、`upstream_attempt` 及 `retry_reason` 分布交叉验证）。
2. 每次 `sticky_session_lifecycle deleted` 都能找到同 `session_hash` 的后续 `set`/`miss`，或能解释为会话结束。
3. 人为触发一次账号限流（测试 key 高并发），确认 `account_failover` 与对应 `deleted` 事件正确。
4. 现有核心事件量与原有请求事件量级可控，确认没有因 `hit` 路径产生一请求一事件的膨胀。
5. 开启 TTL 续期前后各取一周，对比 `miss_after_prior_set` 数量与 B 型冷重建 token 量；`expired` 仅作为 Redis 竞态辅助指标，不作为 TTL 续期收益的主指标。
6. 对同一测试账号分别制造上游 `429`、账号池耗尽和模型不支持，确认三者的 `failure_stage`、三层状态码和稳定错误码互不混淆。
7. 制造“账号收到 `429` 后仍有在途请求成功”的竞态，确认 `account_suppressed` 与 `account_recovered` 能记录预期/实际摘除时长及 `recovery_source=successful_inflight_response`。
