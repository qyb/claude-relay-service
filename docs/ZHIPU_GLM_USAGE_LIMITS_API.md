# Zhipu GLM 使用限额查询协议

本文档定义 CRS 为 Zhipu GLM Claude Console 账户提供的使用限额查询协议，以及后端和 Web Admin 的两步提交边界。

本文所称“限额”是 Zhipu Coding Plan 返回的 5 小时、周限和 MCP 使用窗口，不是 CRS 的本地 `dailyQuota`，也不是账户余额。

## 一、目标与非目标

### 1.1 目标

- 当 Claude Console 账户的 Anthropic 端点为 `https://open.bigmodel.cn/api/anthropic` 时，自动启用 Zhipu 使用限额查询。
- 支持 Zhipu 返回的 `TOKENS_LIMIT`、`CREDIT_LIMIT` 和 `TIME_LIMIT`。
- 向 Web Admin 提供稳定的、与 Zhipu 原始响应解耦的管理 API。
- 使用 Redis 缓存查询结果，避免每次刷新账户列表都请求上游。
- 查询失败只影响限额展示，不影响账户调度和正常的 `/v1/messages` 转发。

### 1.2 非目标

- 不修改 Zhipu 消息转发、模型映射或 `429` 解析逻辑。
- 不根据使用百分比自动暂停或恢复账户。
- 不把 Zhipu 限额合并进 CRS 的本地每日费用额度。
- 不保存上游完整响应。
- 不支持任意自定义 Claude Console 端点的余额查询。
- 第一阶段不修改 Vue；第二阶段不再修改后端协议。

## 二、适用账户判定

只有同时满足以下条件的 Claude Console 账户才适用本协议：

1. `platform === "claude-console"`。
2. `apiUrl` 可以被标准 URL 解析器解析。
3. URL 协议为 `https:`。
4. hostname 严格等于 `open.bigmodel.cn`，不接受子域名或字符串前缀匹配。
5. port 为空或为 `443`。
6. pathname 去掉末尾的 `/` 后严格等于 `/api/anthropic`。
7. URL 不包含用户名、密码、query 或 fragment。

以下地址应当匹配：

```text
https://open.bigmodel.cn/api/anthropic
https://open.bigmodel.cn/api/anthropic/
```

以下地址不得匹配：

```text
http://open.bigmodel.cn/api/anthropic
https://open.bigmodel.cn.evil.example/api/anthropic
https://open.bigmodel.cn/api/anthropic/v1
https://open.bigmodel.cn/api/anthropic?region=cn
```

该判定只决定是否启用限额查询，不改变实际消息请求使用的 `apiUrl`。

## 三、Zhipu 上游协议

### 3.1 请求

主查询接口：

```http
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: Bearer <Claude Console account apiKey>
Accept: application/json
```

可选套餐接口：

```http
GET https://open.bigmodel.cn/api/biz/subscription/list
Authorization: Bearer <Claude Console account apiKey>
Accept: application/json
```

实现要求：

- 使用 Claude Console 账户解密后的 `apiKey`。
- 复用该账户的代理配置。
- 单次请求超时为 12 秒。
- quota 接口失败时整次查询失败。
- subscription 接口失败时忽略，只令 `plan` 为 `null`；不能让它覆盖成功的 quota 结果。
- 禁止在日志、错误响应、Redis 或测试 fixture 中写入 API Key。

### 3.2 上游状态映射

| HTTP 状态                    | 归一化状态     |
| ---------------------------- | -------------- |
| `200` 且至少解析出一个窗口   | `ok`           |
| `401`、`403`                 | `unauthorized` |
| `429`                        | `rate_limited` |
| 超时、网络错误、其他非 `2xx` | `unavailable`  |
| `200` 但没有可识别窗口       | `unavailable`  |

上游错误正文不得原样返回 Web Admin。日志最多记录账户 ID、请求路径、HTTP 状态和归一化错误码。

## 四、限额解析规则

### 4.1 支持的类型

Zhipu `data.limits` 中的 `type` 或 `limit_type` 按去空白并转大写后解析：

```text
TOKENS_LIMIT   token 使用窗口
CREDIT_LIMIT   token 使用窗口
TIME_LIMIT     MCP 使用窗口
```

`CREDIT_LIMIT` 只是上游返回的限额类型。它不表示 API Key 必然按余额计费，也不能用于判断账户是 token-based 还是 credit-based。

未知类型忽略，不能导致整个响应失败。

### 4.2 百分比

