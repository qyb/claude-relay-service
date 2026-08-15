# CRS 成本计费设计（Accounting & Billing）

本文档描述 CRS 的模型计价来源、GLM 区域价格覆盖表设计，以及"按上游响应模型计价"原则。

关联文档：`CLAUDE_CODE_REQUEST_SESSION_TELEMETRY.md`（telemetry 的 cost 字段）、`UPSTREAM_TELEMETRY_DESIGN.md`（cost 回填）。

## 一、背景：现状与问题

### 1.1 当前价格链路

```
LiteLLM model_prices_and_context_window.json（社区维护，美元）
  → GitHub Actions 每 10 分钟同步至 price-mirror 分支（.github/workflows/sync-model-pricing.yml）
  → pricingSource.js 从镜像下载 → data 目录缓存
  → resources/model-pricing/ 随代码发布的兜底副本
```

### 1.2 实测问题（2026-08-08 ~ 08-14 生产数据验证）

| 问题 | 事实 |
|---|---|
| 智谱原生模型无价格 | LiteLLM 文件 1,582 个条目中仅 8 个 GLM（全部为 deepinfra/fireworks 等三方托管的 GLM-4.5，美元价、无缓存价）；**glm-5.2 / glm-5-turbo / glm-4.7 / glm-4.5-air 均未收录** |
| 匹配失败静默错算 | `getModelPricing` 精确与模糊匹配均 miss 后返回 null；`costCalculator.js` 静态表路径兜底到 `MODEL_PRICING.unknown` = **Claude Sonnet 美元价（$3/$15/M）**，而 `pricingService` 路径返回全 0。两条路径都不正确，且仅 debug 级日志 |
| 缓存价自动补全比例错误 | `ensureCachePricing` 对缺缓存价格条目默认按 Anthropic 比例填（写 1.25× / 读 **0.1×**）；GLM 实际按模型和阶梯为 **20%~25%**（CN），或 **~18.6%~20%**（intl） |
| 计价模型名不一致 | 存在上游模型重定向：`glm-4.5-air → glm-4.7`（1,461/1,461，100%）、`claude-sonnet-4 / claude-opus-4-7 / claude-sonnet-4-6 → glm-4.7`、`glm-5 / glm-5.1 → glm-5.2`。按请求模型计价会用错价目条目 |
| 成本无基线 | telemetry `cost` 全为 null；api-key 成本统计对 GLM 流量失真 |
| 新模型暂无报价 | 生产已观测到 `glm-5.3` 成功响应，但官方价格页暂无报价；临时按 `glm-5.2` 价格计费，并必须标记为临时价格 |

### 1.3 两套官方报价（互相独立，非汇率换算）

智谱存在中国版（bigmodel.cn，人民币）与国际版（z.ai，美元）两套报价，隐含汇率逐项不同（输入 5.71 vs 缓存 7.69），是两套独立定价策略。价格表保留官方原始货币，CRS 内部成本和管理台展示统一使用 USD：

大陆版价格页（核对日期：2026-08-15）按输入长度、输出长度分档；以下金额均为每百万 tokens，缓存存储费当前均显示为"限时免费"：

| 模型 | 阶梯条件（官网原始记法） | 输入 ¥/M | 输出 ¥/M | 缓存命中 ¥/M |
|---|---|---:|---:|---:|
| GLM-5.2 | 统一价格，1M 上下文 | 8 | 28 | 2 |
| GLM-5.1 | 输入长度 `[0, 32)` | 6 | 24 | 1.3 |
| GLM-5.1 | 输入长度 `[32, +)` | 8 | 28 | 2 |
| GLM-5-Turbo | 输入长度 `[0, 32)` | 5 | 22 | 1.2 |
| GLM-5-Turbo | 输入长度 `[32, +)` | 7 | 26 | 1.8 |
| GLM-5 | 输入长度 `[0, 32)` | 4 | 18 | 1 |
| GLM-5 | 输入长度 `[32, +)` | 6 | 22 | 1.5 |
| GLM-4.7 | 输入 `[0, 32)`，输出 `[0, 0.2)` | 2 | 8 | 0.4 |
| GLM-4.7 | 输入 `[0, 32)`，输出 `[0.2, +)` | 3 | 14 | 0.6 |
| GLM-4.7 | 输入 `[32, 200)` | 4 | 16 | 0.8 |
| GLM-4.5-Air | 输入 `[0, 32)`，输出 `[0, 0.2)` | 0.8 | 2 | 0.16 |
| GLM-4.5-Air | 输入 `[0, 32)`，输出 `[0.2, +)` | 0.8 | 6 | 0.16 |
| GLM-4.5-Air | 输入 `[32, 128)` | 1.2 | 8 | 0.24 |

