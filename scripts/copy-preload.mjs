// Copies the hand-written sandboxed preload into lib/ beside the bundled main.
// Sandboxed Electron preloads must be CommonJS; the workspace is ESM-only
// (`"type": "module"`), so the preload is authored as .cjs and never bundled.
import { copyFileSync, mkdirSync } from 'node:fs'

const root = new URL('..', import.meta.url)
mkdirSync(new URL('lib/', root), { recursive: true })
copyFileSync(new URL('src/preload.cjs', root), new URL('lib/preload.cjs', root))
