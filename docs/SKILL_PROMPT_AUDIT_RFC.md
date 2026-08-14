# RFC：网关侧 SKILL Prompt 注入审计

- 状态：Proposed
- 日期：2026-08-14
- 适用范围：CRS 网关、`llm-telemetry`、`user-prompt` 日志
- 约束：不修改 Claude Code 客户端，只在网关层分析已收到的 Anthropic Messages 请求

## 1. 摘要

本文提出一套仅依赖网关请求内容的 SKILL Prompt 注入审计方案，用于分析以下问题：

- SKILL 是否被重复注入；
- SKILL 内容是否过大并增加输入 token；
- 上下文压缩后是否重新灌入完整 SKILL；
- 隐藏上下文是否可能影响 Prompt Cache 命中率；
- 当前 `user-prompt` 日志是否把 SKILL 内容误判为员工输入。

由于不修改 Claude Code，网关无法获得客户端内部的 SKILL 对象、版本、触发原因或 Agent 父子关系。因此本 RFC 不把内容分析结果定义为完整事实，而是采用带置信度的 `exact_marker`、`strong_pattern`、`heuristic` 三级观测结果。

核心原则是：

1. 记录实际请求中可观察到的注入结果，不推断不可观察的客户端状态；
2. SKILL 和 `system-reminder` 分析链路与 `prompt-log` 一样允许落盘明文：SKILL 名称、路径、长度以及机器注入正文直接记录，不再通过 hash 间接表示；
3. SKILL 和 `system-reminder` 明文写入 `prompt-log` 的独立 transport，telemetry 仍只记录摘要；
4. 重复注入判断基于与上一次请求的增量对比，区分历史延续、新注入和重新注入；
5. 不新增独立开关，SKILL 分析跟随 `PROMPT_LOG_ENABLED`，telemetry 字段跟随 `LLM_TELEMETRY_ENABLED`。

## 2. 背景与问题

运维侧希望观察和优化以下 Agent 使用问题：

- 客户端版本老旧；
- 子代理或请求并发数量不合理；
- 缓存输入比例较低；
- 工具调用过多、失败或重复；
- SKILL Prompt 注入过大或重复，导致上下文和缓存效率下降。

当前 CRS 已有两类独立日志：

- `prompt-log`：记录最新用户 Prompt 明文，用于工作审计；
- `llm-telemetry`：记录请求级 Harness、工具、Token、缓存、延迟和错误摘要。

当前 telemetry 已记录 `system_prompt_hash`，但这不足以审计 SKILL，原因是 Claude Code 的 SKILL 不只会改变 `system` 字段。

## 3. Claude Code 行为分析

### 3.1 SKILL 的元数据模型

在参考源码中，SKILL/Prompt Command 具有以下内部属性：

- `name`；
- `version`；
- `source`；
- `loadedFrom`；
- `context`，可为 `inline` 或 `fork`；
- `agent`；
- `paths`；
- `allowedTools`；
- `contentLength`；
- `pluginInfo`；
- 动态生成的 Prompt 内容。

这些信息存在于 Claude Code 内部，但在不修改客户端的前提下，通常不会完整进入网关请求。

参考：

- [`command.ts`](/home/qyb/claude-code-cli/claude-code/src/types/command.ts:25)
- [`loadSkillsDir.ts`](/home/qyb/claude-code-cli/claude-code/src/skills/loadSkillsDir.ts:185)

### 3.2 SKILL 不等于 `system` 字段

普通 inline SKILL 的实际内容会作为隐藏的 `user` 消息进入上下文，并使用 `<system-reminder>` 包裹。SKILL 被调用后，Claude Code 还可能在后续上下文压缩恢复时重新注入已调用 SKILL。

参考：

- [`messages.ts`](/home/qyb/claude-code-cli/claude-code/src/utils/messages.ts:3097)
- [`messages.ts`](/home/qyb/claude-code-cli/claude-code/src/utils/messages.ts:3644)

因此，以下情况都可能发生：