数值字段允许 JSON number 或可转换为有限数值的字符串。

优先使用 `usage`、`remaining` 和 `currentValue` 计算：

```text
used_from_remaining = usage - remaining
used = max(used_from_remaining, currentValue)
used_percent = used / usage * 100
```

其中 `used` 限制在 `[0, usage]`。缺少可计算的总量时，依次读取：

```text
percentage
usedPercent
used_percent
```

最终百分比限制在 `[0, 100]`。无法得到百分比的限额项忽略。

### 4.3 时间窗口

`unit` 和 `number` 的窗口换算：

| `unit` | 含义 | `windowMinutes`        |
| ------ | ---- | ---------------------- |
| `5`    | 分钟 | `number`               |
| `3`    | 小时 | `number * 60`          |
| `1`    | 天   | `number * 24 * 60`     |
| `6`    | 周   | `number * 7 * 24 * 60` |

token 窗口按 `windowMinutes` 从小到大排序：

- 不超过 6 小时的最短窗口归一化为 `session`。
- 最长的非 session token 窗口归一化为 `weekly`。
- 只有一个 token 窗口时，根据是否不超过 6 小时决定归入 `session` 或 `weekly`。
- `TIME_LIMIT` 归一化为 `mcp`，不使用它可能具有误导性的 `unit=5, number=1` 作为展示周期。

### 4.4 重置时间

依次读取：

```text
nextResetTime
next_reset_time
```

允许 Unix 秒、Unix 毫秒或 ISO 日期字符串，API 统一输出 ISO 8601 UTC 字符串。无有效时间时输出 `null`。

MCP 窗口没有有效的限额重置时间时，可以使用 subscription 的 `next_renew_time` 或 `nextRenewTime` 作为后备，并设置 `resetCadence = "monthly"`。

## 五、CRS 管理 API

所有接口均使用现有的 `authenticateAdmin` 中间件。

### 5.1 批量读取

```http
GET /admin/claude-console-accounts/usage-limits
```

用途：账户列表首次加载时批量取得所有适用账户的限额。

行为：

- 只返回符合第二节判定规则的账户；其他 Claude Console 账户不出现在 `data` 中。
- 新鲜缓存直接返回，不请求 Zhipu。
- 没有缓存或缓存已过新鲜期时，请求 Zhipu。
- 上游查询并发数最多为 5。
- 单个账户失败不使批量接口失败。
- 批量接口只在整体 Redis/服务异常时返回 HTTP `500`。

响应示例：

```json
{
  "success": true,
  "data": {
    "account-id": {
      "accountId": "account-id",
      "provider": "zhipu",
      "plan": "GLM Coding Max",
      "status": "ok",
      "source": "cache",
      "stale": false,
      "updatedAt": "2026-08-08T07:16:26.000Z",
      "freshUntil": "2026-08-08T07:21:26.000Z",
      "windows": [
        {
          "kind": "session",
          "upstreamType": "TOKENS_LIMIT",
          "windowMinutes": 300,
          "usedPercent": 12,
          "remainingPercent": 88,
          "total": null,
          "used": null,
          "remaining": null,
          "resetsAt": null,
          "resetCadence": null
        },
        {
          "kind": "weekly",
          "upstreamType": "TOKENS_LIMIT",
          "windowMinutes": 10080,
          "usedPercent": 66,
          "remainingPercent": 34,
          "total": null,
          "used": null,
          "remaining": null,
          "resetsAt": "2026-08-12T07:16:26.997Z",
          "resetCadence": null
        }
      ],
      "errorCode": null,
      "errorMessage": null
    }
  }
}
```

### 5.2 强制刷新单个账户

```http
POST /admin/claude-console-accounts/:accountId/usage-limits/refresh
Content-Type: application/json

{}
```

行为：

- 忽略新鲜缓存并立即查询 Zhipu。
- 成功后更新 Redis 快照。
- 账户不存在时返回 HTTP `404`。
- 账户不符合第二节判定时返回 HTTP `422`，错误码为 `not_applicable`。
- 上游认证、限流或可用性错误使用 HTTP `200` 返回结构化状态，便于前端保留旧数据并显示局部错误。
- 如果存在旧快照而本次刷新失败，返回旧窗口，设置 `source = "cache"`、`stale = true`，同时填写本次 `errorCode`。

成功响应：

