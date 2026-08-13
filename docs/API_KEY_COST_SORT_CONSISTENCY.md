# 性能导向设计引发页面状态不一致

本文档记录 API Keys 管理页"费用排序"功能的演进：最初为性能而采用的预计算索引设计如何在页面状态上引入不一致，本次以一致性为导向的变更如何收敛它，以及仍待决策的收尾事项。

> 状态：**收尾部分待决策**。第一、二节为历史设计与问题背景，第三节为本次已落地变更，第四节为仍待决策的收尾与待处理事项。

---

## 一、最初的设计（性能导向）

### 1.1 两套并存的费用来源

系统里一直存在两套**口径不同**的费用计算路径，最初被分配给不同职责：

| 职责 | 路径 | 计算方式 |
| --- | --- | --- |
| 列表排序 | `costRankService` 预计算索引 | 读取**存储型流水**：`usage:cost:daily:{keyId}:{date}` 的每日累计、`usage:cost:total:{keyId}` 的历史总额 |
| 列表展示 | `calculateKeyStats`（batch-stats 同源） | 从 `usage:{keyId}:model:daily:*` 的**按模型 token 明细**，用 `CostCalculator` 按**当前定价**重新计算 |

两者本质不同：排序值是"每次请求发生时按当时价格累加的流水"，展示值是"用当前定价对历史 token 重算的结果"。在定价调整、四舍五入、token 明细 TTL 过期而费用总额仍保留等情况下，二者会发散。

### 1.2 预计算索引（`costRankService`）

为了让"按费用排序"在查询期足够快，引入了 Redis ZSET 预计算索引：

- 为 `today` / `7days` / `30days` / `all` 各维护一个有序集合 `cost_rank:{timeRange}`。
- 后台定时重建：`7days` 每 30 分钟、`30days` 每 1 小时等（见 `UPDATE_INTERVALS`）。
- 建/删 API Key 时通过 `addKeyToIndexes` / `removeKeyFromIndexes` 增量更新。
- 查询期分页直接基于 ZSET，复杂度低，无需在请求内对全量 key 做 SCAN。

`custom` 时间范围无法预计算，走 `calculateCustomRangeCosts` 实时累加存储型每日费用。

### 1.3 前端依赖索引状态

为避免在索引未就绪时给出错误排序，前端深度依赖索引状态：

- 列表接口在索引未就绪时返回 `503 RANK_NOT_READY`。
- `canSortByCost` 依据 `costSortStatus[timeRange].status === 'ready'` 决定表头是否可点。
- `costSortTooltip` 展示"索引更新于 …"。
- `handleTimeRangeChange` 在切换时间范围后发现新范围索引未就绪时，自动回退到默认排序并 toast 提示。
- 前端定时轮询 `/admin/api-keys/cost-sort-status` 刷新状态。

### 1.4 当初被接受的取舍

> "排序用快的存储流水，展示用准的实时重算，二者略有差异可接受，换取列表接口不在请求内对全量 key 重算。"

这是一个典型的**以一致性换性能**的取舍。它成立的前提是：key 数量大到请求内全量重算不可接受。

---

## 二、暴露出的问题

### 2.1 排序与展示对不上（用户可感知）

用户反馈"费用排序不准确"。根因即 1.1：列表的排序顺序来自存储流水，而费用列展示的数字来自 token 重算，两套数字本身就不相等，于是"从上到下并非严格递减/递增"。

### 2.2 跨月份范围漏算（潜伏 bug）

`calculateKeyStats` 内有一段为 `all` 范围设计的去重逻辑（避免 daily 与 monthly 重复计入）：

```js
if (isMonthly && key.includes(`:${currentMonth}`)) continue
if (!isMonthly && !key.includes(`:${currentMonth}-`)) continue
```

该逻辑原本**无条件**对所有 timeRange 生效。但对 `7days` / `custom` 等只扫 daily 的范围，一旦日期**跨过月份边界**（例如今天 8/3、最近 7 天回溯到 7/28），上月的 daily key 会被第二条规则跳过，导致**跨月部分被静默漏算**。

### 2.3 规模现实与取舍失效

实际部署中 API Key 不足 30 个，且每次查看页面本来就会对当前页跑一遍 batch-stats（即调用 `calculateKeyStats`）。在此规模下：

