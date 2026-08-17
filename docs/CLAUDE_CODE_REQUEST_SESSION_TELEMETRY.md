# CRS Harness/Tool Telemetry 设计

本文档描述 CRS 如何在不保存 prompt 正文的前提下，记录 Claude Code 等 harness 与 LLM、工具之间的交互摘要，用于评估 harness/tool 的使用效能。

Prompt 留存属于独立的工作审计需求，不由本模块实现，也不与本模块共用数据表或日志文件。

## 一、目标与非目标

### 1.1 目标

Telemetry 需要支持按员工 API Key、harness、模型和 session 分析：

- 请求量、成功率、错误率和延迟分布。
- input、output、cache create、cache read token 与成本。
- harness 向模型提供了多少工具。
- 模型实际选择了哪些工具、每轮调用多少工具、是否出现并行工具调用。
- 下一轮请求带回了多少 `tool_result`，其中多少明确标记为错误。
- 每个 session 的请求轮数、工具调用数、token 消耗和 cache 命中率。
- 不同 harness 版本或配置之间的指标差异。

### 1.2 非目标

本模块不记录：

- 完整 prompt、system prompt、thinking 或 response 文本。
- tool schema、tool input 或 tool result 正文。
- `Authorization`、API Key、OAuth token 等凭据。
- 员工本地工具的真实执行耗时或本地进程状态。
- 任务是否真正完成、结果是否正确等无法由网关可靠判断的结论。
- 工作审计使用的“每个 session 最新用户 prompt”。

Telemetry 指标只能说明网关可见的 harness/LLM/tool 交互效率。比较 harness 效能时还必须按模型、请求复杂度、上游类型和时间范围归一化，不能仅凭 token 或工具调用数判断员工产出。

## 二、网关可见边界

CRS 可以从 Anthropic Messages 请求和响应中可靠观察：

- `X-Claude-Code-Session-Id` 或 `metadata.user_id.session_id`。
- CRS 生成的 `gateway_request_id`。
- API Key 记录 ID 与名称快照。
- model、stream、messages 数量、tools 列表和 system/tool schema 的指纹。
- 历史消息中的 `tool_use`、`tool_result` 及 `tool_result.is_error`。
- 当前响应的 `stop_reason`、`tool_use` 名称和 token usage。
- 网关、调度和上游请求阶段的延迟。

CRS 通常不能从标准 Anthropic 请求精确观察：

- 普通 Claude Code subagent 的 `agent_id`。
- 工具在员工机器上的真实执行开始、结束、取消和耗时。
- 本地工具异常是否被 harness 吞掉。
- 一次 session 对应的业务任务是否成功完成。

如果未来需要这些数据，应由 harness 使用专用 header 或独立客户端事件上报。推断字段必须使用 `inferred_*` 命名，不能覆盖真实字段。

## 三、Session 与请求标识

CRS 已支持以下 session ID 提取顺序：

1. `X-Claude-Code-Session-Id` header。
2. `body.metadata.user_id` JSON 中的 `session_id`。
3. 旧格式 `session_<uuid>`。
4. 内容 hash fallback，仅作为 `sticky_session_key`，不是真实 session UUID。

Telemetry 必须区分：

```text
client_session_id     客户端根会话 ID
sticky_session_key    CRS 调度使用的 sticky key
gateway_request_id    一次 CRS HTTP 请求
upstream_request_id   上游返回的请求 ID（如果可用）
queue_request_id      CRS 内部队列/并发锁 ID（如果需要）
```

普通 Claude Code subagent 共享根 `client_session_id`。标准请求通常不包含 `agent_id`，不能使用 prompt、token 阶梯或工具名称推断出精确 subagent 身份。

## 四、事件模型

### 4.1 一次请求只有一个终态

一条 telemetry 记录对应一次网关 LLM 请求，而不是一个 SSE chunk。

允许的终态：

```text
llm_request_completed
llm_request_error
```

同一 `gateway_request_id` 最多写一条终态记录。流式 callback、客户端断开监听器和外层异常处理必须汇聚到同一个 `finalizeTelemetry()`，不能分别写入完成和错误事件。

### 4.2 成功但没有 usage

上游成功返回但没有 usage 时仍属于完成事件：

```text
event_type = llm_request_completed
response_completed = true
usage_available = false
```

只有上游错误、调度失败、流异常或客户端中断等实际失败才写 `llm_request_error`。

### 4.3 重试

同一次客户端请求发生内部账户重试时，必须复用同一个 telemetry context。最终记录可增加：

```text
attempt_count
retry_reason
```

不能为每次内部账户尝试生成一条相同 `gateway_request_id` 的终态记录。

## 五、Schema v1

Telemetry 使用结构化 JSON，每条日志一条 JSON object。示例：