```json
{
  "success": true,
  "data": {
    "accountId": "account-id",
    "provider": "zhipu",
    "plan": "GLM Coding Max",
    "status": "ok",
    "source": "api",
    "stale": false,
    "updatedAt": "2026-08-08T07:16:26.000Z",
    "freshUntil": "2026-08-08T07:21:26.000Z",
    "windows": [
      {
        "kind": "session",
        "upstreamType": "TOKENS_LIMIT",
        "windowMinutes": 300,
        "usedPercent": 12,
        "remainingPercent": 88,
        "total": null,
        "used": null,
        "remaining": null,
        "resetsAt": null,
        "resetCadence": null
      }
    ],
    "errorCode": null,
    "errorMessage": null
  }
}
```

无历史快照且上游返回 `401` 的响应：

```json
{
  "success": true,
  "data": {
    "accountId": "account-id",
    "provider": "zhipu",
    "plan": null,
    "status": "unauthorized",
    "source": "none",
    "stale": false,
    "updatedAt": null,
    "freshUntil": null,
    "windows": [],
    "errorCode": "unauthorized",
    "errorMessage": "Zhipu API Key 无效或无权查询限额"
  }
}
```

### 5.3 字段约束

| 字段               | 类型        | 说明                                                                                                               |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `provider`         | string      | 固定为 `zhipu`                                                                                                     |
| `plan`             | string/null | 套餐显示名；subscription 查询失败时允许为空                                                                        |
| `status`           | string      | 最新查询结果：`ok`、`unauthorized`、`rate_limited`、`unavailable`；stale 回退时允许错误状态与旧 `windows` 同时存在 |
| `source`           | string      | `api`、`cache`、`none`                                                                                             |
| `stale`            | boolean     | 当前窗口是否来自已过新鲜期的后备快照                                                                               |
| `updatedAt`        | string/null | 当前窗口数据取得时间                                                                                               |
| `freshUntil`       | string/null | 缓存新鲜期结束时间                                                                                                 |
| `windows`          | array       | 已归一化的限额窗口；顺序为 `session`、`weekly`、`mcp`                                                              |
| `kind`             | string      | `session`、`weekly`、`mcp`                                                                                         |
| `upstreamType`     | string      | `TOKENS_LIMIT`、`CREDIT_LIMIT`、`TIME_LIMIT`，仅用于诊断                                                           |
| `usedPercent`      | number      | `[0, 100]`                                                                                                         |
| `remainingPercent` | number      | `[0, 100]`                                                                                                         |
| `total`            | number/null | 上游 `usage`；缺失时为空                                                                                           |
| `used`             | number/null | 根据上游字段计算的已使用量；缺失时为空                                                                             |
| `remaining`        | number/null | 上游剩余量；缺失时为空                                                                                             |
| `resetsAt`         | string/null | ISO 8601 UTC 时间                                                                                                  |
| `resetCadence`     | string/null | 当前仅允许 `monthly` 或 `null`                                                                                     |

前端不得根据 `upstreamType` 决定窗口名称或行为，应使用 `kind`。

## 六、缓存协议

使用独立 Redis key，不能复用本地余额或 Claude OAuth usage 字段：

```text
zhipu_usage_limits:<accountId>
```

缓存策略：

- 新鲜期：300 秒。
- Redis 保留期：24 小时，用于上游短暂失败时返回 stale 快照。
- 缓存中只保存第五节定义的归一化数据，不保存完整上游响应和 API Key。
- 普通批量读取在新鲜期内只读 Redis。
- 强制刷新绕过新鲜期，但失败时不得删除已有快照。
- Claude Console 账户的 `apiUrl` 或 `apiKey` 更新后应立即删除旧快照。
- 删除 Claude Console 账户时应同时删除对应缓存。
- 本功能不增加定时查询任务；查询由 Web Admin 读取或手动刷新触发。

## 七、前端展示约定

第二步 Vue 实现只依赖第五节协议：

- 账户列表加载完成后，若存在匹配 Zhipu 端点的 Claude Console 账户，调用一次批量接口。
- 在“会话窗口”列展示窗口，不挤占“余额/配额”中的本地 `dailyQuota`。
- `session` 显示为 `5h`，`weekly` 显示为“周限”，`mcp` 显示为 `MCP`。
- 进度条使用 `usedPercent`，旁边展示 `remainingPercent` 或已使用百分比。
- `resetsAt` 存在时显示重置剩余时间；不存在时显示 `--`。
- `stale = true` 时显示“缓存数据”提示及错误 tooltip，但继续展示窗口。
- `unauthorized`、`rate_limited`、`unavailable` 且无窗口时，只在该账户区域显示错误，不影响其他账户。
- 刷新按钮调用单账户强制刷新接口。
- 前端不读取、保存或传递账户 API Key。

