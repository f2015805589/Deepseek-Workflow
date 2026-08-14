import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// Activates the webServer Context merge read below. The client-modules merge
// stays out: its source lives in the client aggregate, so the graph read is
// narrowed with a local type instead.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Activates the fsRevert Context merge for the overlay assertion.
import type {} from '@deepseek-ai/dsh-fs-revert'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { desktopOverlayPath, desktopUrl } from '../src/desktop.ts'
import { prepareDesktopPlugins, writePluginsRegistry } from '../src/plugins.ts'

/**
 * Keyless desktop host assembly: boots the real web profile with the desktop
 * overlay exactly as the Electron main process does, then drives the same
 * loopback URL the window renders. The frontend dist and the built profile
 * boot are artifacts of `pnpm run build`, so this file rides the web lane.
 */
describe('dsh desktop host', () => {
  let home: string
  let pluginsDir: string
  let port: number
  let booted: Awaited<ReturnType<typeof runProfile>>
  let logged: string[]

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
    pluginsDir = join(home, 'desktop', 'plugins')
    process.env.DSH_HOME = home
    // The desktop surface owns its readiness line; the host must not print
    // the browser URL line, and telemetry must not reach the network.
    process.env.DSH_TELEMETRY_DISABLED = '1'
    // A fixture custom plugin under the desktop-owned plugins folder: a
    // dual-face package the manager would import, enabled in the registry.
    const fixture = join(pluginsDir, 'fixture-desktop-plugin')
    mkdirSync(join(fixture, 'lib'), { recursive: true })
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'fixture-desktop-plugin',
      version: '1.0.0',
      type: 'module',
      main: './lib/index.js',
      exports: {
        '.': './lib/index.js',
        './client': './lib/client.js',
        // The client roster resolves `${name}/package.json`, so a client
        // plugin's exports map must declare this subpath (same contract as
        // every shipped dsh package).
        './package.json': './package.json',
      },
      dsh: { client: { platform: 'web' } },
    }))
    writeFileSync(join(fixture, 'lib', 'index.js'), "export const apply = () => {}\n")
    writeFileSync(join(fixture, 'lib', 'client.js'), "// fixture client bundle\n")
    writePluginsRegistry(pluginsDir, { plugins: { 'fixture-desktop-plugin': { enabled: true } } })
    const customPatch = prepareDesktopPlugins({ pluginsDir, profileDir: join(home, 'profiles', 'web') })
    if (customPatch === undefined) throw new Error('fixture custom plugin did not generate an overlay')
    logged = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      booted = await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: 'web',
        patchFiles: [desktopOverlayPath(), customPatch],
        args: [],
      })
    } finally {
      logSpy.mockRestore()
    }
    const webServer = booted.ctx.get('webServer')
    if (webServer === undefined) throw new Error('webServer service missing after profile boot')
    port = webServer.port
  }, 180_000)

  afterAll(async () => {
    await booted.shutdown.shutdown(0)
    await rm(home, { recursive: true, force: true })
  })

  it('binds an OS-assigned loopback port without printing the web URL line', () => {
    expect(port).toBeGreaterThan(0)
    expect(logged.some(line => line.includes('dsh web:'))).toBe(false)
  })

  it('registers the desktop-default compaction namespace through the overlay', () => {
    const settings = booted.ctx.get('settings')
    expect(settings?.get(settingsNamespace('compaction'))).toEqual({ thresholdRatio: 0.8 })
  })

  it('mounts the desktop-default revert journal through the overlay', () => {
    expect(booted.ctx.get('fsRevert')).toBeDefined()
  })

  it('serves the boot-manifest index at the desktop URL', async () => {
    const response = await fetch(desktopUrl(port))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('window.__DSH_BOOT__')
  })

  it('serves a client plugin bundle', async () => {
    const modules = booted.ctx.get('clientModules') as { graph(): { entries: Array<{ id: string; url: string }> } } | undefined
    const entries = modules?.graph().entries ?? []
    expect(entries.length).toBeGreaterThan(0)
    const first = entries[0]
    if (first === undefined) throw new Error('empty plugin graph')
    const response = await fetch(`${desktopUrl(port)}${first.url}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
  })

  it('composes the desktop-default conversation-edit client plugin into the roster', async () => {
    // The roster keys entries by package name, not by the row id.
    const modules = booted.ctx.get('clientModules') as { graph(): { entries: Array<{ id: string; url: string }> } } | undefined
    const entry = modules?.graph().entries.find(candidate => candidate.id === '@deepseek-ai/dsh-client-ui-conversation-edit')
    expect(entry).toBeDefined()
    const response = await fetch(`${desktopUrl(port)}${entry!.url}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
  })

  it('mounts a custom plugin from the desktop plugins folder into the client roster', async () => {
    const modules = booted.ctx.get('clientModules') as { graph(): { entries: Array<{ id: string; url: string }> } } | undefined
    const entry = modules?.graph().entries.find(candidate => candidate.id === 'fixture-desktop-plugin')
    expect(entry).toBeDefined()
    const response = await fetch(`${desktopUrl(port)}${entry!.url}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('fixture client bundle')
  })

  it('answers the /api bridge and guards the downlink upgrades', async () => {
    const list = await fetch(`${desktopUrl(port)}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'session.list',
        payload: {},
      }),
    })
    expect(list.status).toBe(200)
    const envelope = await list.json() as { result?: { ok?: unknown } }
    expect(envelope.result?.ok).toBe(true)

    const upgrade = await fetch(`${desktopUrl(port)}/api/events.mux`)
    expect(upgrade.status).toBe(426)
  })
})
