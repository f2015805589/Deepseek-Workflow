/**
 * DeepSeek Desktop main process: boots the web profile host in-process
 * through the shared `runProfile` boot (the same composed tree `dsh web`
 * mounts), then renders the resulting loopback URL in an Electron window.
 * Window teardown disposes the host tree before the app quits, so session
 * persistence and plugin disposal run exactly as on the CLI surface.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { healProfilesModuleFallback, initProfile, loadLayeredEnv, PROFILE_TEMPLATES, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
// Activates the webServer Context merge: ctx.get('webServer') below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  DESKTOP_PROFILE, desktopOverlayPath, desktopPreloadPath, desktopUrl, desktopWindowOptions,
  isBackgroundColor,
} from './desktop.ts'
import {
  DESKTOP_BUILTIN_PLUGINS, desktopPluginsDir, desktopPluginsState, importPluginFolder,
  prepareDesktopPlugins, removePluginFolder, setPluginEnabled,
} from './plugins.ts'

/**
 * Lifecycle trace for support diagnosis, written synchronously to the file
 * named by DSH_DESKTOP_DIAG (an Electron window often has no console at all).
 * A failing trace must never break the app it is tracing.
 */
function diag(message: string): void {
  const target = process.env.DSH_DESKTOP_DIAG
  if (target === undefined) return
  try {
    appendFileSync(target, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Last-resort logging: swallow.
  }
}
process.on('uncaughtException', (error: unknown) => {
  diag(`uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
})
process.on('unhandledRejection', (reason: unknown) => {
  diag(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})

/** One host-tree disposal per app lifetime; before-quit re-entry lands here. */
let disposed = false
/** The live window, for the single-instance focus handoff. */
let mainWindow: BrowserWindow | undefined

/** Focus the running window when a second launch is refused. */
function focusExistingWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/**
 * Register the renderer-facing custom-plugin bridge. Every payload crosses
 * the IPC boundary, so each handler validates its argument shapes before any
 * filesystem work; mutations persist to the desktop-owned registry and take
 * effect on the next launch (the running tree is boot-time composed).
 * @param options - the plugins root and the loader capability fact.
 */
function registerPluginBridge(options: { pluginsDir: string; customPluginsLoadable: boolean }): void {
  const { pluginsDir, customPluginsLoadable } = options
  ipcMain.handle('dsh-desktop:plugins:list', () => ({
    ...desktopPluginsState(pluginsDir),
    builtIn: DESKTOP_BUILTIN_PLUGINS,
    customPluginsLoadable,
  }))
  ipcMain.handle('dsh-desktop:plugins:set-enabled', (_event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || name.length === 0 || typeof enabled !== 'boolean') {
      throw new Error('dsh desktop: invalid set-enabled payload')
    }
    setPluginEnabled(name, enabled, pluginsDir)
  })
  ipcMain.handle('dsh-desktop:plugins:import', (_event, sourceDir: unknown) => {
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
      throw new Error('dsh desktop: invalid import payload')
    }
    return importPluginFolder(sourceDir, pluginsDir)
  })
  ipcMain.handle('dsh-desktop:plugins:remove', (_event, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('dsh desktop: invalid remove payload')
    }
    removePluginFolder(name, pluginsDir)
  })
}

/**
 * Boot the host and open the window. A failed boot leaves the console with
 * the loud diagnostic and exits nonzero: no window without a host.
 */
async function openDesktopWindow(): Promise<void> {
  diag('openDesktopWindow: booting host')
  // Custom plugins live under the desktop's own folder (or the override),
  // never inside the dsh installation: replacing dsh loses nothing, and the
  // profile links plus the generated overlay are rebuilt from the registry
  // on every launch.
  const pluginsDir = process.env.DSH_DESKTOP_PLUGINS_DIR ?? desktopPluginsDir(app.getAppPath())
  const profileDir = resolveProfileDir(DESKTOP_PROFILE)
  const webBundles = PROFILE_TEMPLATES.web
  if (webBundles === undefined) throw new Error('dsh desktop: web profile template missing')
  initProfile(profileDir, webBundles)
  // Heal the profile module fallback from the DESKTOP's dependency closure
  // (not dsh's): the overlay and any desktop-resolved rows must keep working
  // even against a bare dsh installation that does not ship the same closure.
  healProfilesModuleFallback(fileURLToPath(new URL('../package.json', import.meta.url)))
  diag(`openDesktopWindow: profile ${profileDir} ready`)
  const customPluginsPatch = prepareDesktopPlugins({ pluginsDir, profileDir })
  diag(`openDesktopWindow: plugins dir ${pluginsDir}, custom patch ${customPluginsPatch ?? '(none)'}`)
  const { ctx, shutdown } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: DESKTOP_PROFILE,
    patchFiles: customPluginsPatch === undefined
      ? [desktopOverlayPath()]
      : [desktopOverlayPath(), customPluginsPatch],
    args: [],
  })
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('dsh desktop: webServer service missing after profile boot')
  diag(`openDesktopWindow: host booted on port ${port}`)
  // Bare-name resolution for out-of-tree plugins needs the Node internal
  // loader (node-addon-require-builtin); report its availability so the
  // manager UI can explain why custom plugins cannot mount on this runtime.
  const loader = (ctx as unknown as { get(name: string): unknown }).get('loader') as { internal?: unknown } | undefined
  const customPluginsLoadable = loader?.internal !== undefined
  diag(`openDesktopWindow: internal loader ${customPluginsLoadable ? 'available' : 'UNAVAILABLE'}`)
  registerPluginBridge({ pluginsDir, customPluginsLoadable })
  const win = new BrowserWindow(desktopWindowOptions(desktopPreloadPath()))
  mainWindow = win
  // The page owns its chrome: no native menu bar above the GUI.
  Menu.setApplicationMenu(null)
  // The sandboxed preload reports the page's computed theme background, so
  // pre-paint and resize edges follow the dsh appearance configuration.
  ipcMain.on('dsh-desktop:background', (_event, color: unknown) => {
    if (isBackgroundColor(color)) win.setBackgroundColor(color)
  })
  // Readiness line: the desktop replaces the web URL print, and supervisors
  // (including the desktop's own smoke checks) can watch for it.
  console.log(`dsh desktop: rendering ${desktopUrl(port)}`)
  // Renderer diagnostics on the main console: a desktop shell must surface
  // page failures and renderer console noise instead of a silent window.
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`dsh desktop: page load failed (${code} ${description}): ${url}`)
    diag(`did-fail-load: ${code} ${description} ${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`dsh desktop: renderer process gone: ${details.reason}`)
    diag(`render-process-gone: ${details.reason}`)
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`dsh desktop [renderer:${String(level)}] ${message} (${sourceId}:${String(line)})`)
  })
  win.webContents.on('did-finish-load', () => {
    console.log(`dsh desktop: page finished loading ${win.webContents.getURL()}`)
    diag(`did-finish-load: ${win.webContents.getURL()}`)
  })
  win.on('close', () => { diag('window: close') })
  win.on('closed', () => { diag('window: closed') })
  win.once('ready-to-show', () => {
    diag('window: ready-to-show')
    win.show()
  })
  void win.loadURL(desktopUrl(port))
  diag('window: loadURL dispatched')
  app.on('before-quit', (event) => {
    // Defer the first quit until the host tree has disposed: session
    // persistence and plugin teardown must complete before the process
    // leaves. The re-entry after disposal must NOT be prevented — an
    // unconditional preventDefault here would block every quit forever and
    // leave a window-less zombie holding the single-instance lock.
    if (disposed) return
    event.preventDefault()
    disposed = true
    console.log('dsh desktop: disposing host tree before quit')
    diag('before-quit: disposing host tree')
    void shutdown.shutdown(0).finally(() => {
      console.log('dsh desktop: host tree disposed')
      diag('before-quit: host tree disposed, quitting')
      app.quit()
    })
  })
}

const lock = app.requestSingleInstanceLock()
if (!lock) {
  // A desktop session already owns the profile's data; the second launch
  // only surfaces the running window, then exits deterministically
  // (app.exit skips the quit-deferral lifecycle this instance never set up).
  app.exit(0)
} else {
  app.on('second-instance', focusExistingWindow)
  void app.whenReady().then(() => {
    void openDesktopWindow().catch((error: unknown) => {
      console.error('dsh desktop: boot failed:', error)
      app.exit(1)
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