建议新增独立组件，避免在 `AccountsView.vue` 的桌面和移动布局中复制解析逻辑：

```text
web/admin-spa/src/components/accounts/ZhipuUsageLimits.vue
```

## 八、安全与可观测性

- API Key 只能存在于解密后的短生命周期内存和上游 `Authorization` header。
- 任何日志不得包含 API Key、完整请求 headers 或完整上游响应。
- 管理 API 响应不得包含 `apiUrl`、API Key 或 subscription 原始对象。
- 日志使用账户 ID，不使用明文 key 片段作为标识。
- 可以记录查询耗时、HTTP 状态、缓存命中和归一化状态。
- 上游 quota API 故障不得改变账户的 `isActive`、`schedulable`、限流状态或调度权重。

## 九、两步提交边界

### 9.1 第一步：后端实现与 API

建议提交信息：

```text
feat(admin): add Zhipu usage limits API for console accounts
```

范围：

- Zhipu 端点识别和纯解析模块。
- quota 与可选 subscription 查询服务。
- Redis 快照缓存。
- 批量读取和单账户强制刷新 API。
- 后端单元测试与路由测试。
- 本协议文档。

第一步验收标准：

- 不构建或修改 Vue，也可以通过 `curl` 验证完整功能。
- mock 测试覆盖 `TOKENS_LIMIT` 和 `CREDIT_LIMIT`。
- 使用真实 token-based key 验证可得到 5 小时、周限和 MCP 窗口，但 key 不进入测试、提交和日志。
- 不影响非 Zhipu Claude Console 账户。
- 不影响消息转发和现有 `429` 行为。

### 9.2 第二步：Vue 展示

建议提交信息：

```text
feat(web): display Zhipu usage windows for console accounts
```

范围：

- 新增 Zhipu 使用窗口展示组件。
- `AccountsView.vue` 批量加载、状态合并和手动刷新。
- 桌面及移动布局接入。
- 前端组件或数据转换测试。
- 必要的界面说明文字。

第二步不得修改：

- 后端响应字段及状态语义。
- Redis key 和缓存策略。
- Zhipu 上游解析规则。
- Claude Console 消息转发逻辑。

第二步验收标准：

- 5h、周限和 MCP 窗口可同时展示。
- trailing slash 形式的 Zhipu endpoint 账户也能展示。
- 单账户刷新不重新加载整个账户列表。
- 部分账户查询失败不会清空其他账户数据。
- stale、无重置时间和认证失败均有明确状态。

## 十、最低测试矩阵

后端至少覆盖：

- endpoint 正匹配、trailing slash、恶意相似 hostname、错误协议和额外路径。
- `TOKENS_LIMIT` 的 5 小时与周窗口。
- `CREDIT_LIMIT` 的 5 小时与周窗口。
- `TIME_LIMIT` 的 MCP 窗口及 subscription reset 后备。
- 只有百分比、只有 usage/current/remaining、数字字符串和非法数值。
- token 窗口顺序颠倒、未知类型和空 limits。
- quota 成功但 subscription 失败。
- `401`、`403`、`429`、超时和无可识别窗口。
- 新鲜缓存命中、强制刷新、失败时 stale 后备和删除账户时清理缓存。
- 批量部分失败仍返回 HTTP `200`。
- 未通过管理员认证时拒绝访问。

前端至少覆盖：

- 三种 `kind` 的标签、百分比、颜色和重置时间。
- `stale`、`unauthorized`、`rate_limited` 和 `unavailable`。
- 没有 `resetsAt` 时显示 `--`。
- 批量结果按 `accountId` 合并，不串到其他账户。
- 手动刷新只更新目标账户。
- 非 Zhipu Claude Console 账户不发起限额请求、不显示空占位组件。

## 十一、验证记录

使用一枚 token-based GLM Coding Plan key 对官方接口进行过脱敏验证：

- quota 与 subscription 接口均返回 HTTP `200`。
- 套餐为 `GLM Coding Max`。
- 返回了 5 小时、周限和 MCP 三类窗口。
- 本次真实响应的 token 窗口类型为 `TOKENS_LIMIT`。

因此真实 key 验证了 `TOKENS_LIMIT` 路径；`CREDIT_LIMIT` 必须继续通过无凭据的固定 fixture 单元测试覆盖。验证使用的 key 不得写入本文档、Git 历史或自动化测试。
