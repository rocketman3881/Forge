import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export function loadSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.FORGE_SECRET
  if (!raw) throw new Error('FORGE_SECRET is required')
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) throw new Error('FORGE_SECRET must be 64 hex chars (32 bytes)')
  return key
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.')
}

export function decryptSecret(enc: string, key: Buffer): string {
  const parts = enc.split('.')
  if (parts.length !== 3) throw new Error('malformed encrypted secret')
  const [iv, ct, tag] = parts.map((s) => Buffer.from(s, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', key, iv!)
  d.setAuthTag(tag!)
  return Buffer.concat([d.update(ct!), d.final()]).toString('utf8')
}