```text
requestBody.system 发生变化
requestBody.messages 中增加隐藏 user/system-reminder 消息
requestBody.messages 中重新出现之前的 SKILL 内容
fork 子代理收到 SKILL 作为初始 user 消息
```

关键背景：Anthropic Messages API 是无状态的，Claude Code 每次请求都会重发完整消息历史。因此 SKILL 内容出现在后续请求中是常态，不能把"同一内容再次出现"直接判定为浪费或重复注入。有意义的问题是：内容位于未变化的历史前缀中（延续，可被缓存命中），还是出现在新增消息中（新注入），或在消失后于新位置重新出现（压缩恢复）。

### 3.3 可识别的文本标记

源码中存在若干可供网关识别的标记。

SKILL 加载元数据示例：

```text
<command-message>skill-name</command-message>
<command-name>skill-name</command-name>
<skill-format>true</skill-format>
```

已调用 SKILL 的恢复内容示例结构：

```text
The following skills were invoked in this session:

### Skill: <name>
Path: <path>

<skill content>
```

SKILL 列表或发现结果也可能以系统提醒形式出现，但这只说明 SKILL 可用或被发现，不代表正文已注入。

参考：

- [`processSlashCommand.tsx`](/home/qyb/claude-code-cli/claude-code/src/utils/processUserInput/processSlashCommand.tsx:782)
- [`messages.ts`](/home/qyb/claude-code-cli/claude-code/src/utils/messages.ts:3503)

原始注入与恢复注入的标记格式不同：原始注入带 `<command-message>` 组合标记，恢复注入带 `### Skill:` / `Path:` 结构。这使网关能够区分两者，而不必依赖弱推断。

## 4. 当前 CRS 实现

### 4.1 `prompt-log`

当前 `prompt-log`：

- 从最后一条普通 `user` 文本中提取 Prompt；
- 忽略 `tool_result`；
- 保存 Prompt 明文、hash、长度、API Key、session、路由和模型；
- 对同一 API Key/session/Prompt 使用 LRU 去重；
- 默认关闭，写入独立的 `prompt-log-%DATE%.log`。

实现：[`promptLogger.js`](/home/qyb/CRS/ag-crs/src/utils/promptLogger.js:21)

当前存在一个与 SKILL 相关的风险：提取逻辑只检查 `role=user` 和文本块。如果 SKILL 被序列化为隐藏 `user` 消息，网关可能把 SKILL 内容误认为最新员工 Prompt，写入 `user_prompt_observed` 记录，污染员工输入审计。

### 4.2 `llm-telemetry`

当前 telemetry 已记录：

- Harness ID 和版本；
- `system_prompt_hash`、`tool_schema_hash`、`harness_config_hash`；
- 工具提供数量和工具名称；
- 工具结果数量及错误数量；
- 模型工具调用数量、名称和并行调用推断；
- input/output/cache create/cache read token；
- 成本、延迟、状态、错误和重试。

实现：[`llmTelemetry.js`](/home/qyb/CRS/ag-crs/src/utils/llmTelemetry.js:144)

当前缺少：

- SKILL 名称、路径和注入分类；
- SKILL 注入长度；
- SKILL 是否为压缩后重新注入；
- 可直接用于分析的 SKILL 与缓存关联字段。

## 5. 目标与非目标

### 5.1 目标

本 RFC 目标是让运维能够回答：

1. 哪些请求疑似包含 SKILL 注入；
2. 哪些 SKILL 注入内容最大；
3. 哪些 SKILL 在压缩后被重新注入（而非普通历史延续）；
4. 哪些 session 反复发生 SKILL 新注入；
5. SKILL 注入量与 `cache_read_input_tokens`、总输入 token、请求轮数之间是否相关；
6. `user-prompt` 日志中员工输入与机器注入内容正确分离，SKILL 和 `system-reminder` 明文进入独立记录类型。

### 5.2 非目标

本 RFC 不承诺：

- 准确识别所有自定义 SKILL；
- 获得客户端内部的真实 SKILL 版本；
- 准确还原 `inline`/`fork` 执行上下文；
- 准确识别 SKILL 的触发者；
- 通过文本分析证明 SKILL 导致了某个具体效率问题；
- 记录工具参数或工具结果正文。

