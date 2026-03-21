# Known Issues

## UTF-8 Stream Decoding Bug

### 问题描述

在 SSE 流式转发路径中，原代码使用 `chunk.toString('utf8')` 直接解码每个数据块。当 UTF-8 多字节字符（如中文）被网络分片切在边界中间时，会导致乱码 `�` 或 `��`。

**问题模式**：
```js
// 危险：可能截断 UTF-8 多字节字符
stream.on('data', (chunk) => {
  const chunkStr = chunk.toString()  // 或 chunk.toString('utf8')
  buffer += chunkStr
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  // ...
})
```

**触发条件**：
1. upstream 以字节流分段返回
2. 分段边界落在 UTF-8 多字节字符中间（如 `你` = `0xE4 0xBD 0xA0` 被切成 `0xE4` | `0xBD 0xA0`）
3. 服务端按段直接 `toString('utf8')`

### 修复方案

使用 Node.js 的 `StringDecoder('utf8')` 做增量解码，只在字符完整后再输出行。

新增工具文件：`src/utils/sseStreamDecoder.js`

```js
const { consumeSseLines } = require('../utils/sseStreamDecoder')

consumeSseLines(upstream.data, {
  onChunk: (chunk) => {
    // 可选：透传原始字节
    res.write(chunk)
  },
  onLine: (line) => {
    // 处理完整行
  },
  onEnd: async () => {
    // 流结束处理
  },
  onError: (err) => {
    // 错误处理
  }
})
```

---

## 修复进度

### 已完成修复 (5 files)

| 文件 | 行号 | 状态 | 说明 |
|------|------|------|------|
| `src/utils/sseStreamDecoder.js` | - | ✅ 新增 | UTF-8 安全的 SSE 行解码器 |
| `tests/sseStreamDecoder.test.js` | - | ✅ 新增 | 单元测试（4 个用例） |
| `src/routes/openaiRoutes.js` | 707 | ✅ 已修复 | OpenAI 流式转发 |
| `src/services/claudeRelayService.js` | 2323 | ✅ 已修复 | Claude 官方 API 流式转发 |
| `src/services/claudeConsoleRelayService.js` | 1159 | ✅ 已修复 | Claude Console 流式转发 |

### 待修复 (8 files)

| # | 文件 | 行号 | 难度 | 说明 |
|---|------|------|------|------|
| 1 | `src/routes/openaiGeminiRoutes.js` | 426-434 | 🟢 简单 | 标准 SSE 事件循环，模式与已修复的 `openaiRoutes.js` 几乎相同 |
| 2 | `src/services/geminiRelayService.js` | 119 | 🟢 简单 | async generator，直接替换 buffer 逻辑即可 |
| 3 | `src/services/openaiResponsesRelayService.js` | 484-492 | 🟢 简单 | 与 `openaiRoutes.js` 模式相同，转发+解析 usage |
| 4 | `src/services/azureOpenaiRelayService.js` | 410-418 | 🟡 中等 | 有额外的 `finalChunksBuffer` 和 buffer 大小限制逻辑，需保留 |
| 5 | `src/services/droidRelayService.js` | 561-582 | 🟡 中等 | 调用 `_parseAnthropicUsageFromSSE` / `_parseOpenAIUsageFromSSE` 辅助方法，需同步修改 |
| 6 | `src/handlers/geminiHandlers.js` | 569 | 🟡 中等 | **没有 buffer 拼接**，直接 `chunkStr.split('\n')`，跨 chunk 的行会丢失 |
| 7 | `src/services/antigravityRelayService.js` | 43 | 🟡 中等 | async generator，需要改为基于回调或创建适配器 |
| 8 | `src/services/anthropicGeminiBridgeService.js` | 4346, 5562 | 🔴 复杂 | 大型服务文件（5500+ 行），有多处流处理，包含 probe 探测和智能重试机制 |

### 难度说明

- **🟢 简单** - 直接套用 `consumeSseLines` 模式，15分钟内可完成
- **🟡 中等** - 需要保留额外逻辑或适配不同模式
- **🔴 复杂** - 逻辑复杂，改动风险高，需要仔细测试

### 建议修复顺序

1. `openaiGeminiRoutes.js` (简单，验证模式)
2. `geminiRelayService.js` (简单)
3. `openaiResponsesRelayService.js` (简单)
4. `azureOpenaiRelayService.js` (中等)
5. `droidRelayService.js` (中等)
6. `geminiHandlers.js` (中等)
7. `antigravityRelayService.js` (中等)
8. `anthropicGeminiBridgeService.js` (复杂，最后处理)

---

## 相关 Commit

- llm-relay-lite 修复参考: `6b6cbcbbb1e120b79c98fbaafa3378065ba49e00`