官网表格的长度区间使用 `32`、`200`、`128` 等简写；设计实现必须保存原始条件及其单位映射，统一换算为 tokens 后再匹配。`GLM-4.7` 和 `GLM-4.5-Air` 的 `[0.2, +)` 输出区间也必须保留，不能用单一输出价覆盖。当前价格页未说明区间是否采用渐进累进计价，因此按命中的整档单价计算，不自行拆分跨档 tokens。

国际版目前仍按单价表处理：

| 模型 | Intl 输入 $/M | Intl 缓存命中 $/M | Intl 输出 $/M |
|---|---:|---:|---:|
| GLM-5.2 | 1.4 | 0.26 | 4.4 |
| GLM-5.1 | 1.4 | 0.26 | 4.4 |
| GLM-5 | 1.0 | 0.20 | 3.2 |
| GLM-5-Turbo | 1.2 | 0.24 | 4.0 |
| GLM-4.7 | 0.6 | 0.11 | 2.2 |
| GLM-4.5-Air | 0.2 | 0.03 | 1.1 |

来源：大陆版 <https://bigmodel.cn/pricing>，国际版 <https://docs.z.ai/guides/overview/pricing>。国际版价格页明确列出 `GLM-4.5-Air` 为 `$0.2 / $0.03 / $1.1`。Intl 缓存存储费限时免费；CN 缓存/输入比按阶梯为 20%~25%，不再使用单一的 25% 假设。

生产日志已观测到新模型 `glm-5.3`，但国际版和大陆版官方价格页暂未提供其报价。在正式报价发布前，`glm-5.3` 通过显式计费别名临时复用 `glm-5.2` 的对应 region 价格；该别名只影响成本查找，不改变 telemetry 中记录的真实响应模型名，并在成本结果中标记 `provisionalPricing=true`。

## 二、设计

### 2.1 区域价格覆盖表

新增本地维护的价格表，**优先级高于 LiteLLM 文件**，仅承载智谱原生模型。结构：

```json
{
  "version": "2026.08.15",
  "sources": {
    "cn": "https://bigmodel.cn/pricing",
    "intl": "https://docs.z.ai/guides/overview/pricing"
  },
  "reporting_currency": "USD",
  "exchange_rates": {
    "CNY": {
      "to_reporting": 0.1483,
      "checked_at": "2026-08-15"
    },
    "USD": {
      "to_reporting": 1
    }
  },
  "pricing_aliases": {
    "glm-5.3": "glm-5.2"
  },
  "models": {
    "glm-5.2": {
      "cn": {
        "currency": "CNY",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": {}, "input": 8, "cached": 2, "output": 28 }
        ]
      },
      "intl": {
        "currency": "USD",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": {}, "input": 1.4, "cached": 0.26, "output": 4.4 }
        ]
      }
    },
    "glm-5-turbo": {
      "cn": {
        "currency": "CNY",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": { "input_length": { "gte": 0, "lt": 32, "unit": "k_tokens" } }, "input": 5, "cached": 1.2, "output": 22 },
          { "when": { "input_length": { "gte": 32, "unit": "k_tokens" } }, "input": 7, "cached": 1.8, "output": 26 }
        ]
      },
      "intl": {
        "currency": "USD",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": {}, "input": 1.2, "cached": 0.24, "output": 4.0 }
        ]
      }
    },
    "glm-4.7": {
      "cn": {
        "currency": "CNY",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": { "input_length": { "gte": 0, "lt": 32, "unit": "k_tokens" }, "output_length": { "gte": 0, "lt": 0.2, "unit": "m_tokens" } }, "input": 2, "cached": 0.4, "output": 8 },
          { "when": { "input_length": { "gte": 0, "lt": 32, "unit": "k_tokens" }, "output_length": { "gte": 0.2, "unit": "m_tokens" } }, "input": 3, "cached": 0.6, "output": 14 },
          { "when": { "input_length": { "gte": 32, "lt": 200, "unit": "k_tokens" } }, "input": 4, "cached": 0.8, "output": 16 }
        ]
      },
      "intl": {
        "currency": "USD",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": {}, "input": 0.6, "cached": 0.11, "output": 2.2 }
        ]
      }
    },
    "glm-4.5-air": {
      "cn": {
        "currency": "CNY",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": { "input_length": { "gte": 0, "lt": 32, "unit": "k_tokens" }, "output_length": { "gte": 0, "lt": 0.2, "unit": "m_tokens" } }, "input": 0.8, "cached": 0.16, "output": 2 },
          { "when": { "input_length": { "gte": 0, "lt": 32, "unit": "k_tokens" }, "output_length": { "gte": 0.2, "unit": "m_tokens" } }, "input": 0.8, "cached": 0.16, "output": 6 },
          { "when": { "input_length": { "gte": 32, "lt": 128, "unit": "k_tokens" } }, "input": 1.2, "cached": 0.24, "output": 8 }
        ]
      },
      "intl": {
        "currency": "USD",
        "unit": "per_1m_tokens",
        "cache_storage": { "price": 0, "status": "limited_time_free" },
        "tiers": [
          { "when": {}, "input": 0.2, "cached": 0.03, "output": 1.1 }
        ]
      }
    }
  },
  "redirects": {
    "glm-4.5-air": "glm-4.7",
    "claude-sonnet-4": "glm-4.7",
    "glm-5": "glm-5.2",
    "glm-5.1": "glm-5.2"
  }
}
```