## 6. 方案概览

新增一个网关侧内容分析模块：

```text
src/utils/skillPromptAnalyzer.js
```

由 `llmRequestObserver` 在观察请求时调用：

```text
request body + 上一次请求摘要
   ↓
skillPromptAnalyzer.analyze(requestBody, previousState)
   ↓
skill analysis summary（含每个 SKILL 的注入分类）
   ↓
promptLogger（SKILL/system-reminder 明文记录）/ llmTelemetry.finalizeTelemetry()（摘要字段）
```

分析器只读取内存中的请求 body。SKILL 和 `system-reminder` 明文只进入 `prompt-log` 的独立 transport；telemetry 只接收不含正文的摘要字段。

## 7. 检测算法

### 7.1 输入范围

分析以下字段：

- `requestBody.system`；
- `requestBody.messages[*].content` 中的文本块；
- `requestBody.messages[*].role`。

为减少信息输出、控制日志体积并简化不必要的设计，本方案默认不分析或保存：

- 工具 input；
- 工具 result 正文。

### 7.2 检测级别

```text
exact_marker
```

匹配固定的 `invoked_skills`、`<skill-format>true</skill-format>` 等标记，并成功提取名称。

```text
strong_pattern
```

匹配 `<system-reminder>`、`### Skill:`、`Path:` 等组合结构，但缺少完整固定标记。

```text
heuristic
```

只有通用 `<system-reminder>`、隐藏 user 消息、消息长度异常变化等弱信号。其中"消息长度异常变化"依赖与上一次请求的基线对比，session 首次请求时该信号不可用，不参与 `heuristic` 判定。

所有检测结果都必须携带：

```text
skill_detection_confidence
skill_detection_rule_version
```

### 7.3 SKILL 分类

建议至少支持以下 `skill_detection_type`：

```text
invoked_skills
skill_command_marker
skill_listing
skill_discovery
generic_system_reminder
possible_skill_injection
unknown_meta_injection
```

其中 `skill_listing` 和 `skill_discovery` 不应计入实际 SKILL 正文大小，只计入可用性/发现信号。

### 7.4 大小计算

对检测到的文本片段：

1. 去除外围 `<system-reminder>` 标签；
2. 规范化换行符；
3. 计算字符数；
4. 计算 SHA-256 作为内容 hash（仅用于跨请求比对和去重，不作为脱敏手段）。

字段命名：

```text
skill_chars
```

`skill_chars` 统计本次请求快照中所有检测到的 SKILL 文本字符总和，**包含 `carried_over` 的部分**。这与 telemetry §8 中该字段的定义一致。`carried_over` 内容虽通常被 Prompt Cache 命中，但其字符量仍是分析 SKILL 在总输入中占比的必要基数，排除它会低估注入体积。`newly_injected` 和 `re_injected` 的单独量可通过 `skill_newly_injected_count` 和 `skill_reinjected_count` 反映，不需要从 `skill_chars` 中拆分。


### 7.5 增量对比与注入分类

以 `api_key_record_id + client_session_id` 为范围，在内存中维护有界的 LRU 状态，保存每个 session 最近一次请求的：

- 消息内容 hash 列表（按消息索引）；
- 已见过的 SKILL 内容 hash 及其首次出现的标记格式（command marker 或 rehydrate 结构）。

LRU 的 key 直接复用 `promptLogger` 导出的 `buildPromptSessionKey(apiKeyId, clientSessionId)`（即对 `apiKeyId + "\0" + "anthropic" + "\0" + normalizedSessionId` 取 SHA-256），不重复实现构造逻辑，也不在内存中保存原始 apiKeyId 字符串。


对本次请求中检测到的每个 SKILL，与上一次请求对比后分类为：

```text
carried_over      内容位于未变化的历史消息中（索引与 hash 均一致）
newly_injected    内容出现在上一次请求不存在的新消息中
re_injected       内容此前存在、随后消失、本次又出现在新位置
```

分类规则：

