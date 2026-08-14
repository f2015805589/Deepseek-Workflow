import { defineConfig } from 'vitest/config'

// Standalone vitest config for the desktop repo: its tests live under tests/
// and import workspace packages through the harness checkout (relative paths
// or package names resolved by pnpm). The harness root config is not applied
// here — this repo is also published standalone (Deepseek-Workflow).
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
