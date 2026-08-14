/**
 * Desktop-owned custom plugin registry: the durable `plugins/` folder under
 * the desktop app path, its `plugins.json` enablement registry, per-boot
 * junction linking into the web profile's `node_modules`, and the generated
 * patch overlay the desktop main passes to `runProfile`.
 *
 * Separation contract: everything durable lives under the desktop's own
 * folder (or the `DSH_DESKTOP_PLUGINS_DIR` override), never inside the dsh
 * installation — replacing dsh loses nothing. The profile junctions and the
 * generated patch are disposable per-boot artifacts rebuilt from the registry.
 *
 * Electron-free so the unit lane covers it without the Electron binary
 * (the `src/desktop.ts` posture); `main.ts` wires it into the boot and the
 * IPC bridge.
 * @module @deepseek-ai/dsh-desktop/plugins
 */

import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** The durable custom-plugin root under the desktop app path. */
export const DESKTOP_PLUGINS_DIR_NAME = 'plugins'

/** Enablement registry filename inside the plugins folder (user-local state). */
export const PLUGINS_REGISTRY_FILENAME = 'plugins.json'

/** Regenerated-at-boot overlay filename inside the plugins folder (user-local state). */
export const GENERATED_PATCH_FILENAME = 'desktop-plugins.generated.patch.yml'

/**
 * Desktop-reserved product rows. These were the desktop's shipped built-in
 * plugins in earlier revisions; their sources are lost and the desktop shell
 * no longer ships or heals them (see config/desktop.patch.yml). The names
 * stay reserved so a custom import cannot shadow them.
 */
export const DESKTOP_BUILTIN_PLUGINS: readonly { id: string; name: string }[] = [
  { id: 'ui-compaction-setting', name: '@deepseek-ai/dsh-client-ui-compaction-setting' },
  { id: 'ui-conversation-edit', name: '@deepseek-ai/dsh-client-ui-conversation-edit' },
  { id: 'fs-revert', name: '@deepseek-ai/dsh-fs-revert' },
]

/** One enablement record in the registry, keyed by the plugin's package name. */
export interface DesktopPluginRecord {
  enabled: boolean
}

/** The persisted enablement registry. */
export interface DesktopPluginsRegistry {
  plugins: Record<string, DesktopPluginRecord>
}

/** One discovered plugin folder under the plugins root. */
export interface InstalledDesktopPlugin {
  /** The package name — the loader specifier and the registry key. */
  name: string
  /** Folder basename under the plugins root. */
  folder: string
  /** package.json version, when declared. */
  version?: string
  /** package.json description, when declared. */
  description?: string
}

/** One patch row generated for an enabled custom plugin. */
export interface GeneratedPluginRow {
  id: string
  name: string
}

/**
 * Resolve the durable custom-plugin root for one desktop app path.
 * @param appPath - `app.getAppPath()` (the desktop package root).
 * @returns the plugins folder path.
 */
export function desktopPluginsDir(appPath: string): string {
  return join(appPath, DESKTOP_PLUGINS_DIR_NAME)
}

/**
 * Read the enablement registry. A missing file is an empty registry; a
 * malformed file fails loud so a hand edit never silently loses plugins.
 * @param dir - the plugins root.
 * @returns the parsed registry.
 * @throws on malformed JSON or shape.
 */