- hash 与索引都匹配上一次请求 → `carried_over`；
- hash 未见过，或出现在新增索引处 → `newly_injected`；
- hash 见过但上一次请求中不存在，本次出现在新索引 → `re_injected`。

`re_injected` 且本次标记格式为恢复结构（`### Skill:` / `Path:`）时，判定为压缩恢复：

```text
skill_rehydrated = true
```

由于原始注入与恢复注入的标记格式可区分（见 3.3），该判定通常是强信号，不再需要 `unknown` 三态。

状态说明：

- LRU 容量与 TTL 沿用 `promptLogger` 的现有取值方式；
- 状态仅存于当前进程内存。多实例部署且同一 session 被路由到不同实例时，增量对比会退化为 `newly_injected`（假阴性 `carried_over`），不会产生错误明文记录，可接受。

## 8. Telemetry Schema 变更

在现有 `llm_request_completed` 和 `llm_request_error` 中增加以下摘要字段（不含明文）：

```json
{
  "skill_detected": true,
  "skill_detection_confidence": "exact_marker",
  "skill_detection_rule_version": 1,
  "skill_detection_types": ["invoked_skills"],
  "skill_names": ["verify"],
  "skill_count": 2,
  "skill_chars": 18420,
  "skill_newly_injected_count": 1,
  "skill_reinjected_count": 0,
  "skill_rehydrated": false
}
```

字段定义（消除聚合歧义）：

- `skill_names`：本次请求快照中检测到的全部 SKILL 名称（含 `carried_over`），清洗、去重后按字典序排序；
- `skill_count`：`skill_names` 的元素数量，是本次请求的瞬态计数而非 session 累计。不变量：`skill_newly_injected_count + skill_reinjected_count <= skill_count`；
- `skill_chars`：本次请求快照中所有 SKILL 文本的字符总和（含 `carried_over`），见 §7.4；
- `skill_newly_injected_count` / `skill_reinjected_count`：本次新增/重新注入的 SKILL 数量；
- `skill_detection_confidence`：取本次所有检测结果中的最高置信度；
- `skill_rehydrated`：本次请求中任一 SKILL 满足压缩恢复判定即为 `true`。


### 8.1 名称字段策略

SKILL 名称和路径在 `exact_marker` 或 `strong_pattern` 下直接保存清洗后的明文，与 `prompt-log` 的敏感级别一致，沿用 telemetry 文件的现有访问控制。只有 `heuristic` 级别的未知内容不记录名称。

## 9. Prompt Log 变更

`prompt-log` 记录明文的能力扩展到 SKILL 和 `system-reminder` 机器注入内容，同时与员工输入严格分离。

### 9.1 Prompt 来源分类

提取 Prompt 时增加内部分类：

```text
prompt_source = human
prompt_source = skill_injection
prompt_source = system_reminder
prompt_source = tool_result
prompt_source = unknown_meta
```

- `prompt_source=human`：写入现有 `user_prompt_observed` 记录（明文）；
- `prompt_source=skill_injection`：写入新的 `skill_prompt_observed` 记录（明文）；
- `prompt_source=system_reminder`：写入 `skill_prompt_observed` 记录（明文），并在记录中保留该来源类型；这类内容仍按 `heuristic` 或实际匹配到的置信度处理，不因此视为确定的 SKILL；
- 其余来源不写入明文记录。

### 9.2 `skill_prompt_observed` 记录（包括 SKILL 与 `system-reminder`）

```json
{
  "schema_version": 2,
  "event_type": "skill_prompt_observed",
  "timestamp": "…",
  "gateway_request_id": "…",
  "api_key_record_id": "…",
  "client_session_id": "…",
  "route": "…",
  "model": "…",
  "prompt_source": "skill_injection",
  "skill_name": "verify",
  "skill_path": "…",
  "skill_detection_confidence": "exact_marker",
  "skill_detection_rule_version": 1,
  "skill_injection_kind": "newly_injected",
  "skill_rehydrated": false,
  "skill_chars": 18420,
  "prompt": "<SKILL 或 system-reminder 注入正文明文>"
}
```

