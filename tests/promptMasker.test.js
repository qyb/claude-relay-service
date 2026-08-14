const {
  detectPromptCategories,
  hasSuspectedSecret,
  maskPrompt
} = require('../src/utils/promptMasker')

const MASK_KEY = 'prompt-mask-test-key'

describe('Prompt masking', () => {
  it('按赋值结构替换密钥，并保留可关联 HMAC 指纹', () => {
    const first = maskPrompt('password=secret-value', { hmacKey: MASK_KEY })
    const second = maskPrompt('password=secret-value', { hmacKey: MASK_KEY })
    const different = maskPrompt('password=another-value', { hmacKey: MASK_KEY })

    expect(first.maskedPrompt).toMatch(/^password=\[MASKED:password:[0-9a-f]{8}\]$/)
    expect(first.maskedPrompt).toBe(second.maskedPrompt)
    expect(first.maskedPrompt).not.toBe(different.maskedPrompt)
    expect(first.maskCount).toBe(1)
  })

  it('支持引号、连接串、认证头、JWT 和 PEM 长结构', () => {
    const prompt = [
      '"token": "token-value"',
      'mysql://user:db-password@db.internal/app',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJabcdefghijk.lmnop.qrstuvwxyz',
      '-----BEGIN PRIVATE KEY-----\\nsecret-material\\n-----END PRIVATE KEY-----'
    ].join('\\n')
    const result = maskPrompt(prompt, { hmacKey: MASK_KEY })

    expect(result.maskCount).toBe(5)
    expect(result.maskedPrompt).not.toContain('db-password')
    expect(result.maskedPrompt).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(result.maskedPrompt).not.toContain('secret-material')
    expect(result.maskedPrompt).toContain('[MASKED:token:')
    expect(result.maskedPrompt).toContain('[MASKED:connection_password:')
    expect(result.maskedPrompt).toContain('[MASKED:auth_header:')
    expect(result.maskedPrompt).toContain('[MASKED:private_key:')
  })

  it('跳过空值和占位符，避免日常安全讨论误伤', () => {
    const result = maskPrompt(
      'api key 记录; key_name=stable; password=***; token=<token>; 密码忘记了吧',
      { hmacKey: MASK_KEY }
    )

    expect(result.maskCount).toBe(0)
    expect(result.maskedPrompt).toContain('key_name=stable')
    expect(result.maskedPrompt).toContain('password=***')
    expect(result.maskedPrompt).toContain('token=<token>')
    expect(detectPromptCategories(result.maskedPrompt)).toContain('structure')
  })

  it('支持环境变量和下划线前缀的密钥名', () => {
    const result = maskPrompt(
      'aws_secret_access_key = wJalrXUtnFEMI/EXAMPLE; DB_PASSWORD=hunter2; access_token = live-token-value',
      { hmacKey: MASK_KEY }
    )

    expect(result.maskCount).toBe(3)
    expect(result.maskedPrompt).not.toContain('wJalrXUtnFEMI/EXAMPLE')
    expect(result.maskedPrompt).not.toContain('hunter2')
    expect(result.maskedPrompt).not.toContain('live-token-value')
  })

  it('手机号、邮箱和身份证采用部分 mask', () => {
    const result = maskPrompt('13512345678 h@example.com 110101199001011234', {
      hmacKey: MASK_KEY
    })

    expect(result.maskedPrompt).toBe('135****78 h***@example.com 110****34')
    expect(result.maskCount).toBe(3)
  })

  it('不从订单号和时间戳中间截取手机号', () => {
    const result = maskPrompt('订单号 2026081413512345678 时间戳 1771070000000 手机 13512345678', {
      hmacKey: MASK_KEY
    })

    expect(result.maskedPrompt).toBe(
      '订单号 2026081413512345678 时间戳 1771070000000 手机 135****78'
    )
    expect(result.maskCount).toBe(1)
  })

  it('高熵字符串只标记，不替换', () => {
    const candidate = 'aB3$kL9!qR2@xY7#nM4%pQ8&'
    const result = maskPrompt(`请人工确认 ${candidate}`, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).toContain(candidate)
    expect(result.maskCount).toBe(0)
    expect(result.suspectedSecret).toBe(true)
    expect(hasSuspectedSecret(candidate)).toBe(true)
  })

  it('相同规则版本下不因普通术语和 commit hash 自动替换', () => {
    const prompt = 'api key 记录、key_name、sticky_session、commit 0123456789abcdef0123456789abcdef'
    const result = maskPrompt(prompt, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).toBe(prompt)
    expect(result.maskCount).toBe(0)
    expect(result.suspectedSecret).toBe(false)
  })
})