```json
{
  "schema_version": 1,
  "event_type": "llm_request_completed",
  "request_started_at": "2026-08-08T10:00:00.000Z",
  "timestamp": "2026-08-08T10:00:04.200Z",
  "gateway_request_id": "request-id",
  "upstream_request_id": null,
  "api_key_record_id": "key-record-id",
  "api_key_name": "employee-name",
  "client_session_id": "session-uuid",
  "session_id_source": "header",
  "sticky_session_key": "session-uuid",
  "harness_id": "claude-code",
  "harness_version": null,
  "harness_source": "user_agent",
  "harness_config_hash": "sha256-prefix",
  "route": "/v1/messages",
  "provider": "anthropic",
  "account_id": "account-id",
  "account_type": "claude-console",
  "model": "claude-sonnet-4-...",
  "stream": true,
  "message_count": 12,
  "tools_offered_count": 8,
  "tool_names": ["Read", "Edit", "Bash"],
  "tool_schema_hash": "sha256-prefix",
  "system_prompt_hash": "sha256-prefix",
  "tool_result_count": 2,
  "tool_result_error_count": 0,
  "stop_reason": "tool_use",
  "tool_use_count": 2,
  "tool_use_names": ["Read", "Edit"],
  "parallel_tool_use_detected": true,
  "input_tokens": 12345,
  "output_tokens": 678,
  "cache_creation_input_tokens": 1000,
  "cache_read_input_tokens": 9000,
  "cache_creation_ephemeral_5m_input_tokens": 1000,
  "cache_creation_ephemeral_1h_input_tokens": 0,
  "total_tokens": 23023,
  "cost": 0.123456,
  "usage_available": true,
  "queue_latency_ms": 10,
  "upstream_latency_ms": 4100,
  "ttft_ms": 350,
  "total_latency_ms": 4200,
  "attempt_count": 1,
  "status_code": 200,
  "upstream_status_code": 200,
  "response_completed": true,
  "client_disconnected": false,
  "error_type": null,
  "error_code": null
}
```

### 5.1 Harness 身份

优先使用明确的 CRS 专用 header；没有时再从经过清理的 `User-Agent` 推断：

```text
X-CRS-Harness
X-CRS-Harness-Version
```

需要同时保存 `harness_source = explicit_header | user_agent | unknown`。不能把推断值记录成确定事实。

`harness_config_hash` 用于区分同一 harness 的配置变体，建议由规范化后的 system prompt hash 与 tool schema hash组合生成，不保存原文。

### 5.2 工具摘要

工具字段区分三个阶段：

```text
tools_offered_*       当前请求向模型提供的工具
tool_result_*         当前请求历史中带回的工具结果
tool_use_*            当前响应中新产生的工具调用
```

`tool_names` 和 `tool_use_names` 应去重、排序并限制数量及单个名称长度。禁止记录 tool input、tool result content 和完整 schema。

### 5.3 指纹

`system_prompt_hash`、`tool_schema_hash` 和 `harness_config_hash` 使用稳定、规范化输入计算 SHA-256。指纹用于比较配置是否相同，不用于还原内容。

对象必须递归按 key 排序后再序列化，避免仅因 JSON key 顺序不同产生不同 hash。

### 5.4 延迟

需要明确区分：

```text
queue_latency_ms       CRS 排队或等待并发槽的时间
upstream_latency_ms    发起上游请求到响应结束
ttft_ms                发起上游请求到首个有效响应事件
total_latency_ms       CRS 接收到请求到最终终态
```

如果某阶段无法测量，使用 `null`，不能用 `0` 表示未知。

### 5.5 失败分层与三层状态码（schema v2 补充）

`llm_request_error` 额外携带以下字段，消除"网关合成状态被误读为上游状态"的歧义：

```text
client_status_code     客户端实际收到的 HTTP 状态（= 旧 status_code，兼容期保留）
gateway_status_code    网关决定返回的状态（如 ALL_ACCOUNTS_RATE_LIMITED 合成的 429）
upstream_status_code   最后一次真实上游响应的状态（未到达上游时为 null）
failure_stage          account_selection | queue | upstream_http | upstream_stream | relay | client_disconnect
upstream_error_type    上游错误类型（脱敏枚举）
upstream_error_code    上游错误码（如智谱 1302）
upstream_message_template  上游错误消息模板（数字/ID 归一为 <n>/<id>，不落原文）
```

逐次上游尝试、账号生命周期与 sticky 事件见 `UPSTREAM_TELEMETRY_DESIGN.md`。

## 六、可派生指标

基础 telemetry 可以聚合出：

```text
工具采用率 = 产生 tool_use 的请求数 / 提供 tools 的请求数
工具结果错误率 = tool_result_error_count / tool_result_count
每次工具调用 token = total_tokens / tool_use_count
Cache 命中率 = cache_read_input_tokens / 总输入 token
并行工具使用率 = parallel_tool_use_detected 的请求数 / tool_use 请求数
Session 请求轮数 = 每个 client_session_id 的 gateway_request_id 数量
Session 工具调用数 = 每个 client_session_id 的 tool_use_count 总和
```

