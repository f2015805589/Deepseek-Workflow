// Ensures the built dsh CLI runtime carries the pieces its compiled
// profile-boot resolves relative to its emitted location (apps/cli/lib/types/):
//   - lib/package.json        <- INSTALL_ANCHOR (`../package.json`)
//   - lib/config/agent-presets <- SHIPPED_PRESET_ROOT (`../config/agent-presets/`)
// The harness's own surfaces run the boot from source (src/), where those
// relative paths resolve to apps/cli/package.json and apps/cli/config/, so the
// canonical build never creates the built-layout copies; the desktop is the
// only consumer of the built profile-boot, so its build recreates them after
// any clean.
//
// Runs from the desktop folder (deepseek-desktop or Deepseek-Workflow), which
// sits one level inside the harness checkout.
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url))
const cliDir = join(harnessRoot, 'apps/cli')
const cliManifest = join(cliDir, 'package.json')
const cliConfig = join(cliDir, 'config')
const libDir = join(cliDir, 'lib')

if (!existsSync(cliManifest)) {
  console.error(`ensure-cli-runtime: harness apps/cli manifest not found at ${cliManifest}`)
  process.exit(1)
}
mkdirSync(libDir, { recursive: true })
copyFileSync(cliManifest, join(libDir, 'package.json'))
console.log(`ensure-cli-runtime: ${join(libDir, 'package.json')}`)
if (existsSync(cliConfig)) {
  cpSync(cliConfig, join(libDir, 'config'), { recursive: true })
  console.log(`ensure-cli-runtime: ${join(libDir, 'config')}`)
}
