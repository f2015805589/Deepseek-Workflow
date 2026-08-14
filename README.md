# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

DeepSeek Desktop: the Electron desktop surface of the DeepSeek Harness Web GUI. Its main process embeds the harness host in-process — the same `runProfile` boot the `dsh web` alias uses, over profile `web` plus one desktop overlay — and renders the host's loopback URL in a hardened BrowserWindow. The window shows the real composed Web GUI: client plugins, HMR routes, the `/api` trust fence, agent presets, settings, credentials, and session persistence all behave exactly as in the browser.

## Standalone repository (Deepseek-Workflow)

This folder is also published as the standalone [Deepseek-Workflow](https://github.com/f2015805589/Deepseek-Workflow) repository. It is **not standalone at runtime**: the desktop is a member of the deepseek-harness pnpm workspace and resolves its `@deepseek-ai/*` dependencies from it, so a deepseek-harness checkout must exist locally.

- `package.bat` (packaging) locates the harness checkout — `DSH_HARNESS_ROOT` env var, else the sibling folder `..\deepseek-harness`, else the parent directory already being a harness — syncs this repo into it as `deepseek-desktop\`, adds the `deepseek-desktop` member to `pnpm-workspace.yaml` when missing, then installs/builds/runs.
- **No companion packages required**: the desktop is a plain shell over the web profile and depends only on harness packages every stock checkout ships (`@deepseek-ai/dsh`, `dsh-app-boot`, `dsh-host-webserver`, `dsh-settings`). Earlier revisions shipped desktop-owned product plugins (compaction setting, conversation edit, fs revert, plugin manager); those package sources were lost and are no longer referenced anywhere in this repo — nothing in the overlay or the dependency graph names them.

## Run

The tree must be built once (host lib + frontend dist), then the desktop builds its own entry:

```sh
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop start
```

The first command runs at the repository root: `build:lib` (which now also emits `@deepseek-ai/dsh/profile-boot`) plus `build:web`.

To produce a Windows executable, double-click `deepseek-desktop/package.bat` (or run it from a shell). It installs dependencies, builds the harness and the desktop entry, stages a production tree, boots it headlessly as a gate, then packages a portable exe plus an NSIS installer into `deepseek-desktop/dist/` and cleans the staging tree up.

- `dist/DeepSeek Desktop <version>.exe` — portable, self-contained: copy it anywhere and double-click.
- `dist/DeepSeek Desktop Setup <version>.exe` — NSIS installer (`latest.yml` + blockmap support future auto-update).
- The staging directory `deepseek-desktop/deploy/` is a build intermediate, removed automatically; a tree whose files were still open at cleanup time is renamed to `deploy-stale-*` (gitignored) and can be deleted by hand.

`start` rebuilds `lib/` (tsdown + the sandboxed preload copy) and launches Electron. A second launch while a desktop session is running focuses the existing window. `$DSH_HOME` is the shared harness home: the desktop sees the same profiles, settings, credentials, and sessions as the CLI. Shell/client-plugin changes follow the same contract as the Web GUI — rebuild the affected artifacts (`pnpm run build:web` for the shell, `pnpm run dev:web` for client-plugin HMR) and relaunch.

There is no one-click dev bootstrap (the old `setup.bat` was removed): add this folder as a member of the harness `pnpm-workspace.yaml` (under the name `deepseek-desktop` — or the standalone repo's own folder name, e.g. `Deepseek-Workflow`), run `pnpm install` and `pnpm run build` at the harness root, then `pnpm --filter @deepseek-ai/dsh-desktop start`. The desktop build also refreshes `apps/cli/lib/package.json` — the anchor manifest the built `@deepseek-ai/dsh/profile-boot` resolves — so the desktop keeps working after a harness clean.

## Product surface

The desktop renders the composed web profile exactly as the browser does — the window is a hardened shell over the real Web GUI, with no desktop-owned product plugins. Earlier revisions shipped four companion plugins (edit & resend, per-turn file revert, an auto-compaction threshold control, and a custom-plugin manager tab); their sources are lost and this repo no longer ships them, so those features are not present. The surface overlay now carries only the window-facing config rows (`webserver`, `web-runtime`).

The custom-plugin machinery stays: the desktop-owned `plugins/` folder, the enablement registry, per-boot profile linking, and the generated composition overlay are all still produced at every launch, and the sandboxed preload exposes `window.dshDesktop.plugins` so a page (or a future manager UI) can list/import/remove custom plugins. A plugin-manager tab is shipped again — as a **custom plugin** under `plugins/dsh-client-ui-desktop-plugins` (enabled by default via the committed `plugins/plugins.json`), registering a 自定义插件 tab in Settings → 插件 that drives the preload bridge.

## Custom plugins

Custom plugins live under the desktop's own folder — `deepseek-desktop/plugins/` (or `DSH_DESKTOP_PLUGINS_DIR`) — never inside the dsh installation, so replacing dsh loses nothing. The shipped manager tab is gone with the lost companion packages; manage plugins through the `window.dshDesktop.plugins` preload bridge (`list`/`setEnabled`/`import`/`remove`, surfaced in any page script) or by editing `plugins/plugins.json` by hand — import a plugin folder (an npm package with a built node half and, for UI plugins, a `dsh.client` browser half), enable/disable, or delete. Enablement persists to `plugins/plugins.json`; every launch links the enabled plugins into the web profile's `node_modules` and generates the composition overlay, so changes take effect on restart. See [plugins/README.md](plugins/README.md) for the folder contract.

## Architecture

- `src/main.ts` — the only module that imports `electron`: single-instance lock, `runProfile` boot with the overlay, window creation with no native menu bar (`Menu.setApplicationMenu(null)`), `ready-to-show` reveal, the page-synced window backdrop, and a `before-quit` handler that defers quitting until the host tree has disposed (session persistence flushes before the process leaves).
- `src/desktop.ts` — Electron-free surface facts: overlay path, preload path, window options, loopback URL, and the IPC color-shape validator. Unit-tested without the Electron binary.
- `config/desktop.patch.yml` — the surface overlay applied last over the web profile: webserver pinned to `127.0.0.1` port `0` (OS-assigned) and `printUrl: false` (the window owns URL display).
- `src/preload.cjs` — hand-written sandboxed CommonJS preload exposing the frozen `window.dshDesktop` seam (`{ isDesktop, platform, plugins }`), the extension point for future desktop capabilities. It also reports the page's computed theme background to the main process, which applies it to the window backdrop — pre-paint and resize edges follow the dsh appearance configuration (the `ui-theme` body base background painted by `design-platform.css`).

## Model Experience

None beyond the shared Web surface: this app contributes no prompt text, tool, or event of its own; sessions it hosts carry the same `app:web-surface` prompt section and `DSH_WEB_URL` shell variable as `dsh web`.

#### KV Cache effect

None; the harness host assembles provider requests unchanged.

## Known Limitations and Deferred Work

- **Portable/NSIS packaging only, no auto-update** — `package.bat` produces `dist/` artifacts; signing, an update feed, and other platforms are the next packaging step.
- **Loopback URL, not the reserved `file://` + IPC bridge** — the webserver package documents the IPC-bridged Electron carrier as the end state; the current surface loads the host's own loopback URL, which keeps every web route, HMR path, and trust decision working unchanged.
- **No native chrome beyond the window** — tray, notifications, deep links, and renderer consumption of `window.dshDesktop` are deferred capabilities behind the preload seam.
- **The system prompt still names the loopback URL** — the `app:web-surface` section describes the GUI at its `http://127.0.0.1:<port>` URL, which remains accurate for the embedded window.
