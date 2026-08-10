import { expect, it } from 'vitest'
import { parseId } from '../src/lib/params.js'

it('parses plain positive integers only', () => {
  expect(parseId('42')).toBe(42)
  expect(parseId('0')).toBe(0)
  for (const bad of ['abc', '-1', '1.5', '', '1e3', '99999999999999999']) {
    expect(parseId(bad)).toBeNull()
  }
})