当 `prompt_source=system_reminder` 时，`skill_name` 和 `skill_path` 通常为 `null`，`skill_detection_confidence` 通常为 `heuristic`，`skill_detection_types` 由 telemetry 摘要保留为 `generic_system_reminder`。这类记录用于审计实际观察到的机器注入正文，不代表网关已经证明其来自 SKILL。

落盘范围：

- 只记录 `newly_injected` 和 `re_injected` 的 SKILL 或 `system-reminder` 明文；
- `carried_over` 的内容位于未变化的历史消息前缀中，每个请求都会完整重发，逐请求落盘会产生大量重复记录；更重要的是，它大概率已被上游 Prompt Cache 命中，边际成本远低于全价输入，不构成需要单独记录的新注入事件。因此只进入 telemetry 的 `skill_count` 和 `skill_chars` 计数，不写明文记录。


### 9.3 排除规则

至少将以下内容排除出 `user_prompt_observed`；如果其中属于可识别的机器注入片段，则按 §9.1 写入 `skill_prompt_observed`，而不是丢弃：

```text
<system-reminder>...</system-reminder>
<command-message>...</command-message>
<command-name>...</command-name>
<command-args>...</command-args>
<command-contents>...</command-contents>
<local-command-stdout>...</local-command-stdout>
<skill-format>true</skill-format>
The following skills were invoked in this session:
The following skills are available for use with the Skill tool:
```

对于混合消息，应优先保守处理：如果无法确定一段文本是员工输入还是机器注入，不写入 `user_prompt_observed`。

## 10. 缓存效率分析

SKILL 分析本身不产生因果结论，只提供可关联维度。

建议派生以下指标：

```text
Skill 注入字符占比
  = skill_chars / 本次请求全部消息字符数

Skill 新注入率
  = 含 newly_injected skill 的请求数 / 检测到 skill 的请求数

Skill 恢复注入次数
  = skill_rehydrated=true 的请求数

Skill 相关缓存读取率
  = cache_read_input_tokens / (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)
```

注意：不定义"重复 token 浪费估算"指标。`carried_over` 内容位于未变化前缀中，通常被上游 Prompt Cache 命中，其边际成本远低于全价；把重复出现次数乘以内容大小会系统性高估浪费。真正的浪费信号是 `newly_injected` / `re_injected`：它们出现在前缀之外，直接产生 cache creation 或非缓存 input token。

比较时至少按以下维度分组：

- `harness_id`；
- `harness_version`；
- `model`；
- `provider`；
- 时间窗口；
- 是否流式。

不能直接把低缓存率归因于 SKILL，因为 system prompt、工具 schema、消息历史、模型和上游缓存策略也可能造成缓存变化。

## 11. 与工具调用 telemetry 的关联

同一请求中保留现有工具摘要，并将 SKILL 分析作为上游上下文：

```text
skill_newly_injected_count / skill_reinjected_count
  → cache_read_input_tokens
  → tool_use_count
  → tool_result_error_count
  → session request count
```

建议先做低成本关联，不急于记录工具参数：

- SKILL 新注入前后工具调用数量变化；
- SKILL 新注入前后工具错误率变化；
- SKILL 内容大小与 session 总请求轮数的关系。

## 12. 数据边界与运行安全

### 12.1 落盘边界

本项目面向工作用途，明文记录不以隐私脱敏为目标。SKILL、`system-reminder` 注入明文和员工 Prompt 明文均写入 `prompt-log` 的独立 transport，并沿用其访问控制；telemetry 仍然不含任何明文。

以下内容默认不落盘，原因是减少无关信息、控制日志体积并避免为非目标数据增加解析和 schema 设计；这不是基于隐私禁止，未来若有明确审计需求可以单独扩展：

- 工具 input；
- 工具 result；
- 任何完整消息 body（`skill_prompt_observed` 只含提取后的 SKILL 或 `system-reminder` 文本片段，不含整段消息）。

### 12.2 日志注入防护

从请求中提取的 SKILL 名称、路径和正文必须：

