import { expect, it, vi } from 'vitest'
import { login } from '../src/auth.js'

it('resolves with the token relayed by the loopback page', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const token = await login('http://backend', (startUrl) => {
    const redirect = new URL(startUrl).searchParams.get('redirect_uri')!
    // Simulate the relay page: browser hits /cb, page JS calls /token
    void fetch(redirect).then(async (res) => {
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('location.hash')
      await fetch(redirect.replace('/cb', '/token?token=tok_live'))
    })
  })
  expect(token).toBe('tok_live')
})

it('rejects on timeout when no token ever arrives', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await expect(login('http://backend', () => {}, 100)).rejects.toThrow('timed out')
})
