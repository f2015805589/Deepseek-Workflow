# DeepSeek Workflow — custom plugins folder

English | [中文](README.zh.md)

This folder is where DeepSeek Workflow keeps the custom plugins you import (through the `window.dshDesktop.plugins` preload bridge, or by placing a folder here). It lives under the desktop's own folder on purpose: replacing or reinstalling dsh (the harness that powers the desktop) never touches it — your plugins survive.

## What a custom plugin is

A custom plugin is an npm package folder (a directory with a `package.json`) that the desktop copies here and mounts at the next launch. Two shapes work:

- **Host plugin** — the `package.json` `main`/`exports` entry exports a Cordis function plugin (`apply` / optional `inject` / `Config`), like any dsh package. It runs in the desktop main process.
- **Client plugin** — additionally declares `"dsh": { "client": { "platform": "web" } }` and ships an `exports["./client"]` browser bundle; the desktop serves it to the window like every shipped UI plugin (the web roster is composed at runtime, so no frontend rebuild is needed). The client roster resolves `${name}/package.json`, so a client plugin's `exports` map must also declare `"./package.json": "./package.json"` — the same contract every shipped dsh package follows.

A plugin that does both (a dual-face package) is supported too.

The folder name under `plugins/` is the package name; the loader resolves the bare name from the web profile's `node_modules`, where the desktop creates a junction to this folder at every launch.

## Managing plugins

Use the preload bridge from any page script (`window.dshDesktop.plugins`), or edit `plugins/plugins.json` by hand:

- **导入 / Import** — `window.dshDesktop.plugins.import(sourceDir)` copies a folder containing a built plugin package here and enables it.
- **启用 / 停用** — persists to `plugins.json`; the change applies on the next launch.
- **删除 / Delete** — removes the folder and its registry entry.

Changes take effect after restarting DeepSeek Workflow. The enablement registry is `plugins.json` and the generated composition overlay is `desktop-plugins.generated.patch.yml` — both are user-local state (gitignored) and regenerated from this folder on every launch; do not edit them by hand.

## Development environment

There is no one-click bootstrap: add `deepseek-desktop` to the harness `pnpm-workspace.yaml`, install and build at the harness root, then `pnpm --filter @deepseek-ai/dsh-desktop start`. The desktop shell ships no built-in product plugins; custom plugins from this folder are mounted automatically at every launch — no per-machine setup step is needed for them.

## Files

- `plugins.json` — enablement registry (user-local, gitignored).
- `desktop-plugins.generated.patch.yml` — boot-generated overlay (user-local, gitignored).
