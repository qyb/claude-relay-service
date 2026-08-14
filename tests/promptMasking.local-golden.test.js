const fs = require('fs')
const path = require('path')
const { maskPrompt } = require('../src/utils/promptMasker')

const goldenDir = process.env.PROMPT_GOLDEN_DIR
const goldenPath = goldenDir ? path.join(goldenDir, 'prompt-golden.jsonl') : null
const describeLocal = goldenDir ? describe : describe.skip

let samples = []
if (goldenDir) {
  if (!fs.existsSync(goldenPath)) {
    throw new Error(`PROMPT_GOLDEN_DIR 中缺少 prompt-golden.jsonl：${goldenPath}`)
  }
  samples = fs
    .readFileSync(goldenPath, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describeLocal('本地真实日志 golden 脱敏回归', () => {
  test.each(samples)('$source:$line', (sample) => {
    const result = maskPrompt(sample.prompt, {
      hmacKey: process.env.ENCRYPTION_KEY || 'local-golden-extraction-key'
    })

    if (result.maskedPrompt === sample.prompt) {
      throw new Error(`未发生替换：${sample.source}:${sample.line}`)
    }
    if (result.maskCount !== sample.expected_mask_count) {
      throw new Error(
        `mask_count 变化：${sample.source}:${sample.line}，期望 ${sample.expected_mask_count}，实际 ${result.maskCount}`
      )
    }
    if (result.suspectedSecret !== sample.expected_suspected_secret) {
      throw new Error(`suspected_secret 变化：${sample.source}:${sample.line}`)
    }
  })
})
