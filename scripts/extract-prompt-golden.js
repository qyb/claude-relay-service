/**
 * 从本地 Prompt Log 提取真实数据 golden 用例。
 *
 * 输出包含原始 prompt，因此默认写入 .local/ 并设置为 0600；脚本不会把
 * prompt 内容打印到 stdout。该文件只用于本地回归测试，禁止提交仓库。
 */

const fs = require('fs')
const path = require('path')
const { detectPromptCategories, maskPrompt } = require('../src/utils/promptMasker')

const DEFAULT_FILES = [
  'prompt-log-2026-08-08.log',
  'prompt-log-2026-08-09.log',
  'prompt-log-2026-08-10.log',
  'prompt-log-2026-08-11.log',
  'prompt-log-2026-08-12.log',
  'prompt-log-2026-08-13.log',
  'prompt-log-2026-08-14.log'
]

function parseArgs(argv) {
  const files = []
  const options = {
    output: process.env.PROMPT_GOLDEN_OUTPUT || '.local/prompt-golden.jsonl',
    perCategory: Number.parseInt(process.env.PROMPT_GOLDEN_PER_CATEGORY || '8', 10)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--output') {
      options.output = argv[++index]
    } else if (argument === '--per-category') {
      options.perCategory = Number.parseInt(argv[++index], 10)
    } else if (argument === '--help') {
      console.log(
        '用法：node scripts/extract-prompt-golden.js [日志文件...] [--output 路径] [--per-category 数量]'
      )
      process.exit(0)
    } else {
      files.push(argument)
    }
  }

  return {
    files: files.length > 0 ? files : DEFAULT_FILES,
    output: options.output,
    perCategory:
      Number.isFinite(options.perCategory) && options.perCategory > 0 ? options.perCategory : 8
  }
}

function readCandidates(filePath, hmacKey) {
  const candidates = []
  const lines = fs.readFileSync(filePath, 'utf8').split(/\n/).filter(Boolean)

  lines.forEach((line, index) => {
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      return
    }

    if (typeof record.prompt !== 'string') {
      return
    }

    const categories = detectPromptCategories(record.prompt)
    const masked = maskPrompt(record.prompt, { hmacKey })
    if (categories.length === 0 || masked.maskCount === 0) {
      return
    }

    candidates.push({
      source: path.basename(filePath),
      line: index + 1,
      categories,
      expected_mask_count: masked.maskCount,
      expected_suspected_secret: masked.suspectedSecret === true,
      prompt: record.prompt
    })
  })

  return candidates
}

function selectCandidates(candidates, perCategory) {
  const selected = []
  const counts = new Map()
  const sorted = [...candidates].sort((left, right) => left.prompt.length - right.prompt.length)

  for (const candidate of sorted) {
    const useful = candidate.categories.some(
      (category) => (counts.get(category) || 0) < perCategory
    )
    if (!useful) {
      continue
    }

    selected.push(candidate)
    for (const category of candidate.categories) {
      counts.set(category, (counts.get(category) || 0) + 1)
    }
  }

  return { selected, counts }
}

function main() {
  const { files, output, perCategory } = parseArgs(process.argv.slice(2))
  const hmacKey = process.env.ENCRYPTION_KEY || 'local-golden-extraction-key'
  const candidates = []
  const missing = []

  for (const file of files) {
    if (!fs.existsSync(file)) {
      missing.push(file)
      continue
    }
    candidates.push(...readCandidates(file, hmacKey))
  }

  if (missing.length > 0) {
    throw new Error(`日志文件不存在：${missing.join(', ')}`)
  }

  const { selected, counts } = selectCandidates(candidates, perCategory)
  const outputPath = path.resolve(output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    outputPath,
    selected.map((candidate) => JSON.stringify(candidate)).join('\n') +
      (selected.length ? '\n' : ''),
    { encoding: 'utf8', mode: 0o600 }
  )
  fs.chmodSync(outputPath, 0o600)

  console.log(
    JSON.stringify(
      {
        output: path.relative(process.cwd(), outputPath),
        selected: selected.length,
        candidate_count: candidates.length,
        categories: Object.fromEntries(counts)
      },
      null,
      2
    )
  )
}

main()