export function readPluginsRegistry(dir: string): DesktopPluginsRegistry {
  const path = join(dir, PLUGINS_REGISTRY_FILENAME)
  if (!existsSync(path)) return { plugins: {} }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`desktop plugins: failed to read ${path}: ${String(error)}`)
  }
  let parsed: DesktopPluginsRegistry | null
  try {
    parsed = JSON.parse(raw) as DesktopPluginsRegistry | null
  } catch (error) {
    throw new Error(`desktop plugins: registry ${path} is not valid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.plugins === undefined) {
    throw new Error(`desktop plugins: registry ${path} must hold { "plugins": { "<name>": { "enabled": boolean } } }`)
  }
  for (const [name, record] of Object.entries(parsed.plugins)) {
    if (name.length === 0 || typeof record.enabled !== 'boolean') {
      throw new Error(`desktop plugins: registry ${path} entry "${name}" must be { "enabled": boolean }`)
    }
  }
  return parsed
}

/**
 * Persist the enablement registry (2-space JSON, trailing newline).
 * @param dir - the plugins root.
 * @param registry - the registry to persist.
 */
export function writePluginsRegistry(dir: string, registry: DesktopPluginsRegistry): void {
  writeFileSync(join(dir, PLUGINS_REGISTRY_FILENAME), JSON.stringify(registry, undefined, 2) + '\n')
}

/**
 * Discover plugin folders under the plugins root: one entry per directory
 * holding a parseable `package.json` with a non-empty `name`. The registry
 * and generated patch live in this directory as files, never folders.
 * @param dir - the plugins root.
 * @returns the discovered plugins, sorted by package name.
 */
export function scanInstalledPlugins(dir: string): InstalledDesktopPlugin[] {
  if (!existsSync(dir)) return []
  const plugins: InstalledDesktopPlugin[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest: { name?: unknown; version?: unknown; description?: unknown }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    } catch {
      // A broken manifest is not a plugin folder; the import path's loud
      // diagnostics cover writing one, and a hand-edited folder is skipped.
      continue
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue
    plugins.push({
      name: manifest.name,
      folder: entry.name,
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
    })
  }
  return plugins.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Generate the patch rows for the enabled custom plugins, in install order.
 * @param registry - the enablement registry.
 * @param installed - the discovered plugin folders.
 * @returns the generated rows.
 */
export function composePluginRows(
  registry: DesktopPluginsRegistry,
  installed: readonly InstalledDesktopPlugin[],
): GeneratedPluginRow[] {
  const rows: GeneratedPluginRow[] = []
  for (const plugin of installed) {
    if (registry.plugins[plugin.name]?.enabled !== true) continue
    rows.push({ id: plugin.name, name: plugin.name })
  }
  return rows
}

/**
 * Serialize the generated overlay to the patch-file shape the loader parses
 * (the same top-level-array dialect as every cordis patch): one insert block
 * with single-quoted id/name scalars so scoped package names parse safely.
 * @param rows - the generated rows.
 * @returns the YAML document text.
 */
export function serializePluginPatch(rows: readonly GeneratedPluginRow[]): string {
  if (rows.length === 0) {
    return '# Generated by DeepSeek Desktop from plugins/plugins.json — no enabled custom plugins.\n[]\n'
  }
  const lines = [
    '# Generated by DeepSeek Desktop from plugins/plugins.json on every launch — do not edit.',
    '# Enable or disable plugins from the desktop plugin manager instead; changes apply after restart.',
    '- insert:',
  ]
  for (const row of rows) {
    lines.push(`    - id: '${row.id}'`, `      name: '${row.name}'`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Resolve the absolute plugin folder for one installed plugin.
 * @param pluginsDir - the plugins root.
 * @param plugin - the installed plugin.
 * @returns the absolute folder path.
 */
export function pluginFolderPath(pluginsDir: string, plugin: InstalledDesktopPlugin): string {
  return join(pluginsDir, plugin.folder)
}

/**
 * Link one installed plugin into a profile's `node_modules` so the Loader
 * and the client-modules registry resolve its bare package name from the
 * profile's baseUrl. A real directory at the target (pnpm-managed) is left
 * untouched — it wins for resolution — and a stale or wrong link is replaced.
 * @param profileDir - the profile directory whose `node_modules` receives the link.
 * @param pluginName - the package name the loader resolves.
 * @param pluginFolder - the absolute plugin folder to link.
 * @returns whether the link now points at the plugin folder.
 */
export function linkPluginIntoProfile(profileDir: string, pluginName: string, pluginFolder: string): boolean {
  const modulesDir = join(profileDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const link = join(modulesDir, pluginName)
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) return false
    try {
      if (readlinkSync(link) === pluginFolder) return true
      unlinkSync(link)
    } catch {
      return false
    }
  }
  try {
    symlinkSync(pluginFolder, link, 'junction')
    return true
  } catch {
    // Concurrent launches heal the same link; losing the race to a process
    // writing the identical link is success, anything else is not.
    try {
      return lstatSync(link).isSymbolicLink() && readlinkSync(link) === pluginFolder
    } catch {
      return false
    }
  }
}

/**
 * Boot-time preparation: read the registry, link every enabled plugin into
 * the profile's node_modules, and write the generated overlay. Returns the
 * overlay path when at least one plugin is enabled, undefined otherwise.
 * @param options - plugins root and the profile directory.
 * @returns the generated patch path, or undefined for no enabled plugins.
 */
export function prepareDesktopPlugins(
  options: { pluginsDir: string; profileDir: string },
): string | undefined {
  const { pluginsDir, profileDir } = options
  mkdirSync(pluginsDir, { recursive: true })
  const registry = readPluginsRegistry(pluginsDir)
  const installed = scanInstalledPlugins(pluginsDir)
  for (const plugin of installed) {
    if (registry.plugins[plugin.name]?.enabled !== true) continue
    linkPluginIntoProfile(profileDir, plugin.name, pluginFolderPath(pluginsDir, plugin))
  }
  const rows = composePluginRows(registry, installed)
  const patchPath = join(pluginsDir, GENERATED_PATCH_FILENAME)
  writeFileSync(patchPath, serializePluginPatch(rows))
  if (rows.length === 0) return undefined
  return patchPath
}

/**
 * Set one installed plugin's enablement and persist the registry.
 * @param name - the plugin's package name.
 * @param enabled - the new enablement.
 * @param pluginsDir - the plugins root.
 * @throws when the plugin folder is not installed.
 */
export function setPluginEnabled(name: string, enabled: boolean, pluginsDir: string): void {
  const registry = readPluginsRegistry(pluginsDir)
  const installed = scanInstalledPlugins(pluginsDir).some(plugin => plugin.name === name)
  if (!installed) throw new Error(`desktop plugins: "${name}" is not installed under ${pluginsDir}`)
  registry.plugins[name] = { enabled }
  writePluginsRegistry(pluginsDir, registry)
}

/**
 * Import a plugin folder (a directory holding a package.json) into the
 * plugins root under the package name, enable it, and return the record.
 * @param sourceDir - the folder to copy (validated for a package.json name).
 * @param pluginsDir - the plugins root.
 * @returns the installed plugin.
 * @throws when the source is not a plugin package or the target exists.
 */
export function importPluginFolder(sourceDir: string, pluginsDir: string): InstalledDesktopPlugin {
  const manifestPath = join(sourceDir, 'package.json')
  let manifest: { name?: unknown; version?: unknown; description?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch (error) {
    throw new Error(`desktop plugins: "${sourceDir}" is not a plugin package (missing or unreadable package.json): ${String(error)}`)
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`desktop plugins: "${sourceDir}" package.json must declare a non-empty "name"`)
  }
  if (DESKTOP_BUILTIN_PLUGINS.some(row => row.name === manifest.name)) {
    throw new Error(`desktop plugins: "${manifest.name}" is a shipped built-in and cannot be imported as a custom plugin`)
  }
  const target = join(pluginsDir, manifest.name)
  if (existsSync(target)) {
    throw new Error(`desktop plugins: "${manifest.name}" is already installed under ${pluginsDir}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  cpSync(sourceDir, target, { recursive: true })
  const plugin: InstalledDesktopPlugin = {
    name: manifest.name,
    folder: manifest.name,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
  }
  const registry = readPluginsRegistry(pluginsDir)
  registry.plugins[plugin.name] = { enabled: true }
  writePluginsRegistry(pluginsDir, registry)
  return plugin
}

/**
 * Remove an installed plugin folder and its registry entry.
 * @param name - the plugin's package name.
 * @param pluginsDir - the plugins root.
 * @throws when the plugin folder is not installed.
 */
export function removePluginFolder(name: string, pluginsDir: string): void {
  const plugin = scanInstalledPlugins(pluginsDir).find(candidate => candidate.name === name)
  if (plugin === undefined) {
    throw new Error(`desktop plugins: "${name}" is not installed under ${pluginsDir}`)
  }
  rmSync(pluginFolderPath(pluginsDir, plugin), { recursive: true, force: true })
  const registry = readPluginsRegistry(pluginsDir)
  delete registry.plugins[name]
  writePluginsRegistry(pluginsDir, registry)
}

/**
 * Report the current custom-plugin state for the manager UI.
 * @param pluginsDir - the plugins root.
 * @returns installed plugins with their registry enablement and the root path.
 */
export function desktopPluginsState(pluginsDir: string): {
  pluginsDir: string
  plugins: Array<InstalledDesktopPlugin & DesktopPluginRecord>
} {
  const registry = readPluginsRegistry(pluginsDir)
  return {
    pluginsDir,
    plugins: scanInstalledPlugins(pluginsDir).map(plugin => ({
      ...plugin,
      enabled: registry.plugins[plugin.name]?.enabled ?? false,
    })),
  }
}
