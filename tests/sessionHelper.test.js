const crypto = require('crypto')

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))

const sessionHelper = require('../src/utils/sessionHelper')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')

const HEADER_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const METADATA_SESSION_ID = '22222222-2222-4222-8222-222222222222'
const LEGACY_SESSION_ID = '33333333-3333-4333-8333-333333333333'

function hash32(value) {
  return crypto.createHash('sha256').update(value).digest('hex').substring(0, 32)
}

describe('SessionHelper', () => {
  describe('extractClientSessionId', () => {
    it('优先使用 header 中的 session ID', () => {
      const body = {
        metadata: {
          user_id: JSON.stringify({ session_id: METADATA_SESSION_ID })
        }
      }

      expect(
        sessionHelper.extractClientSessionId(
          { 'x-claude-code-session-id': HEADER_SESSION_ID },
          body
        )
      ).toEqual({
        clientSessionId: HEADER_SESSION_ID,
        source: 'header',
        stickySessionKey: HEADER_SESSION_ID
      })
    })

    it('header 无效时读取 metadata.user_id JSON', () => {
      const body = {
        metadata: {
          user_id: JSON.stringify({ session_id: METADATA_SESSION_ID })
        }
      }

      expect(
        sessionHelper.extractClientSessionId({ 'x-claude-code-session-id': 'not-a-uuid' }, body)
      ).toEqual({
        clientSessionId: METADATA_SESSION_ID,
        source: 'metadata_json',
        stickySessionKey: METADATA_SESSION_ID
      })
    })

    it('兼容旧版 metadata session_<uuid> 格式', () => {
      const body = {
        metadata: {
          user_id: `user_account__session_${LEGACY_SESSION_ID}`
        }
      }

      expect(sessionHelper.extractClientSessionId({}, body)).toEqual({
        clientSessionId: LEGACY_SESSION_ID,
        source: 'legacy_pattern',
        stickySessionKey: LEGACY_SESSION_ID
      })
    })

    it('没有真实 session ID 时返回内容 hash 作为 sticky key', () => {
      expect(
        sessionHelper.extractClientSessionId({}, { messages: [{ content: 'first message' }] })
      ).toEqual({
        clientSessionId: null,
        source: 'none',
        stickySessionKey: hash32('first message')
      })
    })
  })

  describe('generateSessionHash fallback compatibility', () => {
    it('system 和 message 同时有 ephemeral 时保持旧版拼接算法', () => {
      const body = {
        system: [
          {
            type: 'text',
            text: 'SYSTEM',
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'USER',
                cache_control: { type: 'ephemeral' }
              }
            ]
          }
        ]
      }

      expect(sessionHelper.generateSessionHash(body)).toBe(hash32('SYSTEMUSER'))
    })

    it('message cache breakpoint 仍使用第一条非空消息文本', () => {
      const body = {
        messages: [
          { role: 'user', content: 'FIRST' },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'SECOND',
                cache_control: { type: 'ephemeral' }
              }
            ]
          }
        ]
      }

      expect(sessionHelper.generateSessionHash(body)).toBe(hash32('FIRST'))
    })

    it('generateSessionHash 接受 headers 并返回真实 session ID', () => {
      expect(
        sessionHelper.generateSessionHash(
          { messages: [{ content: 'ignored fallback' }] },
          { 'x-claude-code-session-id': HEADER_SESSION_ID }
        )
      ).toBe(HEADER_SESSION_ID)
    })
  })
})

describe('ClaudeRelayConfigService session extraction', () => {
  it('复用 SessionHelper 并支持 header session ID', () => {
    expect(
      claudeRelayConfigService.extractOriginalSessionId(
        {
          metadata: {
            user_id: JSON.stringify({ session_id: METADATA_SESSION_ID })
          }
        },
        { 'x-claude-code-session-id': HEADER_SESSION_ID }
      )
    ).toBe(HEADER_SESSION_ID)
  })
})