- 限制最大长度：名称和路径各不超过 128 字符（与 `llmTelemetry.js` 中 `MAX_TOOL_NAME_LENGTH = 128` 对齐），SKILL 正文单条记录不超过 512 KB；
- 限制数组元素数量：单次请求中检测到的 SKILL 实例不超过 64 个（与 `MAX_TOOL_NAMES = 64` 对齐）；
- 不进入普通控制台日志；
- 不作为 HTML 或日志格式直接渲染。


## 13. 实现建议

建议新增或修改以下文件：

```text
src/utils/skillPromptAnalyzer.js
src/utils/llmTelemetry.js
src/utils/llmRequestObserver.js
src/utils/promptLogger.js
tests/skillPromptAnalyzer.test.js
tests/promptLogger.test.js
tests/llmTelemetry.test.js
```

建议接口：

```js
analyzeSkillInjection(requestBody, previousState)
// → { summary, skillRecords }
// summary: telemetry 摘要字段（不含明文）
// skillRecords: 待落盘的 newly_injected / re_injected SKILL 或 system-reminder 明文片段数组

classifyPromptSource(textBlock)
// → 'human' | 'skill_injection' | 'system_reminder' | 'tool_result' | 'unknown_meta'
```

职责划分与调用顺序：

1. `llmRequestObserver` 在 `startLlmRequestObservation` 入口处，当 `PROMPT_LOG_ENABLED` 或 `LLM_TELEMETRY_ENABLED` 任一开启时（与现有 sessionInfo 提取的触发条件一致），**先调用** `skillPromptAnalyzer.analyzeSkillInjection`，获得 `summary` 和 `skillRecords`；
2. `llmRequestObserver` 将 `summary` 写入 `telemetryContext`（作为独立属性，不合并进 `requestSummary`），`finalizeTelemetry` 在构造 telemetry record 时展开该属性；
3. `llmRequestObserver` 将 `skillRecords` 和 SKILL 分析结果传递给 `promptLogger.recordRequest`，`promptLogger` 依据 `classifyPromptSource` 的结果决定：
   - 来源为 `human` 的文本 → 写 `user_prompt_observed`；
   - 来源为 `skill_injection` 或 `system_reminder` 的文本 → 写 `skill_prompt_observed`（来自 `skillRecords`，并保留 `prompt_source`）；
   - 其余来源 → 不写明文记录；
4. `promptLogger` 内部不再直接调用 `extractLatestUserPrompt`，改为接收经过来源分类后的文本；或保留 `extractLatestUserPrompt` 但在返回前通过 `classifyPromptSource` 过滤，丢弃非 `human` 的文本；
5. 路由层不参与解析；
6. 上述步骤任一环节抛出异常，均不影响 LLM 请求继续转发（fail-open）。


## 14. 测试要求

至少覆盖：

1. 能识别标准 `<command-message>`、`<command-name>`、`<skill-format>` 组合；
2. 能识别 `invoked_skills` 的 `### Skill` 和 `Path` 结构；
3. 能识别 SKILL 列表但不把它计入正文大小；
4. 增量对比：未变化历史中的 SKILL 判为 `carried_over`，不写明文记录；
5. 增量对比：新消息中的 SKILL 判为 `newly_injected`，写 `skill_prompt_observed`；
6. 增量对比：消失后以恢复结构重新出现的 SKILL 判为 `re_injected` 且 `skill_rehydrated=true`；
7. 普通 system reminder 被标为低置信度，可写入 `skill_prompt_observed`，但不计为确定的 SKILL；
8. `user_prompt_observed` 不记录 SKILL/system-reminder 正文，`skill_prompt_observed` 不记录员工输入，但可记录来源为 `system_reminder` 的机器注入正文；
9. tool input、tool result 不进入 SKILL 分析结果；
10. 超长、畸形或嵌套标签不会阻断请求；
11. 分析器失败不影响 LLM 请求；
12. session 状态 LRU 有界，超量淘汰不导致错误。

## 15. 灰度与开关

不新增独立开关：

