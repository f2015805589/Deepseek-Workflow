# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

DeepSeek Desktop: the Electron desktop surface of the DeepSeek Harness Web GUI. Its main process embeds the harness host in-process — the same `runProfile` boot the `dsh web` alias uses, over profile `web` plus one desktop overlay — and renders the host's loopback URL in a hardened BrowserWindow. The window shows the real composed Web GUI: client plugins, HMR routes, the `/api` trust fence, agent presets, settings, credentials, and session persistence all behave exactly as in the browser.

## Standalone repository (Deepseek-Workflow)

This folder is also published as the standalone [Deepseek-Workflow](https://github.com/f2015805589/Deepseek-Workflow) repository. It is **not standalone at runtime**: the desktop is a member of the deepseek-harness pnpm workspace and resolves its `@deepseek-ai/*` dependencies from it, so a deepseek-harness checkout must exist locally.

- `setup.bat` (dev bootstrap) and `package.bat` (packaging) locate the harness checkout — `DSH_HARNESS_ROOT` env var, else the sibling folder `..\deepseek-harness`, else the parent directory already being a harness — sync this repo into it as `deepseek-desktop\`, add the `deepseek-desktop` member to `pnpm-workspace.yaml` when missing, then install/build/run.
- **Harness compatibility requirement**: the harness must include the desktop companion packages (`dsh-fs-revert`, `dsh-client-ui-conversation-edit`, `dsh-client-ui-desktop-plugins`, `dsh-client-ui-compaction-setting`) and the `session.revertFiles` gateway — i.e. the same feature state this desktop was built against. A harness without them fails at `pnpm install` or boot. Built-in plugins are injected into the profile resolution at every launch, so no per-machine setup is needed for them.

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

For a fresh development machine, `deepseek-desktop/setup.bat` installs dependencies, builds the tree, and launches the desktop. The desktop owns its built-in plugin packages and injects them into the profile resolution at every launch, so no per-machine setup is needed for them — even a bare dsh installation keeps working.

## Built-in product features

The desktop overlay composes four product plugins by default, so every packaged machine gets them without profile edits:

- **Edit & resend** — a completed user message can be edited and re-sent: the action forks the session before that message and pre-fills the composer, and sending prompts the child.
- **Turn revert** — the turn tail offers 撤销修改 with a confirm dialog over the files the turn modified through the fs tools (`write`/`edit`/`str_replace_editor`); confirming restores their pre-turn content. Shell-command writes are outside the journal's coverage.
- **Auto-compaction threshold** — a `自动压缩 80%` control sits beside the model select in the composer tool row; the percentage is the durable `compaction.thresholdRatio` the backend re-reads at every measurement.
- **Custom plugin manager** — a 自定义插件 tab in Settings → 插件 that imports, deletes, and enables/disables plugins under the desktop's own `plugins/` folder.

The decisions and boundaries are recorded in the [desktop product surface Agent Note](../.agents/notes/implemented/feature/2026-08-14-dsh-desktop-product-surface.md) and the [custom plugins Agent Note](../.agents/notes/implemented/feature/2026-08-14-dsh-desktop-custom-plugins.md).

## Custom plugins

Custom plugins live under the desktop's own folder — `deepseek-desktop/plugins/` (or `DSH_DESKTOP_PLUGINS_DIR`) — never inside the dsh installation, so replacing dsh loses nothing. Manage them from Settings → 插件 → 自定义插件: import a plugin folder (an npm package with a built node half and, for UI plugins, a `dsh.client` browser half), enable/disable, or delete. Enablement persists to `plugins/plugins.json`; every launch links the enabled plugins into the web profile's `node_modules` and generates the composition overlay, so changes take effect on restart. See [plugins/README.md](plugins/README.md) for the folder contract.

## Architecture

- `src/main.ts` — the only module that imports `electron`: single-instance lock, `runProfile` boot with the overlay, window creation with no native menu bar (`Menu.setApplicationMenu(null)`), `ready-to-show` reveal, the page-synced window backdrop, and a `before-quit` handler that defers quitting until the host tree has disposed (session persistence flushes before the process leaves).
- `src/desktop.ts` — Electron-free surface facts: overlay path, preload path, window options, loopback URL, and the IPC color-shape validator. Unit-tested without the Electron binary.
- `config/desktop.patch.yml` — the surface overlay applied last over the web profile: webserver pinned to `127.0.0.1` port `0` (OS-assigned) and `printUrl: false` (the window owns URL display).
- `src/preload.cjs` — hand-written sandboxed CommonJS preload exposing the frozen `window.dshDesktop` seam (`{ isDesktop, platform }`), the extension point for future desktop capabilities. It also reports the page's computed theme background to the main process, which applies it to the window backdrop — pre-paint and resize edges follow the dsh appearance configuration (the `ui-theme` body base background painted by `design-platform.css`).

The decision and its alternatives are recorded in the [desktop surface Agent Note](../.agents/notes/implemented/architecture/2026-08-13-dsh-desktop-surface.md).

## Model Experience

None beyond the shared Web surface: this app contributes no prompt text, tool, or event of its own; sessions it hosts carry the same `app:web-surface` prompt section and `DSH_WEB_URL` shell variable as `dsh web`.

#### KV Cache effect

None; the harness host assembles provider requests unchanged.

## Known Limitations and Deferred Work

- **Portable/NSIS packaging only, no auto-update** — `package.bat` produces `dist/` artifacts; signing, an update feed, and other platforms are the next packaging step.
- **Loopback URL, not the reserved `file://` + IPC bridge** — the webserver package documents the IPC-bridged Electron carrier as the end state; the current surface loads the host's own loopback URL, which keeps every web route, HMR path, and trust decision working unchanged.
- **No native chrome beyond the window** — tray, notifications, deep links, and renderer consumption of `window.dshDesktop` are deferred capabilities behind the preload seam.
- **The system prompt still names the loopback URL** — the `app:web-surface` section describes the GUI at its `http://127.0.0.1:<port>` URL, which remains accurate for the embedded window.
