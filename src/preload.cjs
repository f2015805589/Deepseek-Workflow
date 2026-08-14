// DeepSeek Desktop preload: the renderer extension seam. Sandboxed preloads
// are CommonJS and may only touch the bridge, so this file stays
// dependency-free and is copied to lib/ verbatim (never bundled). Desktop
// native capabilities land here as frozen, serializable values behind
// `dshDesktop`; renderer code reads the seam before offering desktop behavior.
//
// It also syncs the window backdrop with the page's computed theme background:
// the body paints --dsw-alias-bg-base (light, dark, or a third-party theme),
// and the main process applies each report through setBackgroundColor, so
// pre-paint and resize edges follow the dsh appearance configuration.
const { contextBridge, ipcRenderer } = require('electron')

function reportBackground() {
  // Runs from document-start: body may not exist on the first attempt.
  if (document.body === null) return
  try {
    const color = getComputedStyle(document.body).backgroundColor
    if (color !== '' && color !== 'rgba(0, 0, 0, 0)') {
      ipcRenderer.send('dsh-desktop:background', color)
    }
  } catch {
    // A style read must never break the extension seam.
  }
}

function watchBackground() {
  reportBackground()
  // The theme presenter flips body[data-ds-dark-theme] and inline token
  // variables in place; the computed background moves with them.
  new MutationObserver(reportBackground).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-ds-dark-theme', 'style'],
  })
}

window.addEventListener('DOMContentLoaded', watchBackground)
window.addEventListener('load', reportBackground)

// Custom-plugin management bridge: every call is an ipcRenderer.invoke into
// the main process, which owns the desktop plugins folder and registry.
// Mutations persist immediately and apply on the next launch.
const pluginsBridge = Object.freeze({
  list: () => ipcRenderer.invoke('dsh-desktop:plugins:list'),
  setEnabled: (name, enabled) => ipcRenderer.invoke('dsh-desktop:plugins:set-enabled', name, enabled),
  import: (sourceDir) => ipcRenderer.invoke('dsh-desktop:plugins:import', sourceDir),
  remove: (name) => ipcRenderer.invoke('dsh-desktop:plugins:remove', name),
  // Native folder picker; resolves the chosen absolute path (undefined when cancelled).
  pickDirectory: () => ipcRenderer.invoke('dsh-desktop:plugins:pick-directory'),
})

// Compaction-threshold settings bridge: the `compaction` namespace is
// desktop-owned and not part of the web configuration boundary, so these
// round-trip through the main process to the host settings service.
const settingsBridge = Object.freeze({
  getCompactionThreshold: () => ipcRenderer.invoke('dsh-desktop:settings:compaction-threshold'),
  setCompactionThreshold: (ratio) => ipcRenderer.invoke('dsh-desktop:settings:compaction-threshold-set', ratio),
})

contextBridge.exposeInMainWorld('dshDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  plugins: pluginsBridge,
  settings: settingsBridge,
}))
