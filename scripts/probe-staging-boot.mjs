// Headless probe: boots the packaged staging tree's profile boot exactly like
// the Electron main process, but under plain Node — separating staging-tree
// defects from asar/junction defects. Prints the full nested error causes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const parent = fileURLToPath(new URL('..', import.meta.url))
const staging = join(parent, 'deploy')
const dshLib = pathToFileURL(join(staging, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')).href
const appBootLib = pathToFileURL(join(staging, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href
const overlay = join(staging, 'config/desktop.patch.yml')

const home = mkdtempSync(join(tmpdir(), 'dsh-packaged-probe-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'

function dump(error, depth = 0) {
  const pad = '  '.repeat(depth)
  console.error(`${pad}${error?.stack ?? String(error)}`)
  if (error?.errors !== undefined && Array.isArray(error.errors)) {
    for (const inner of error.errors) dump(inner, depth + 1)
  }
  if (error?.cause !== undefined) {
    console.error(`${pad}caused by:`)
    dump(error.cause, depth + 1)
  }
}

try {
  const { runProfile } = await import(dshLib)
  const { loadLayeredEnv } = await import(appBootLib)
  const booted = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [overlay],
    args: [],
  })
  const port = booted.ctx.get('webServer')?.port
  console.log('BOOT OK, port:', port)
  await booted.shutdown.shutdown(0)
} catch (error) {
  console.error('BOOT FAILED:')
  dump(error)
  process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
}
