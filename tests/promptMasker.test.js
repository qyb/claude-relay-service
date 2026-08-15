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

    expect(first.maskedPrompt).toMatch(/^password=\[MASKED:password:[0-9a-f]{16}\]$/)
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

  it('手机号、邮箱和身份证采用部分 mask，并保留实体 HMAC 指纹', () => {
    const result = maskPrompt('13512345678 h@example.com 110101199001011234', {
      hmacKey: MASK_KEY
    })

    expect(result.maskedPrompt).toBe('135****78 h***@example.com 110****34')
    expect(result.maskCount).toBe(3)
    expect(result.entityFingerprints).toHaveLength(3)
    expect(result.entityFingerprints.map((item) => item.type).sort()).toEqual([
      'email',
      'id_card',
      'phone'
    ])
    for (const entity of result.entityFingerprints) {
      expect(entity.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    }
    // 同一实体跨请求指纹一致，可关联可去重
    const again = maskPrompt('13512345678', { hmacKey: MASK_KEY })
    const phoneFingerprint = result.entityFingerprints.find((item) => item.type === 'phone')
    expect(again.entityFingerprints[0].fingerprint).toBe(phoneFingerprint.fingerprint)
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

  it('高熵字符串默认整体替换为指纹占位符，并标记 suspected_secret', () => {
    const candidate = 'aB3$kL9!qR2@xY7#nM4%pQ8&'
    const result = maskPrompt(`请人工确认 ${candidate}`, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).not.toContain(candidate)
    expect(result.maskedPrompt).toMatch(/\[MASKED:high_entropy:[0-9a-f]{16}\]/)
    expect(result.maskCount).toBe(1)
    expect(result.highEntropyCount).toBe(1)
    expect(result.suspectedSecret).toBe(true)
    expect(hasSuspectedSecret(candidate)).toBe(true)
  })

  it('bearer 小写、边缘标点、CJK 前缀和 URL 签名参数均不泄漏明文', () => {
    const cases = [
      {
        prompt: 'bearer abcdefghijklmnopqrstuvwxyz123456',
        secret: 'abcdefghijklmnopqrstuvwxyz123456'
      },
      {
        prompt: 'value aB3$kL9!qR2@xY7#nM4%pQ8&dE5,',
        secret: 'aB3$kL9!qR2@xY7#nM4%pQ8&dE5'
      },
      {
        prompt: '请使用aB3$kL9!qR2@xY7#nM4%pQ8&dE5',
        secret: 'aB3$kL9!qR2@xY7#nM4%pQ8&dE5'
      },
      {
        prompt:
          'https://x.test/a?X-Amz-Signature=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        secret: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      }
    ]

    for (const { prompt, secret } of cases) {
      const result = maskPrompt(prompt, { hmacKey: MASK_KEY })
      expect(result.maskedPrompt).not.toContain(secret)
      expect(result.maskCount).toBeGreaterThan(0)
    }
  })

  it('文件路径、代码片段和 URL query 不会被高熵规则误伤', () => {
    const prompt = [
      'values 文件 product/ASC/scg-webhook-v2/Jenkinsfile 需要更新',
      '配置 JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk1.8.0_291/Contents/Home',
      '接口 /api/v1/accounts?page=2&pageSize=50&accountId=11&lang=zh-CN 返回 200',
      '压缩代码 ),duration:1500,onClose:function(){s.getList()}})}))},search:function(e)'
    ].join('\n')
    const result = maskPrompt(prompt, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).toContain('product/ASC/scg-webhook-v2/Jenkinsfile')
    expect(result.maskedPrompt).toContain('JAVA_HOME=/Library/Java')
    expect(result.maskedPrompt).toContain('/api/v1/accounts?page=2')
    expect(result.maskedPrompt).toContain('duration:1500')
    expect(result.maskCount).toBe(0)
  })

  it('bcrypt 哈希和厂商前缀密钥仍会被兜底替换', () => {
    const bcrypt = '$2a$12$OJG3Jh8JJagjcI000Fegj.E0ngUBbwN02q43U1l5ltcX9Q'
    const result = maskPrompt(`存储的哈希 ${bcrypt}`, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).not.toContain(bcrypt)
    expect(result.maskCount).toBe(1)
    expect(result.suspectedSecret).toBe(true)
  })

  it('长中文混合文本不会因字符熵偏高被高熵规则误伤', () => {
    const prompt =
      '这是一个超过二十个字符的中文长句子，其中夹杂English1单词和数字2026，正常业务讨论不应被替换'
    const result = maskPrompt(prompt, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).toBe(prompt)
    expect(result.maskCount).toBe(0)
    expect(result.suspectedSecret).toBe(false)
  })

  it('扩充的常见厂商前缀直接命中', () => {
    const result = maskPrompt(
      'slack token xoxb-1234567890abcdefghij gitlab glpat-abcdefghij1234567890',
      { hmacKey: MASK_KEY }
    )

    expect(result.maskedPrompt).toContain('[MASKED:api_key:')
    expect(result.maskedPrompt).not.toContain('xoxb-1234567890abcdefghij')
    expect(result.maskedPrompt).not.toContain('glpat-abcdefghij1234567890')
  })

  it('结果携带 mask_key_id，同一密钥下稳定', () => {
    const first = maskPrompt('password=a', { hmacKey: MASK_KEY })
    const second = maskPrompt('password=b', { hmacKey: MASK_KEY })
    const otherKey = maskPrompt('password=a', { hmacKey: 'another-key' })

    expect(first.maskKeyId).toMatch(/^ek-[0-9a-f]{8}$/)
    expect(first.maskKeyId).toBe(second.maskKeyId)
    expect(first.maskKeyId).not.toBe(otherKey.maskKeyId)
  })

  it('相同规则版本下不因普通术语和 commit hash 自动替换', () => {
    const prompt = 'api key 记录、key_name、sticky_session、commit 0123456789abcdef0123456789abcdef'
    const result = maskPrompt(prompt, { hmacKey: MASK_KEY })

    expect(result.maskedPrompt).toBe(prompt)
    expect(result.maskCount).toBe(0)
    expect(result.suspectedSecret).toBe(false)
  })
})
