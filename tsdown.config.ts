import { defineConfig } from 'tsdown'

/**
 * The desktop app ships one entry: the Electron main process. `electron` and
 * every `@deepseek-ai/*` dependency stay external — the harness boot resolves
 * them from this package's node_modules at runtime. The sandboxed preload is
 * hand-written CommonJS (`src/preload.cjs`) and copied verbatim by
 * `scripts/copy-preload.mjs`: sandboxed preloads must stay CJS, which the
 * workspace-wide `"type": "module"` would otherwise break.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: ['electron'] },
})