- 预计算索引带来的"查询期零重算"收益几乎不存在；
- 而它引入的**状态不一致**和**前端轮询/回退复杂度**是实打实的成本。

也就是说，1.4 的取舍前提（key 数量大）在本环境不成立，性能优化买到的是近乎为零的收益，代价却是页面状态不一致。

---

## 三、本次变更（以一致性为导向）

核心思路：**排序与展示统一到同一个费用来源 `calculateKeyStats`**，让"排序依据的值"和"页面展示的值"变成同一个数。

### 3.1 后端（`src/routes/admin/apiKeys.js`）

- 新增 `getApiKeysSortedByCostAccurate`：对全量 key 调用 `calculateKeyStats`，按 `.cost` 排序，并把当前页完整 stats 内联返回。
- `sortBy=cost` 的 **preset 与 custom、asc 与 desc 全部**统一走该函数（`sortOrder` 真正生效：`asc` 升序、`desc` 降序）。
- 响应新增 `inlineStats: true` 标记，附带当前页每个 key 的 `stats`。
- 单 key 统计失败不再炸整个列表：`Promise.all` 内 per-key try/catch 回退到 `emptyKeyStats(error)`；batch-stats 也复用同一 helper。
- `calculateKeyStats` 新增 `apiKeyOverride` 入参，复用已 `batchGetApiKeys` 的对象，避免内部重复 `getApiKey`。
- 抽取公共逻辑：`applyApiKeyFilters`、`collectAvailableTags`、`emptyKeyStats`。
- 修复 `30days`：新增真正的"最近 30 天"分支（生成 30 个 daily pattern）。
- 修复跨月漏算：把 daily/monthly 去重逻辑用 `if (timeRange === 'all')` 收窄，非 `all` 范围按选中日期全量计入。
- 删除已无调用方的 `getApiKeysSortedByCostPrecomputed`、`getApiKeysSortedByCostCustom`。

### 3.2 前端（`web/admin-spa/src/views/ApiKeysView.vue`）

- `loadApiKeys` 在 `inlineStats === true` 时，直接把返回的 `key.stats` 写入 `statsCache` 并**跳过额外的 batch-stats 请求**（两次往返合并为一次）。
- `canSortByCost` 恒为 `true`、`costSortTooltip` 改为静态提示，不再依赖索引状态。
- `handleTimeRangeChange` 不再因索引未就绪而回退到默认排序。

### 3.3 新的取舍

> "请求内对全量 key 实时重算费用，换取排序值与展示值严格一致。"

代价需准确刻画，不能笼统说"工作量相当"：

- 新路径减少了一次 HTTP 往返（列表与统计合并为一次请求）。
- 但统计范围从"当前页 key"扩大到"所有筛选后的 key"——必须先算完全部筛选后的 key 才能排序、再分页。例如共 30 个 key、每页 20 个时，新路径计算 30 个，而旧路径的 batch-stats 只计算当前页 20 个。
- `custom` 范围仍可能产生"日期数 × key 数"量级的 SCAN（`calculateKeyStats` 对区间内每一天生成一个 daily pattern）。

因此新路径在当前不足 30 个 key 时可接受，但**并非计算量完全等价**。

**前瞻提醒**：若未来 key 增长到数百量级，请求内全量重算（尤其自定义大区间的多日 SCAN）会开始有感。届时最干净的方向是让**预计算索引本身改用 `calculateKeyStats` 同源重算**（构建期重算、查询期仍走 ZSET），既保住查询期性能，又不丢一致性。当前无需处理。

---

## 四、剩余收尾（待决策）

排序值与展示值的不一致已由本次变更收敛，但仍有两类待处理事项：一是 cost_rank 状态机的退役（资源空转，非正确性问题），二是请求竞态导致的另一类页面状态不一致（本次未处理）。

### 4.1 前端：仍在轮询，但状态已不影响费用排序

`costSortStatus` 已不再参与"费用排序是否可用、排序结果、时间范围回退"等决策（`canSortByCost` / `costSortTooltip` 已与之解耦），但**仍被轮询逻辑读取**——`scheduleNextCostSortStatusRefresh` 会检查是否有索引处于 `updating`，据此决定下一次轮询间隔。因此更准确的表述是"不再影响费用排序"，而非"无人读取"。

下列元素仍在为这套轮询运转：

