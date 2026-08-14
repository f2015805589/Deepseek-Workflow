// Builds the electron-builder staging tree in deploy/: the desktop entry
// files plus a flat node_modules holding the production closure of the
// embedded harness as real directories. `pnpm deploy` cannot produce this
// closure (the repository's cordis plugins are peer dependencies that only
// the workspace root resolves), so the staging walks manifests the same way
// healProfilesModuleFallback does — dependencies, peerDependencies, and
// platform optionalDependencies — and copies each resolved package without
// its nested node_modules symlinks (a flat layout resolves the same edges).
//
// Copies run on a bounded pool. Directory payloads runtime never touches are
// skipped, with one exception: a package whose manifest entry points name
// src/ keeps its src (koffi re-exports src without a manifest mention, so it
// is pinned in KEEP_SRC). A hash marker makes repeat runs skip restaging
// when nothing that feeds the tree changed.
import { createHash } from 'node:crypto'
import {
  existsSync, globSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const deployDir = join(desktopDir, 'deploy')
const modulesDir = join(deployDir, 'node_modules')
const MARKER = '.staging-hash'
const COPY_POOL = 8

/** Directory names runtime resolution never enters. */
const SKIP_DIRS = new Set([
  'node_modules', 'tests', 'docs', 'examples',
  '.github', 'coverage', '.storybook', 'benchmarks', 'bench',
])

/** Packages whose root entry re-exports src/ without a manifest mention. */
const KEEP_SRC = new Set(['koffi'])

/** Whether this package's own entry points reference its src directory. */
function manifestKeepsSrc(manifest) {
  if (manifest.exports !== undefined && JSON.stringify(manifest.exports).includes('src')) return true
  for (const key of ['main', 'module', 'browser', 'types']) {
    if (typeof manifest[key] === 'string' && manifest[key].includes('src')) return true
  }
  return false
}

/** Keep runtime payloads: drop maps, type declarations, prose, and prunable src. */
function filterFor(name, keepsSrc) {
  return (source) => {
    const entry = basename(source)
    if (SKIP_DIRS.has(entry)) return false
    if (entry === 'src' && !keepsSrc) return false
    if (entry.endsWith('.map') || entry.endsWith('.tsbuildinfo')) return false
    if (entry.endsWith('.d.ts') || entry.endsWith('.md') || entry.startsWith('CHANGELOG')) return false
    return !lstatSync(source).isSymbolicLink()
  }
}

/**
 * Resolve a package's real directory from one anchor manifest (the same
 * nearest-wins walk healProfilesModuleFallback uses).
 * @param anchor - absolute path of the declaring package's package.json.
 * @param packageName - the dependency name to resolve.
 * @returns the package directory, or undefined when not installed.
 */
function packageDirFromAnchor(anchor, packageName) {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** The closure inputs a restage depends on: manifests, lockfile, built entry files. */
function stagingHash() {
  const hash = createHash('sha1')
  for (const rel of [
    'package.json',
    '../pnpm-lock.yaml',
    '../apps/cli/package.json',
    '../apps/web/package.json',
    '../apps/web/dist/index.html',
    'lib/main.js',
    'lib/preload.cjs',
    'config/desktop.patch.yml',
    'build/icon.ico',
  ]) {
    const path = join(desktopDir, rel)
    hash.update(rel)
    try {
      const stat = lstatSync(path)
      hash.update(`${stat.size}:${stat.mtimeMs}`)
      if (stat.isFile()) hash.update(readFileSync(path))
    } catch {
      hash.update('missing')
    }
  }
  // The staged node_modules copies every package's built lib; a newer build
  // anywhere must invalidate the cache even though the lockfile is unchanged.
  let newest = 0
  for (const pattern of ['../packages/*/*/lib/index.js', '../vendor/*/lib/index.js']) {
    for (const file of globSync(pattern, { cwd: desktopDir, windowsPathsNoEscape: true })) {
      const stat = lstatSync(join(desktopDir, file))
      newest = Math.max(newest, stat.mtimeMs)
    }
  }
  hash.update(`libNewest:${String(newest)}`)
  return hash.digest('hex')
}

/** Whether the existing staging tree is still current. */
function stagingCurrent() {
  try {
    return readFileSync(join(deployDir, MARKER), 'utf8').trim() === stagingHash()
  } catch {
    return false
  }
}

/** Resolve the full closure (manifests only, no copying). */
function resolveClosure() {
  const desktopManifest = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'))
  const rootAnchor = join(desktopDir, 'package.json')
  const queue = []
  const resolved = new Map()
  const enqueue = (anchor, names) => {
    for (const name of Object.keys(names ?? {})) queue.push({ anchor, name })
  }
  enqueue(rootAnchor, desktopManifest.dependencies)
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (resolved.has(next.name)) continue
    const dir = packageDirFromAnchor(next.anchor, next.name)
    if (dir === undefined) continue
    // Resolution from a symlink path misses the .pnpm virtual directory, so
    // both the copy source and the next-level anchor use the real directory.
    const real = realpathSync(dir)
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'))
    resolved.set(next.name, { real, manifest })
    const anchor = join(real, 'package.json')
    enqueue(anchor, manifest.dependencies)
    enqueue(anchor, manifest.peerDependencies)
    // Platform optional dependencies (koffi's win32 binary package, …) ship
    // like ordinary dependencies on this platform.
    enqueue(anchor, manifest.optionalDependencies)
  }
  // Self-check: every dependency/peer the dsh manifest names must resolve,
  // because the profile boot resolves loader rows from that anchor's walk.
  const dshManifest = JSON.parse(readFileSync(join(resolved.get('@deepseek-ai/dsh').real, 'package.json'), 'utf8'))
  const missing = Object.keys({ ...dshManifest.dependencies, ...dshManifest.peerDependencies })
    .filter(name => !resolved.has(name))
  if (missing.length > 0) {
    throw new Error(`build-staging: closure missing ${missing.length} package(s): ${missing.join(', ')}`)
  }
  return resolved
}

/** Copy the resolved closure on a bounded pool. */
async function copyClosure(resolved) {
  const pending = [...resolved.entries()]
  let done = 0
  const worker = async () => {
    for (;;) {
      const next = pending.shift()
      if (next === undefined) return
      const [name, { real, manifest }] = next
      const keepsSrc = KEEP_SRC.has(name) || manifestKeepsSrc(manifest)
      await cp(real, join(modulesDir, name), {
        recursive: true,
        filter: filterFor(name, keepsSrc),
      })
      done += 1
      if (done % 100 === 0) console.log(`build-staging: ${String(done)}/${String(resolved.size)} packages…`)
    }
  }
  await Promise.all(Array.from({ length: COPY_POOL }, () => worker()))
}

/** Copy the desktop entry files (lib, config, icon) and a neutralized manifest. */
async function stageAppFiles(resolved) {
  for (const entry of ['lib', 'config', 'build']) {
    await cp(join(desktopDir, entry), join(deployDir, entry), { recursive: true, filter: filterFor('', false) })
  }
  const manifest = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'))
  // electron-builder cannot resolve workspace:^ ranges, and it prunes
  // node_modules to the staged manifest's dependency graph. Declaring the
  // FULL resolved closure at its concrete versions makes every staged package
  // a direct dependency, so nothing the boot reaches can be pruned.
  manifest.dependencies = Object.fromEntries(
    [...resolved.entries()].map(([name, { manifest: resolvedManifest }]) => [name, resolvedManifest.version]),
  )
  // The output stays beside the source package, not inside the staging tree
  // (electron-builder resolves relative to the project dir, and pnpm's
  // Windows wrapper mangles dotted CLI config flags).
  manifest.build = { ...manifest.build, directories: { ...manifest.build.directories, output: '../dist' } }
  writeFileSync(join(deployDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** Free the deploy name (delete, or rename aside when files are open). */
function freeDeployName() {
  if (!existsSync(deployDir)) return
  try {
    rmSync(deployDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 })
  } catch {
    // Fall through to the rename.
  }
  if (existsSync(deployDir)) {
    renameSync(deployDir, join(desktopDir, `deploy-stale-${Date.now()}`))
    console.log('build-staging: locked staging renamed aside (remove deploy-stale-* manually)')
  }
}

if (stagingCurrent()) {
  console.log('build-staging: staging up to date (delete deploy/ to force a restage)')
  process.exit(0)
}
freeDeployName()
const resolved = resolveClosure()
await stageAppFiles(resolved)
await copyClosure(resolved)
writeFileSync(join(deployDir, MARKER), stagingHash())
console.log(`build-staging: ${String(resolved.size)} packages staged`)
