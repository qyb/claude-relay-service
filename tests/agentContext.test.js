const {
  AgentContextResolver,
  deriveAgentContext,
  extractFirstUserMessageText,
  isContinuationSummaryText
} = require('../src/utils/agentContext')

describe('agentContext', () => {
  it('不同 system/tool 集合派生不同上下文 id（父子/Auto 隔离的基础）', () => {
    const parent = deriveAgentContext({
      system: 'parent system prompt',
      tools: [{ name: 'Read' }, { name: 'Edit' }],
      messages: [{ role: 'user', content: 'parent task' }]
    })
    const auto = deriveAgentContext({
      system: 'classifier system prompt',
      messages: [{ role: 'user', content: 'classifier prompt' }]
    })

    expect(parent.agentContextId).toMatch(/^[0-9a-f]{16}$/)
    expect(auto.agentContextId).toMatch(/^[0-9a-f]{16}$/)
    expect(parent.agentContextId).not.toBe(auto.agentContextId)
    expect(parent.contextFingerprint).toContain('sys:')
    expect(parent.contextFingerprint).toContain('tools:')
    expect(parent.contextFingerprint).toContain('first:')
  })

  it('同一上下文的重复请求派生相同 id（稳定性）', () => {
    const body = () => ({
      system: 'stable system',
      tools: [{ name: 'Read' }],
      messages: [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'follow-up' }
      ]
    })

    expect(deriveAgentContext(body()).agentContextId).toBe(
      deriveAgentContext(body()).agentContextId
    )
  })

  it('同配置兄弟上下文靠首条用户消息区分', () => {
    const base = {
      system: 'shared subagent system',
      tools: [{ name: 'Grep' }]
    }
    const siblingA = deriveAgentContext({
      ...base,
      messages: [{ role: 'user', content: 'task A' }]
    })
    const siblingB = deriveAgentContext({
      ...base,
      messages: [{ role: 'user', content: 'task B' }]
    })

    expect(siblingA.agentContextId).not.toBe(siblingB.agentContextId)
  })

  it('空请求体返回 null（调用方回退 session 级状态）', () => {
    const result = deriveAgentContext({})
    expect(result.agentContextId).toBeNull()
    expect(result.contextFingerprint).toBeNull()
  })

  it('tool_result-only 的首条消息被跳过，取首个含文本的 user 消息', () => {
    const result = deriveAgentContext({
      system: 'sys',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output' }]
        },
        { role: 'user', content: 'real first message' }
      ]
    })
    expect(result.firstUserMessageHash).not.toBeNull()
  })

  it('首条用户消息指纹是固定长度的 HMAC 组件，非普通 SHA 前缀', () => {
    const result = deriveAgentContext({
      system: 'sys',
      messages: [{ role: 'user', content: 'fix the test' }]
    })
    // HMAC 后无法从外部用普通 SHA 字典枚举还原；长度与其它组件一致
    expect(result.firstUserMessageHash).toMatch(/^[0-9a-f]{12}$/)
    expect(extractFirstUserMessageText([{ role: 'user', content: 'fix the test' }])).toBe(
      'fix the test'
    )
    expect(
      isContinuationSummaryText('This session is being continued from a previous conversation.')
    ).toBe(true)
    expect(isContinuationSummaryText('fix the test')).toBe(false)
  })

  it('回归：压缩把首条用户消息替换为 summary 后，resolver 保持同一 agent_context_id', () => {
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const scopeKey = 'scope-key-1'
    const config = {
      system: 'main system prompt',
      tools: [{ name: 'Read' }, { name: 'Edit' }]
    }

    const before = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'fix the test' }] },
      scopeKey
    )
    const afterCompression = resolver.resolve(
      {
        ...config,
        messages: [
          {
            role: 'user',
            content:
              'This session is being continued from a previous conversation that ran out of context. Summary of analysis so far...'
          }
        ]
      },
      scopeKey
    )

    expect(afterCompression.agentContextId).toBe(before.agentContextId)
    expect(afterCompression.agentContextId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('resolver 下同配置兄弟上下文仍按首条消息区分', () => {
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const scopeKey = 'scope-key-2'
    const config = { system: 'subagent system', tools: [{ name: 'Grep' }] }

    const siblingA = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'task A' }] },
      scopeKey
    )
    const siblingB = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'task B' }] },
      scopeKey
    )

    expect(siblingA.agentContextId).not.toBe(siblingB.agentContextId)
  })

  it('回归：同配置兄弟上下文 A、B 都登记后，B 压缩不得 alias 到 A 的分支', () => {
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const scopeKey = 'scope-sibling-ambiguous'
    const config = {
      system: 'shared subagent system',
      tools: [{ name: 'Grep' }]
    }

    const ctxA = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'task A' }] },
      scopeKey
    )
    const ctxB = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'task B' }] },
      scopeKey
    )
    // B 压缩：首条消息被 continuation summary 替换
    const bCompressedBody = {
      ...config,
      messages: [
        {
          role: 'user',
          content:
            'This session is being continued from a previous conversation. Summary of task B analysis...'
        }
      ]
    }
    const ctxBCompressed = resolver.resolve(bCompressedBody, scopeKey)

    // 无证据指向 A 或 B：不得拿到 A 的 id，也不得复用 B 的原始分支
    expect(ctxBCompressed.agentContextId).not.toBe(ctxA.agentContextId)
    expect(ctxBCompressed.agentContextId).not.toBe(ctxB.agentContextId)
    expect(ctxBCompressed.agentContextId).toMatch(/^[0-9a-f]{16}$/)

    // 同一 summary 的后续请求保持稳定（summary 自身指纹为分支）
    const ctxBCompressedAgain = resolver.resolve(
      {
        ...bCompressedBody,
        messages: [...bCompressedBody.messages, { role: 'assistant', content: 'ok' }]
      },
      scopeKey
    )
    expect(ctxBCompressedAgain.agentContextId).toBe(ctxBCompressed.agentContextId)
  })

  it('resolver 输出 context_key_id，指纹组件为固定长度 HMAC', () => {
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const result = resolver.resolve(
      {
        system: 'shared system',
        tools: [{ name: 'Read' }],
        messages: [{ role: 'user', content: 'task' }]
      },
      'scope-key-id-1'
    )
    // 测试环境未配置 ENCRYPTION_KEY，密钥为进程随机值
    expect(result.contextKeyId).toMatch(/^(ek|ephemeral)-[0-9a-f]{8}$/)
    expect(result.systemPromptHash).toMatch(/^[0-9a-f]{12}$/)
    expect(result.toolSchemaHash).toMatch(/^[0-9a-f]{12}$/)
    expect(result.firstUserMessageHash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('无 scope 时 resolver 退化为无状态派生（压缩 summary 视为独立分支）', () => {
    const resolver = new AgentContextResolver({ cacheSize: 8 })
    const config = { system: 'sys', tools: [{ name: 'Read' }] }

    const withPrompt = resolver.resolve(
      { ...config, messages: [{ role: 'user', content: 'fix the test' }] },
      null
    )
    const withSummary = resolver.resolve(
      {
        ...config,
        messages: [
          { role: 'user', content: 'This session is being continued from a previous conversation.' }
        ]
      },
      null
    )

    expect(withSummary.agentContextId).not.toBe(withPrompt.agentContextId)
  })
})
