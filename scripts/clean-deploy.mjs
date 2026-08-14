// Frees the `deploy` staging name for the next packaging run and cleans the
// previous staging away. The staging tree holds real copies, so deletion
// normally succeeds; when files are still open (an app instance just quit,
// antivirus scanning), the tree is renamed aside in O(1) — Windows renames
// directories with open files — and the stale trees are gitignored for the
// user to remove at leisure.
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = fileURLToPath(new URL('..', import.meta.url))
const root = join(parent, 'deploy')
const STALE_PREFIX = 'deploy-stale-'

if (existsSync(root)) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 })
  } catch {
    // Deletion failed; fall through to the rename.
  }
  if (existsSync(root)) {
    renameSync(root, join(parent, `${STALE_PREFIX}${Date.now()}`))
    console.log('clean-deploy: locked tree renamed aside (remove deploy-stale-* manually)')
  } else {
    console.log('clean-deploy: deploy removed')
  }
} else {
  console.log('clean-deploy: deploy name is free')
}