- `costSortStatus` ref
- `fetchCostSortStatus` 与自调度 `costSortStatusTimer`（周期性打 `GET /admin/api-keys/cost-sort-status`）
- `onMounted` 中的轮询启动、`onUnmounted` 中的定时器清理

### 4.2 后端：仍在计算没人读的索引

- 两个相关端点仍存在：`GET /api-keys/cost-sort-status`（查状态）、`POST /api-keys/cost-sort-refresh`（强制刷新）。前端轮询只调用前者；后者仓库内无调用方，但属管理 API，可能有外部脚本或调用方，删除前需做兼容性确认。
- 列表响应仍附带的 `costSortStatus` 字段，前端已不读取。
- `costRankService` 的后台定时重建（`7days` 30 分钟、`30days` 1 小时等）、`app.js` 的 initialize/shutdown、`apiKeyService` 在建/删 key 时的 `addKeyToIndexes` / `removeKeyFromIndexes`，都在持续写入一个**没有任何查询路径再读取**的 ZSET 索引。

### 4.3 清理方案（两档，供后续决策）

**A. 小清理（本视图/本路由内，低风险）**

- 前端删除 `costSortStatus` ref、`fetchCostSortStatus`、`costSortStatusTimer` 及对应生命周期钩子；`canSortByCost` / `costSortTooltip` 内联为常量或简化模板绑定。
- 后端移除路由内的 `costSortStatus` 局部变量及列表响应中的 `costSortStatus` 字段；删除两个 cost-sort-status 端点。

**B. 大清理（跨文件，需决策）**

- 移除 `costRankService` 的 initialize/shutdown、`apiKeyService` 中的 add/remove 钩子，乃至整个 service 文件，彻底停止后台索引重建。
- 收益最大（省掉周期性 Redis 重算与写放大），但涉及 `src/app.js`、`src/services/apiKeyService.js`，影响面更大。

### 4.4 决策参考

- 若确认没有外部调用方、且未来不再需要预计算排序，可退役 `costRankService`。实施前需完成：接口兼容性确认（`GET /api-keys/cost-sort-status`、`POST /api-keys/cost-sort-refresh` 是否有外部调用方）、生命周期引用清理（`src/app.js` 的 initialize/shutdown、`src/services/apiKeyService.js` 的 add/remove 钩子，并验证启动与关闭流程）、历史 Redis key 清理（`cost_rank:*`、`cost_rank_meta:*`、`cost_rank_lock:*` 等）。
- 若预期 key 会显著增长：可保留 service 处于休眠（仅删除查询/轮询侧，即 A 方案），未来按 3.3 的方向把预计算索引改为同源重算后再重新启用，避免重复造轮子。

### 4.5 请求竞态仍待处理（另一类页面状态不一致）

`loadApiKeys()` 发起请求时没有请求序列号、取消旧请求或参数快照校验。用户快速切换排序、时间范围或分页时，旧请求可能晚于新请求返回，随后覆盖 `apiKeys`、分页信息、内联 stats、`statsCache`。

其中最隐蔽的一处：内联统计写入缓存时使用的是**响应返回时刻的 `globalDateFilter`**，而非发起请求时的快照。因此旧请求（按旧范围算出的统计）晚回时，会被错误地标记成新范围写进 `statsCache`，造成展示与实际筛选范围错位。

相关位置：`loadApiKeys` 的请求发起与内联 stats 写入（`web/admin-spa/src/views/ApiKeysView.vue`）。可选方向：为每次请求分配单调递增的序列号，响应返回时丢弃过期请求；或对发起请求时的范围参数做快照，仅在响应匹配快照时写入缓存。

---

## 五、关键代码位置（便于后续定位）

> 函数/端点以名称为主，行号会随提交漂移。

- 费用排序统一入口：`getApiKeysSortedByCostAccurate`（`src/routes/admin/apiKeys.js`）
- 费用计算同源函数：`calculateKeyStats`（同文件，新增 `30days` 分支与 `apiKeyOverride` 入参）
- 路由分发：`GET /admin/api-keys` 中 `validSortBy === 'cost'` 分支
- 内联 stats 消费：`loadApiKeys`（`web/admin-spa/src/views/ApiKeysView.vue`）
- 请求竞态/内联 stats 缓存写入：同上 `loadApiKeys`（详见 4.5）
- 预计算索引服务：`src/services/costRankService.js`（待决策是否退役）
- 生命周期接入：`src/app.js`、`src/services/apiKeyService.js`
