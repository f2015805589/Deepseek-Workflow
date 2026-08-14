import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import {
  composePluginRows,
  DESKTOP_BUILTIN_PLUGINS,
  desktopPluginsDir,
  desktopPluginsState,
  GENERATED_PATCH_FILENAME,
  importPluginFolder,
  linkPluginIntoProfile,
  PLUGINS_REGISTRY_FILENAME,
  prepareDesktopPlugins,
  readPluginsRegistry,
  removePluginFolder,
  scanInstalledPlugins,
  serializePluginPatch,
  setPluginEnabled,
  writePluginsRegistry,
} from '../src/plugins.ts'

/** One throwaway temp directory per test, cleaned by the OS tmp policy. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-plugins-'))
}

/** Scaffold a plugin package folder and return its manifest name. */
function writePlugin(dir: string, name: string, extra: Record<string, unknown> = {}): string {
  const folder = join(dir, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, ...extra }))
  return folder
}

describe('desktop custom plugin registry', () => {
  it('anchors the plugins folder under the desktop app path', () => {
    expect(desktopPluginsDir('C:\\deepseek-desktop')).toBe('C:\\deepseek-desktop\\plugins')
  })

  it('reads an absent registry as empty and round-trips writes', () => {
    const dir = tempRoot()
    expect(readPluginsRegistry(dir)).toEqual({ plugins: {} })
    writePluginsRegistry(dir, { plugins: { 'my-plugin': { enabled: true } } })
    expect(readPluginsRegistry(dir)).toEqual({ plugins: { 'my-plugin': { enabled: true } } })
    expect(readFileSync(join(dir, PLUGINS_REGISTRY_FILENAME), 'utf8').endsWith('\n')).toBe(true)
  })

  it('fails loud on a malformed registry', () => {
    const dir = tempRoot()
    writeFileSync(join(dir, PLUGINS_REGISTRY_FILENAME), '{ not json')
    expect(() => readPluginsRegistry(dir)).toThrow(/desktop plugins/)
  })

  it('fails loud on an invalid registry shape', () => {
    const dir = tempRoot()
    writeFileSync(join(dir, PLUGINS_REGISTRY_FILENAME), JSON.stringify({ plugins: { 'x': { enabled: 'yes' } } }))
    expect(() => readPluginsRegistry(dir)).toThrow(/must be \{ "enabled": boolean \}/)
  })

  it('scans plugin folders and skips non-packages and broken manifests', () => {
    const dir = tempRoot()
    writePlugin(dir, 'a-plugin', { version: '1.0.0', description: 'desc' })
    writePlugin(dir, 'z-plugin')
    mkdirSync(join(dir, 'no-manifest'), { recursive: true })
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'package.json'), '{ nope')
    mkdirSync(join(dir, 'empty-name'))
    writeFileSync(join(dir, 'empty-name', 'package.json'), JSON.stringify({ name: '' }))
    writeFileSync(join(dir, 'not-a-folder.json'), '{}')
    const scanned = scanInstalledPlugins(dir)
    expect(scanned.map(plugin => plugin.name)).toEqual(['a-plugin', 'z-plugin'])
    expect(scanned[0]).toMatchObject({ folder: 'a-plugin', version: '1.0.0', description: 'desc' })
  })

  it('composes rows only for enabled plugins in install order', () => {
    const registry = { plugins: { 'a-plugin': { enabled: true }, 'b-plugin': { enabled: false } } }
    const installed = [
      { name: 'b-plugin', folder: 'b-plugin' },
      { name: 'a-plugin', folder: 'a-plugin' },
      { name: 'c-plugin', folder: 'c-plugin' },
    ]
    expect(composePluginRows(registry, installed)).toEqual([{ id: 'a-plugin', name: 'a-plugin' }])
  })

  it('serializes the overlay with quoted scalars and an empty-document fallback', () => {
    expect(serializePluginPatch([])).toContain('[]\n')
    const text = serializePluginPatch([{ id: '@scope/name', name: '@scope/name' }])
    expect(text).toContain("- insert:")
    expect(text).toContain("    - id: '@scope/name'")
    expect(text).toContain("      name: '@scope/name'")
  })

  it('links a plugin into the profile node_modules idempotently', () => {
    const root = tempRoot()
    const profileDir = join(root, 'profiles', 'web')
    const pluginDir = join(root, 'plugins', 'my-plugin')
    mkdirSync(pluginDir, { recursive: true })
    expect(linkPluginIntoProfile(profileDir, 'my-plugin', pluginDir)).toBe(true)
    const link = join(profileDir, 'node_modules', 'my-plugin')
    expect(readlinkSync(link)).toBe(pluginDir)
    expect(linkPluginIntoProfile(profileDir, 'my-plugin', pluginDir)).toBe(true)
    expect(readlinkSync(link)).toBe(pluginDir)
  })

  it('leaves a real directory in the profile node_modules untouched', () => {
    const root = tempRoot()
    const profileDir = join(root, 'profiles', 'web')
    const real = join(profileDir, 'node_modules', 'my-plugin')
    mkdirSync(real, { recursive: true })
    expect(linkPluginIntoProfile(profileDir, 'my-plugin', join(root, 'elsewhere'))).toBe(false)
  })

  it('prepareDesktopPlugins links enabled plugins and writes the overlay', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    const profileDir = join(root, 'profiles', 'web')
    writePlugin(pluginsDir, 'on-plugin', { version: '2.0.0' })
    writePlugin(pluginsDir, 'off-plugin')
    writePluginsRegistry(pluginsDir, { plugins: { 'on-plugin': { enabled: true }, 'off-plugin': { enabled: false } } })
    const patchPath = prepareDesktopPlugins({ pluginsDir, profileDir })
    expect(patchPath).toBe(join(pluginsDir, GENERATED_PATCH_FILENAME))
    expect(readFileSync(patchPath!, 'utf8')).toContain("name: 'on-plugin'")
    expect(readlinkSync(join(profileDir, 'node_modules', 'on-plugin'))).toBe(join(pluginsDir, 'on-plugin'))
    expect(join(profileDir, 'node_modules', 'off-plugin')).not.toSatisfy((p: string) => {
      try {
        return readlinkSync(p).length > 0
      } catch {
        return false
      }
    })
  })

  it('prepareDesktopPlugins reports undefined without enabled plugins', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    writePlugin(pluginsDir, 'only-plugin')
    writePluginsRegistry(pluginsDir, { plugins: { 'only-plugin': { enabled: false } } })
    expect(prepareDesktopPlugins({ pluginsDir, profileDir: join(root, 'profiles', 'web') })).toBeUndefined()
  })

  it('imports a plugin folder, enables it, and refuses duplicates', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    const source = writePlugin(root, 'source-folder', { version: '3.0.0' })
    const imported = importPluginFolder(source, pluginsDir)
    expect(imported).toMatchObject({ name: 'source-folder', folder: 'source-folder', version: '3.0.0' })
    expect(readPluginsRegistry(pluginsDir).plugins['source-folder']).toEqual({ enabled: true })
    expect(desktopPluginsState(pluginsDir).plugins).toEqual([
      { name: 'source-folder', folder: 'source-folder', version: '3.0.0', enabled: true },
    ])
    expect(() => importPluginFolder(source, pluginsDir)).toThrow(/already installed/)
  })

  it('rejects importing a non-plugin source', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(() => importPluginFolder(empty, pluginsDir)).toThrow(/not a plugin package/)
  })

  it('rejects importing a plugin that collides with a shipped built-in', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    const source = writePlugin(root, 'builtin-clone')
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-fs-revert' }))
    expect(() => importPluginFolder(source, pluginsDir)).toThrow(/shipped built-in/)
  })

  it('removes a plugin folder and its registry entry', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    writePlugin(pluginsDir, 'gone-plugin')
    writePluginsRegistry(pluginsDir, { plugins: { 'gone-plugin': { enabled: true } } })
    removePluginFolder('gone-plugin', pluginsDir)
    expect(scanInstalledPlugins(pluginsDir)).toEqual([])
    expect(readPluginsRegistry(pluginsDir).plugins).toEqual({})
    expect(() => removePluginFolder('gone-plugin', pluginsDir)).toThrow(/not installed/)
  })

  it('setPluginEnabled persists enablement and rejects unknown names', () => {
    const root = tempRoot()
    const pluginsDir = join(root, 'plugins')
    writePlugin(pluginsDir, 'toggled')
    setPluginEnabled('toggled', true, pluginsDir)
    expect(readPluginsRegistry(pluginsDir).plugins['toggled']).toEqual({ enabled: true })
    setPluginEnabled('toggled', false, pluginsDir)
    expect(readPluginsRegistry(pluginsDir).plugins['toggled']).toEqual({ enabled: false })
    expect(() => setPluginEnabled('missing', true, pluginsDir)).toThrow(/not installed/)
  })

  it('reports the shipped built-in rows for the manager', () => {
    expect(DESKTOP_BUILTIN_PLUGINS.map(row => row.id)).toEqual([
      'ui-compaction-setting', 'ui-conversation-edit', 'fs-revert',
    ])
  })

  it('heals the profile fallback from the desktop closure so built-ins resolve against a bare dsh', () => {
    // The desktop main runs this pass with its own package.json as the
    // anchor, independent of what the installed dsh ships — a bare dsh still
    // resolves every desktop-default row from the healed fallback.
    const home = tempRoot()
    const desktopManifest = fileURLToPath(new URL('../package.json', import.meta.url))
    healProfilesModuleFallback(desktopManifest, home)
    const fallback = join(home, 'profiles', 'node_modules')
    for (const name of DESKTOP_BUILTIN_PLUGINS.map(row => row.name)) {
      const target = readlinkSync(join(fallback, name))
      const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name?: unknown }
      expect(manifest.name).toBe(name)
    }
  })
})