- SKILL 分析与 `skill_prompt_observed` 记录跟随 `PROMPT_LOG_ENABLED`；
- telemetry 摘要字段跟随 `LLM_TELEMETRY_ENABLED`；
- 两者各自独立生效：只开 prompt-log 时明文记录可用，只开 telemetry 时摘要字段可用。

灰度顺序：

1. 开启 `PROMPT_LOG_ENABLED`，检查 `user_prompt_observed` 排除效果以及 SKILL/`system-reminder` 的 `skill_prompt_observed` 记录质量；
2. 开启 `LLM_TELEMETRY_ENABLED`，检查摘要字段与日志体积；
3. 验证注入分类与缓存 token 的关联；
4. 再考虑增加管理端聚合或告警。

## 16. 已知限制

在不修改 Claude Code 的情况下，以下信息无法可靠获得：

- SKILL 的真实版本；
- SKILL 的真实来源配置项；
- 精确的 Agent 父子关系；
- SKILL 是否由用户主动调用、模型调用还是后台机制触发；
- SKILL 是否真正影响了模型输出；
- 网关观察到的 `system-reminder` 是否一定来自 SKILL。

另有实现层面的限制：

- 增量对比状态为单进程内存，网关重启或多实例路由会导致 `carried_over` 退化为 `newly_injected`（假阴性），方向上偏保守，不会产生错误明文；
- 跨格式 `re_injected` 判定依赖 SKILL 名称的准确提取：原始注入（command marker）与压缩恢复（`### Skill:` 结构）包装不同、内容 hash 无法跨格式匹配，实现通过名称回溯补足。当原始注入为 `strong_pattern`/`heuristic` 级别、名称无法提取时，该路径退化为 `newly_injected`；
- 名称回溯带来误判方向：同名但内容完全不同的两个 SKILL 会被判为 `re_injected`，属于偏保守的假阳性，不影响明文落盘，只影响计数；
- Claude Code 后续版本变更文本标记时，检测规则需要随 `skill_detection_rule_version` 升级。

网关推断结果的不确定性通过 `skill_detection_confidence`（`exact_marker` / `strong_pattern` / `heuristic`）和 `skill_detection_rule_version` 表达，字段名本身不加 `inferred_` 前缀。已定义的 schema 字段（见 §8）保持原名，消费方应根据 `confidence` 字段决定使用策略，而不是依赖字段名区分推断与事实。


## 17. 验收标准

本 RFC 完成后，应满足：

- 不修改 Claude Code 也能统计疑似 SKILL 注入请求；
- 能统计 SKILL 名称、路径、内容大小、注入分类（延续/新注入/重新注入）和压缩恢复次数；
- 能把 SKILL 注入与缓存 token、工具调用和 session 请求数关联；
- SKILL 和 `system-reminder` 明文只进入 `skill_prompt_observed`，不污染 `user_prompt_observed`；
- 默认不落盘工具参数和工具结果正文，以减少日志体积并保持本 RFC 的分析范围；如后续有明确审计需求，再单独扩展；
- 对误报和不确定情况有明确置信度；
- 分析失败不会影响正常请求；
- 不新增开关，行为跟随现有 `PROMPT_LOG_ENABLED` 与 `LLM_TELEMETRY_ENABLED`。

## 18. 结论

在不能修改 Claude Code 的限制下，最优方案不是尝试完整还原客户端内部 SKILL 状态，而是：

1. 识别 Claude Code 已存在的稳定文本标记，并利用原始注入与恢复注入的格式差异区分两者；
2. 通过与上一次请求的增量对比，把 SKILL 出现方式分为延续、新注入和重新注入三类，避免把无状态 API 的正常历史重发误判为浪费；
3. 对新注入和重新注入的 SKILL 或 `system-reminder` 落盘明文、大小和路径，对延续内容只计数；
4. 将结果与缓存和工具调用指标关联；
5. 明确区分事实、强推断和弱推断；
6. 修正 `prompt-log`：员工输入与机器注入分离记录，SKILL 和 `system-reminder` 明文进入独立记录类型。

该方案不能替代客户端显式上报，但足以优先验证"SKILL Prompt 是否过大、重复注入并影响缓存效率"这一运维假设。
