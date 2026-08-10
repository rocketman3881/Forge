import { defineConfig } from 'vitest/config'

// PGlite spins up a fresh WASM Postgres per test file; on cold caches and
// under parallel load the heavier multi-request tests exceed vitest's 5s
// default. 20s keeps real hangs detectable without flaking on slow machines.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
})