字段说明：

- **价格单位统一为 per 1M tokens**（LiteLLM 文件是 per-token，读取时注意换算，这是历史坑）。阶梯条件中的 `k_tokens`、`m_tokens` 仅用于表达官网原始区间，运行时必须先归一化为 tokens。
- **`currency` 必填**。价格金额保留官方原始货币；内部成本、telemetry `cost` 和管理台展示统一为 `reporting_currency`（当前为 USD）。非 USD 条目按 `exchange_rates[原始货币].to_reporting` 折算；汇率变动时更新配置并递增 `version`。
- **汇率只用于统一报表口径，不用于推导官方价格**。大陆版与国际版是独立定价，不能用 CNY/USD 汇率互相反推价格。
- **`tiers` 必填**。每个 region 至少有一个价格阶梯；`when` 为空表示统一价格，多个阶梯使用半开区间，边界不得重叠或留空。
- **`cache_storage` 单独记录**。`limited_time_free` 不是永久免费承诺，价格状态变化时必须更新版本并重新核对。
- **`redirects` 记录已知的上游重定向**，用于补齐历史数据回算与告警比对（见 2.3）。
- **`pricing_aliases` 记录临时计价复用关系**，与 `redirects` 分开。`glm-5.3 → glm-5.2` 只表示价格复用，不表示上游实际发生了模型重定向；查找结果必须带 `provisionalPricing=true`，官方报价发布后删除该别名并递增版本。
- `null` 表示待补录；待补录条目参与查找时按"缺价"处理（见 2.4），不得猜测填充。阶梯单位无法确认时同样按缺价处理，不得把官网展示值直接当作 tokens 比较。

### 2.2 region 判定

按请求实际命中的上游账号 `apiUrl` 域名判定，与 `zhipuUsageLimits.js` 现有逻辑一致：

| apiUrl 域名 | region |
|---|---|
| `open.bigmodel.cn` | `cn` |
| `api.z.ai` | `intl` |
| 其它（Claude 官方、Bedrock 等） | 不适用覆盖表，走 LiteLLM/原有逻辑 |

查找顺序（`pricingService.getModelPricing` 改造）：

```
1. 覆盖表 [served_model][region]        ← 命中即返回（含 currency）
2. `pricing_aliases[served_model]` 对应的覆盖表 [pricing_model][region] ← 命中即返回，并标记 `provisionalPricing=true`
3. 覆盖表模型但 region/tier 缺失         ← 直接按缺价处理，不进入 LiteLLM
4. 非覆盖表模型才进入现有 LiteLLM 匹配逻辑 ← Claude 等其它模型不受影响
5. 都未命中 → 记 hasPricing=false，成本记 0，warn 日志 + 计数指标
```

阶梯匹配规则：

1. 先按上游响应模型和 region 找到价格表，再用本次请求的实际输入长度匹配 `input_length`。这里的 `input_length` 定义为 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，即官网输入上下文长度口径；输出长度只用于 `output_length` 条件。
2. 若阶梯包含 `output_length`，必须等上游响应的最终 usage 可用后，用实际输出长度继续匹配；不能在请求开始时猜测输出档位。
3. 命中的输入、缓存命中、输出三项价格必须来自同一个 `tiers` 元素；不得分别取不同阶梯的单价。
4. 无阶梯命中、多个阶梯命中或边界条件不完整时，按缺价处理，成本记 0 并记录模型、region、输入长度和输出长度。

### 2.3 计价模型名：以 upstream 响应为准

**核心规则：cost 计算必须使用上游响应体返回的模型名（`response.model`），不得使用请求模型名（`req.body.model`）。**

依据（生产数据实证）：

- 上游存在 100% 概率的模型重定向：请求 `glm-4.5-air`，响应 `glm-4.7`（1,461 例无一例外）；另有 `claude-*` 系列与 `glm-5/5.1` 的类似重定向。
- `llmRequestObserver.js:129` 已实现 `this.model = response.model ?? this.model`，telemetry 落盘的 `model` 字段即为响应模型——计价直接复用该字段即可。

配套要求：

- telemetry 增加落盘 `requested_model`（`req.body.model`），与 `model`（响应值）并存；两者不一致时说明发生上游重定向，是上游策略变更的天然探测信号。
- 覆盖表的 `redirects` 用于比对实测重定向与已知清单，发现新重定向（如某天 glm-5.2 被换到 5.3）时告警。

