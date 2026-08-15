/**
 * HMAC 密钥派生 — 脱敏指纹与 prompt_hash 共用 ENCRYPTION_KEY，按用途隔离。
 *
 * 未配置 ENCRYPTION_KEY 时使用进程内随机密钥：脱敏仍然全量替换，但指纹与
 * hash 跨进程不可关联（key id 带 ephemeral- 前缀提示这一状态）。
 */

const crypto = require('crypto')

const RANDOM_ROOT = crypto.randomBytes(32)
const keyCache = new Map()

function resolveRootKey(provided) {
  if (Buffer.isBuffer(provided) && provided.length > 0) {
    return provided
  }
  const raw = provided ?? process.env.ENCRYPTION_KEY
  if (typeof raw === 'string' && raw.length > 0) {
    return Buffer.from(raw, 'utf8')
  }
  if (raw !== undefined && raw !== null && String(raw).length > 0) {
    return Buffer.from(String(raw), 'utf8')
  }
  return null
}

function cacheToken(provided) {
  if (provided === undefined) {
    return 'env'
  }
  // 缓存键只用密钥材料的摘要，不在内存中长期保留原始密钥字符串
  const material = Buffer.isBuffer(provided) ? provided : Buffer.from(String(provided), 'utf8')
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * 按用途派生 HMAC 密钥；同一 (purpose, root) 组合只派生一次。
 */
function getPurposeKey(purpose, provided) {
  const cacheKey = `${purpose}:${cacheToken(provided)}`
  let derived = keyCache.get(cacheKey)
  if (!derived) {
    const root = resolveRootKey(provided) ?? RANDOM_ROOT
    derived = crypto.createHmac('sha256', root).update(`crs:${purpose}`).digest()
    keyCache.set(cacheKey, derived)
  }
  return derived
}

/**
 * 密钥 id：8 hex。ephemeral- 前缀表示进程随机密钥，重启后指纹不可关联。
 */
function getKeyId(purpose, provided) {
  const id = crypto
    .createHash('sha256')
    .update(getPurposeKey(purpose, provided))
    .digest('hex')
    .slice(0, 8)
  return resolveRootKey(provided) === null ? `ephemeral-${id}` : `ek-${id}`
}

function isEphemeralKey(provided) {
  return resolveRootKey(provided) === null
}

module.exports = { getPurposeKey, getKeyId, isEphemeralKey }
