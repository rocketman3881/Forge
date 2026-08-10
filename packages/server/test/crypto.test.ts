import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encryptSecret, decryptSecret, loadSecretKey } from '../src/lib/crypto.js'

const key = randomBytes(32)

it('round-trips a secret', () => {
  const enc = encryptSecret('rk_live_abc123', key)
  expect(enc).not.toContain('rk_live')
  expect(decryptSecret(enc, key)).toBe('rk_live_abc123')
})

it('throws on tampered ciphertext and wrong key', () => {
  const enc = encryptSecret('secret', key)
  const [iv, ct, tag] = enc.split('.')
  expect(() => decryptSecret(`${iv}.${ct!.slice(0, -2)}AA.${tag}`, key)).toThrow()
  expect(() => decryptSecret(enc, randomBytes(32))).toThrow()
  expect(() => decryptSecret('nonsense', key)).toThrow()
})

it('loadSecretKey enforces 64 hex chars', () => {
  expect(loadSecretKey({ FORGE_SECRET: 'ab'.repeat(32) }).length).toBe(32)
  expect(() => loadSecretKey({})).toThrow()
  expect(() => loadSecretKey({ FORGE_SECRET: 'abcd' })).toThrow()
})