### 2.4 缺价处理：宁缺勿错

- `MODEL_PRICING.unknown`（Claude Sonnet 价）**不得再作为 GLM/未知模型的兜底**。缺价时成本记 0、`hasPricing: false`，并打 warn 日志 + 暴露计数指标（按模型名维度），确保缺价条目会被发现并补录。
- `pricing_aliases` 是唯一允许的临时复用例外。命中 `glm-5.3 → glm-5.2` 时成本可以计算，但必须同时记录 `pricing_model: "glm-5.2"`、`provisionalPricing: true`，并暴露临时计价模型指标；不得把该别名当作正式报价或上游重定向。
- `ensureCachePricing` 的自动补全**仅对 anthropic 系 provider 生效**；覆盖表模型的缓存价必须显式录入，缺失视为缺价（同上处理）。
- 价格配置加载失败会缓存到当前文件 mtime；文件修复或替换后下一次读取会自动重试并热加载，无需重启进程。

### 2.5 cost 回填与统计口径

- `llm_request_completed` 的 `cost` 字段按下式计算并落盘（配合 `UPSTREAM_TELEMETRY_DESIGN.md` 的 P1 项）：

```
cost_native = (input_tokens × tier.input
               + cache_read_tokens × tier.cached
               + output_tokens × tier.output) / 1M
cost_usd = cost_native × exchange_rates[pricing.currency].to_reporting
           （先匹配同一 tier；USD 条目的换算系数为 1）
```

- 跨账号重试时按各次尝试的 usage 分别累加。
- 阶梯价格按命中的整档单价计算；在上游没有明确"分段累进"语义前，不对跨边界 tokens 自行拆分。
- api-key 成本统计、成本排序（`API_KEY_COST_SORT_CONSISTENCY.md`）与 telemetry 使用同一价格源，消除两套口径。
- 每条 usage record 持久化 `apiUrl`、`pricingRegion`、`pricingModel`、`provisionalPricing` 与最终 USD `cost`；Redis 的 key/model/account 聚合 hash 同步保存 `costUsd`。管理台历史明细和聚合统计优先使用写入时成本，避免混合 CN/Intl token 后再次按单一模型猜价。
- 老记录和旧聚合没有 `cost`/`costUsd` 时按缺价处理，不回退到 Claude 默认价；这可能使旧数据显示为 `$0`，但不会产生错误账单。

## 三、实施顺序

1. **已完成 P0**：覆盖表落地（Intl 单价和 CN 阶梯价），`getModelPricing` 接入 region 查找；覆盖表模型 miss 时不再进入 LiteLLM。
2. **已完成 P0**：计价改用响应模型名；telemetry 增加 `requested_model`、`pricing_region`；支持 `glm-5.3` 临时计价别名并标记 provisional。
3. **已完成 P1**：实现阶梯条件归一化、边界匹配和配置区间校验；`ensureCachePricing` 仅对 Anthropic provider 生效。
4. **已完成 P1**：`cost` 回填、缺价计数及管理端 `/pricing/missing-counts` 诊断接口上线。
5. **已完成 P2**：价格表来源、核对日期、汇率、热加载策略和单测锁值已落地；后续价格变更继续按“改表 → 单测 → 版本号递增”执行。

## 四、验证方案

1. 抽取生产一天流量重算成本，`glm-4.5-air` 请求 100% 按 glm-4.7 价格计（验证响应模型名规则生效）。
2. 锁定大陆版价格：`glm-5.2` 输入/缓存/输出必须为 `8/2/28`；`glm-5-turbo` 的 `<32K` 和 `≥32K` 两档必须分别为 `5/1.2/22`、`7/1.8/26`。
3. 验证 `glm-5.3` 在 cn/intl 均复用 `glm-5.2` 价格，结果带 `pricing_model: "glm-5.2"` 和 `provisionalPricing:true`，telemetry 的 `model` 仍为 `glm-5.3`。
4. 验证阶梯边界：`32K` 不得落入 `[0,32)`；`GLM-4.7` 输出 `0.2` 必须落入 `[0.2,+)`；无匹配和重叠匹配都必须告警并按缺价处理。
5. 构造缺价模型请求，确认返回 `hasPricing:false`、成本 0、warn 日志出现，而非 Sonnet 兜底价。
6. 混合 cn/intl 账号的请求各算一例，手工核对 USD 折算；CN 价格乘 `0.1483`，Intl 价格不换算。
7. 以 2026-08-08 ~ 08-14 数据建立基线：全组 cache_read 1,683M + 非缓存 input 67M，按命中阶梯后的 CN 表重新计算，作为后续"省 10%"目标的验收参照。
