// Reproduce the exact client write path host-side: settings.mutate with path ops.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { prepareDesktopPlugins, desktopPluginsDir } from './src/plugins.ts'
import { desktopOverlayPath } from './src/desktop.ts'

const home = mkdtempSync(join(tmpdir(), 'dsh-mutate-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const customPatch = prepareDesktopPlugins({ pluginsDir: desktopPluginsDir(process.cwd()), profileDir: join(home, 'profiles', 'web') })
const booted = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [desktopOverlayPath(), customPatch ?? ''],
  args: [],
})
const settings = booted.ctx.get('settings')
const ns = settingsNamespace('compaction')

console.log('registered:', settings.describe().some(r => r.ns === 'compaction'))
console.log('before:', JSON.stringify(settings.get(ns)))
try {
  await settings.mutate(ns, [{ op: 'set', path: ['thresholdRatio'], value: 0.6 }])
  console.log('mutate OK; after:', JSON.stringify(settings.get(ns)))
} catch (e) {
  console.log('mutate THREW:', e.name, '-', e.message)
}
try {
  await settings.update(ns, { thresholdRatio: 0.7 })
  console.log('update OK; after:', JSON.stringify(settings.get(ns)))
} catch (e) {
  console.log('update THREW:', e.name, '-', e.message)
}
await booted.shutdown.shutdown(0)
rmSync(home, { recursive: true, force: true })
