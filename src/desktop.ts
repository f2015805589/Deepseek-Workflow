/**
 * Electron-free desktop surface facts: the overlay patch location, the
 * sandboxed preload path, the window options, and the rendered URL. Keeping
 * this module free of `electron` imports lets the unit lane cover it without
 * the Electron binary; `main.ts` is the only module that touches the API.
 * @module @deepseek-ai/dsh-desktop
 */

import { fileURLToPath } from 'node:url'

/** The profile the desktop surface boots, shared with the `dsh web` alias. */
export const DESKTOP_PROFILE = 'web'

/** Loopback literal the overlay pins the webserver to (see config/desktop.patch.yml). */
const DESKTOP_LOOPBACK_HOST = '127.0.0.1'

/**
 * Absolute path of the desktop overlay patch, applied last over the web
 * profile so the window-owned surface overrides the browser defaults.
 * @returns the patch file path.
 */
export function desktopOverlayPath(): string {
  return fileURLToPath(new URL('../config/desktop.patch.yml', import.meta.url))
}

/**
 * Absolute path of the built sandboxed preload script (copied to lib/ beside
 * the bundled main entry by scripts/copy-preload.mjs).
 * @returns the preload file path.
 */
export function desktopPreloadPath(): string {
  return fileURLToPath(new URL('../lib/preload.cjs', import.meta.url))
}

/** Shape the renderer may report for a computed CSS background color. */
const BACKGROUND_COLOR_PATTERN = /^(?:#[\da-f]{3,8}|rgba?\([^)]*\))$/i

/**
 * Validate a renderer-reported background color before it reaches
 * `BrowserWindow.setBackgroundColor`: the value crosses the IPC boundary, so
 * the shape is checked instead of trusted.
 * @param value - the untrusted IPC payload.
 * @returns whether the value is a hex or rgb()/rgba() color string.
 */
export function isBackgroundColor(value: unknown): value is string {
  return typeof value === 'string' && BACKGROUND_COLOR_PATTERN.test(value)
}

/**
 * The loopback URL the window renders once the embedded host has bound.
 * @param port - the bound port of the host webserver.
 * @returns the http URL.
 */
export function desktopUrl(port: number): string {
  return `http://${DESKTOP_LOOPBACK_HOST}:${String(port)}`
}

/** The BrowserWindow construction options for the desktop surface. */
export interface DesktopWindowOptions {
  width: number
  height: number
  show: boolean
  backgroundColor: string
  webPreferences: {
    preload: string
    contextIsolation: boolean
    sandbox: boolean
    nodeIntegration: boolean
  }
}

/**
 * Window options for the desktop surface: hidden until the page has rendered
 * (`ready-to-show`), no menu bar (the page owns its chrome), a fallback
 * backdrop in the dark theme's base color (the preload replaces it with the
 * page's computed theme background), and the hardened renderer defaults with
 * the sandboxed preload attached.
 * @param preload - absolute path of the sandboxed preload script.
 * @returns the options object.
 */
export function desktopWindowOptions(preload: string): DesktopWindowOptions {
  return {
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#151517',
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  }
}
