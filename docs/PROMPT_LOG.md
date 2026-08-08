# CRS 最新用户 Prompt 日志设计

## 一、目标

Prompt Log 用于工作内容审计。它与 harness/tool telemetry 完全独立，只记录员工通过 API Key 发出的最新用户 Prompt，不记录模型回复、工具参数、工具结果正文或完整请求体。

本阶段使用独立 Winston logger 写入本地明文日志，不使用数据库，不做脱敏，不接入生产请求路径。

## 二、提取规则

当前基础设施支持 Anthropic Messages 请求：

1. 从 `messages` 尾部向前查找 `role=user`。
2. 字符串 `content` 直接作为候选 Prompt。
3. 数组 `content` 从尾部向前查找最后一个非空顶层 `type=text` 块。
4. `tool_result`、`tool_use_result` 及其内部文本不作为用户 Prompt。
5. 如果最后一条 user 消息只有工具结果，继续向前查找更早的 user 文本。
6. 同一 user 消息混合 `tool_result + text` 时，只保留最后一个普通 text 块。

记录中的 `prompt` 保留原始明文，包括大小写、换行、标点和首尾空白。是否为空只通过 `trim()` 判断；用于去重的 hash 会去除首尾空白和 NUL，但不会改变内部内容。

## 三、Session LRU 去重

Claude Code 在一次人工输入后会因工具调用、工具结果回传和 agent 自动续跑多次请求模型。后续请求仍携带原始用户输入，因此需要按 session 去重。

Session key：

```text
SHA-256(APIKeyID + NUL + "anthropic" + NUL + lower(client_session_id))
```

LRU 中仅保存 session key 摘要和最新 Prompt hash，不保存 Prompt 明文或原始 session ID。

规则：

- 同一 session、相同 Prompt 连续出现：只记录一次。
- 同一 session 按 A、B、A 出现：记录三次。
- 不同 session 的相同 Prompt：分别记录。
- 没有可靠 `client_session_id`：仍记录，但不做跨请求去重。
- 上下文压缩、历史裁剪或消息数量变小：不影响去重。

默认最大 10,000 个 session，空闲 TTL 24 小时。复用现有同步 `LRUCache`；检查、写 logger 和更新缓存之间没有 `await`，在 Node.js 单进程事件循环内不会发生同一 session 的异步穿插。

已知限制：

- 同一 session 连续两次人工输入完全相同的文本也只记录一次。
- 进程重启或 LRU 淘汰后，活跃 session 当前 Prompt 可能再次记录。
- 多进程和多副本各自拥有独立 LRU，不能保证全局去重；需要时应迁移到 Redis 原子操作。
- 如果客户端把压缩摘要或自动指令编码为普通 `role=user/type=text`，仅靠标准协议无法证明它不是真人输入。

## 四、日志记录

统一调用：

```js
logger.promptLog(record)
```

使用独立 `winston-daily-rotate-file` transport：

- 文件：`prompt-log-%DATE%.log`。
- 每天轮转，并受独立 `maxSize` 限制。
- 默认保留 32 天。
- 不压缩，文件 stream mode 为 `0600`。
- 不进入 `claude-relay-*.log`，不输出到控制台。
- 使用一行一个结构化 JSON object；`prompt` 字段保存明文。
- best-effort 写入失败不阻断 LLM 请求。

配置：

```text
PROMPT_LOG_ENABLED=false
PROMPT_LOG_MAX_SIZE=100m
PROMPT_LOG_MAX_FILES=32d
PROMPT_LOG_CACHE_SIZE=10000
PROMPT_LOG_CACHE_TTL_MS=86400000
```

示例记录：

```json
{
  "schema_version": 1,
  "event_type": "user_prompt_observed",
  "timestamp": "2026-08-08T10:00:00.000Z",
  "gateway_request_id": "request-id",
  "api_key_record_id": "key-id",
  "api_key_name": "employee-name",
  "client_session_id": "session-uuid",
  "session_id_source": "header",
  "route": "/v1/messages",
  "model": "claude-sonnet-...",
  "message_count": 8,
  "prompt_hash": "sha256",
  "prompt_length": 42,
  "prompt": "用户原始输入"
}
```

## 五、隐私与运维

Prompt Log 明确包含未脱敏的员工输入，敏感级别高于 telemetry 和普通运行日志：

- 必须保持功能默认关闭。
- 日志目录和文件只允许 CRS 服务账号及获授权管理员读取。
- 不得把 Prompt Log 上传到普通日志聚合平台。
- transport 错误只写标准错误信息，不能把失败 record 连同 Prompt 写入普通日志。
- prompt log 与 telemetry 使用不同文件、开关、模块和未来的数据表。

## 六、模块接口

```js
extractLatestUserPrompt(requestBody)
buildPromptSessionKey(apiKeyId, clientSessionId)
hashPrompt(prompt)
PromptLogger.recordRequest(req, sessionInfo)
```

`recordRequest()` 返回：

```text
logged                 已交给 Winston transport
duplicate              被同 session LRU 去重
no_prompt              请求没有普通用户文本
logger_unavailable     功能关闭或 logger 不可用
```

只有 logger 接受记录后才更新 LRU；功能关闭或同步入队失败时不更新缓存。

## 七、最低测试要求

- 多文本块只取最后一个普通 `text`。
- tool-result-only 请求回退到更早的人工 Prompt。
- 混合 `tool_result + text` 只保存普通 text。
- 四次相同 session 的 agent 请求只写一条。
- 不同 session 相同 Prompt 分别写入。
- A、B、A 写入三条。
- 无 session 时不执行跨请求去重。
- Prompt 明文原样进入 record，不做脱敏。
- logger 拒绝时不提交 LRU 状态。
- Prompt transport 与普通日志和控制台隔离。

## 八、后续接入

基础设施验证后，再以独立提交接入 `/v1/messages` 请求入口：

1. 使用 `sessionHelper.extractClientSessionId(req.headers, req.body)`。
2. 在请求 body 被转换前调用 `recordRequest()`。
3. Prompt Log 失败不得阻断请求。
4. 先保持开关关闭，部署后用测试 API Key 小范围验证。
