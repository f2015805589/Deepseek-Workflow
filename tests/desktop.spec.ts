import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PROFILE, desktopOverlayPath, desktopPreloadPath, desktopUrl, desktopWindowOptions,
  isBackgroundColor,
} from '../src/desktop.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')

/** The composed web-profile rows with the desktop overlay applied last. */
function composedRows() {
  return composeEntries([
    loadOverlayPatches('dsh-test', BASE_PATCH),
    loadOverlayPatches('dsh-test', WEB_PATCH),
    loadOverlayPatches('dsh-test', desktopOverlayPath()),
  ])
}

describe('dsh desktop surface', () => {
  it('rides the shared web profile', () => {
    expect(DESKTOP_PROFILE).toBe('web')
  })

  it('ships the two config rows over the web profile with no product inserts', () => {
    expect(existsSync(desktopOverlayPath())).toBe(true)
    const patches = loadOverlayPatches('dsh-test', desktopOverlayPath())
    expect(patches.slice(0, 2).map(patch => patch.id)).toEqual(['webserver', 'web-runtime'])
    // The desktop shell no longer ships companion plugin rows (their sources
    // were lost); the overlay must not reference any product package.
    const inserted = patches.slice(2).flatMap(patch => (Array.isArray(patch.insert) ? patch.insert : []))
    expect(inserted).toEqual([])
  })

  it('binds an OS-assigned loopback port', () => {
    const webserver = composedRows().find(row => row.id === 'webserver')
    expect(webserver?.config).toMatchObject({ host: '127.0.0.1', port: 0 })
  })

  it('keeps the surface context but silences the URL line', () => {
    const webRuntime = composedRows().find(row => row.id === 'web-runtime')
    expect(webRuntime?.config).toMatchObject({ printUrl: false, surfaceContext: true })
  })

  it('renders the loopback URL of the bound port', () => {
    expect(desktopUrl(5199)).toBe('http://127.0.0.1:5199')
  })

  it('points the window at the built sandboxed preload', () => {
    expect(desktopPreloadPath().replaceAll('\\', '/')).toMatch(/\/deepseek-desktop\/lib\/preload\.cjs$/)
  })

  it('constructs hardened window options', () => {
    const options = desktopWindowOptions('C:\\preload.cjs')
    expect(options.width).toBeGreaterThan(0)
    expect(options.height).toBeGreaterThan(0)
    expect(options.show).toBe(false)
    expect(options.backgroundColor).toBe('#151517')
    expect(options.webPreferences).toEqual({
      preload: 'C:\\preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    })
  })

  it('accepts only computed-style color shapes for the window backdrop', () => {
    expect(isBackgroundColor('rgb(21, 21, 23)')).toBe(true)
    expect(isBackgroundColor('rgba(255, 255, 255, 0.7)')).toBe(true)
    expect(isBackgroundColor('#151517')).toBe(true)
    expect(isBackgroundColor('#fff')).toBe(true)
    expect(isBackgroundColor('')).toBe(false)
    expect(isBackgroundColor('red')).toBe(false)
    expect(isBackgroundColor('url(javascript:alert(1))')).toBe(false)
    expect(isBackgroundColor(42)).toBe(false)
    expect(isBackgroundColor(undefined)).toBe(false)
  })
})