比较 harness 版本时至少需要同时按 model、provider、stream、tools offered 范围和时间窗口分组。Telemetry 本身只能提供相关性，不能证明某个 harness 导致员工效率提升。

## 七、Winston 存储方案

Telemetry 不直接调用 `fs.appendFile()`，也不使用 `safeRotatingAppend()`。统一调用：

```js
logger.telemetry(record)
```

`logger.telemetry()` 使用独立的 Winston logger 与 `winston-daily-rotate-file` transport：

- 不写入普通 `claude-relay-*.log`。
- 不输出到控制台。
- 使用结构化 JSON 格式。
- 文件名为 `llm-telemetry-%DATE%.log`。
- 使用独立的 `maxSize`、`maxFiles` 和 audit file。
- 默认作为 best-effort telemetry；写入失败不阻断 LLM 请求。

建议配置：

```text
LLM_TELEMETRY_ENABLED=false
LLM_TELEMETRY_MAX_SIZE=100m
LLM_TELEMETRY_MAX_FILES=32d
```

`winston-daily-rotate-file` 解决单进程内的并发写入、日期分片、压缩和保留问题，但不提供数据库事务或跨进程 exactly-once。若使用 PM2 cluster 或多个副本，必须为每个进程使用不同文件名，或改用集中式日志/数据库。

服务退出时应关闭并 flush telemetry logger。transport 的 `error` 事件必须记录到普通错误日志，但不能递归写回 telemetry logger。

## 八、模块职责

建议接口：

```js
createTelemetryContext(req, sessionInfo)
summarizeRequestForTelemetry(requestBody, headers)
summarizeResponseForTelemetry(responseOrStreamSummary)
finalizeTelemetry(context, outcome)
```

职责划分：

- `logger.js`：独立 transport、轮转、结构化输出和开关。
- `llmTelemetry.js`：字段提取、指纹、schema、终态幂等。
- `llmRequestObserver.js`：连接请求入口和响应生命周期，汇总调度结果、usage、SSE 摘要和延迟。
- 路由/relay：只把已有的调度结果和 usage 交给 observer，不负责拼装最终 schema。

`finalizeTelemetry()` 应在调用时同步将 context 标记为 finalized，再调用 best-effort logger，防止多个异步 callback 写入两个终态。它应返回是否接受了本次终态，方便测试和诊断。

## 九、隐私与访问控制

- Telemetry 与 prompt 审计使用不同文件、配置、模块和未来的数据表。
- 不保存请求 body 或响应 body。
- error 只保存标准化的 `error_type`、`error_code`，默认不保存上游原始 message。
- tool 名称和 API Key 名称也属于内部数据，应限制日志目录读取权限。
- 指纹只能用于相等性比较，不能作为内容审计替代品。
- 文档、测试 fixture 和日志中不得包含真实 API Key、OAuth token 或员工 prompt。

## 十、当前接入状态

已完成：

- Session ID 支持 header、JSON metadata、legacy 格式和兼容的内容 hash fallback。
- `/v1/messages`、`count_tokens`、官方 Claude 二次调度和 Anthropic-to-Gemini bridge 已统一传递 headers。
- `llmRequestObserver.js` 已接入 `/v1/messages` 和 `/claude/v1/messages` 的共享 handler。
- Claude、Console、Bedrock、CCR、Gemini CLI 和 Antigravity 共用同一终态生命周期。
- `finish`、异常 `close`、HTTP 错误和 Anthropic SSE error 只会竞争产生一个终态。
- 流式响应旁路提取 `stop_reason`、tool use 名称、usage、upstream request ID 和 TTFT。
- 非流式响应通过 `res.json()` 或显式 response observation 提取相同摘要。
- 内部 Console 并发降级重试复用同一个 context，并增加 `attempt_count`。
- observer 只在 `LLM_TELEMETRY_ENABLED=true` 时包装响应方法和解析 SSE。
- Gemini CLI/Antigravity 的 provider 与 `account_type=gemini` 可记录；bridge 内部选出的具体 `account_id` 当前仍为空。

仍待完成：

- 开启 feature flag 进行小流量验证。
- 增加离线分析脚本或导入 PostgreSQL，用于按 harness/session 聚合。
- 若未来新增不输出 Anthropic 兼容 SSE 的 provider，需要为它补充专用响应摘要适配。

## 十一、最低测试要求

- 同一 context 只能 finalize 一次。
- 完成和错误 callback 竞争时只接受第一个终态。
- 成功但无 usage 仍记录 completed。
- tool summary 不包含 tool input、result content 或 schema 正文。
- 规范化 hash 不受对象 key 顺序影响。
- tool 名称去重、排序、截断。
- telemetry 关闭时不创建文件。
- telemetry transport 与普通日志及控制台隔离。
