# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

DeepSeek Desktop：DeepSeek Harness Web GUI 的 Electron 桌面表面。其主进程在进程内嵌宿主——与 `dsh web` 别名相同的 `runProfile` 启动，profile 取 `web` 并叠加一个桌面 overlay——并在加固的 BrowserWindow 中渲染宿主的 loopback URL。窗口呈现的是真实组合的 Web GUI：客户端插件、HMR 路由、`/api` 信任栅栏、agent preset、设置、凭据和会话持久化，行为与浏览器中完全一致。

## 独立仓库（Deepseek-Workflow）

本文件夹也作为独立的 [Deepseek-Workflow](https://github.com/f2015805589/Deepseek-Workflow) 仓库发布。它在运行时**并非独立**：桌面端是 deepseek-harness pnpm 工作区的成员，其 `@deepseek-ai/*` 依赖都从 harness 解析，因此本地必须有一份 deepseek-harness checkout。

- `package.bat`（打包）定位 harness checkout——按 `DSH_HARNESS_ROOT` 环境变量 → 上一级兄弟目录 `..\deepseek-harness` → 父目录本身就是 harness 的顺序查找——把本仓库同步为它的 `deepseek-desktop\`，若 `pnpm-workspace.yaml` 缺少 `deepseek-desktop` 成员则补上，然后安装/构建/运行。
- **不再需要配套包**：桌面端是 web profile 之上的纯壳，只依赖每个标准 harness checkout 都有的包（`@deepseek-ai/dsh`、`dsh-app-boot`、`dsh-host-webserver`、`dsh-settings`）。早期版本曾随包提供桌面自有的产品插件（压缩设置、编辑重发、文件撤销、插件管理器）；这些包源码已丢失，本仓库不再以独立包的形式引用它们——overlay 与依赖图里都不再出现这些名字。其中「自定义插件管理器、压缩阈值、Cursor 风格消息就地编辑（不 fork 同一会话内生效）、按轮文件撤销」已作为**自定义插件**（`plugins/dsh-client-ui-desktop-plugins`，见 `plugins/plugins.json` 默认启用）重新提供。

## 运行

先构建一次整树（宿主 lib + 前端 dist），桌面端再构建自己的入口：

```sh
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop start
```

第一条命令在仓库根运行：`build:lib`（现在也会产出 `@deepseek-ai/dsh/profile-boot`）加 `build:web`。

要产出 Windows 可执行文件，双击 `deepseek-desktop/package.bat`（或在 shell 里运行）：它安装依赖、构建 harness 与桌面入口、搭建生产树、无头启动一遍作为闸门，然后把 portable 单文件 exe 和 NSIS 安装器打包到 `deepseek-desktop/dist/`，最后自动清理 staging 树。

- `dist/DeepSeek Desktop <版本>.exe` —— portable 单文件版，自包含：复制到任何位置双击即可运行。
- `dist/DeepSeek Desktop Setup <版本>.exe` —— NSIS 安装器（`latest.yml` + blockmap 支持将来的自动更新）。
- 构建中间目录 `deepseek-desktop/deploy/` 会被自动删除；清理时文件仍被占用的旧树会改名为 `deploy-stale-*`（已 gitignore），可手动删除。

`start` 会重建 `lib/`（tsdown + 沙箱 preload 复制）并启动 Electron。桌面会话运行期间再次启动只会聚焦已有窗口。`$DSH_HOME` 是共享的 harness home：桌面端看到的 profile、设置、凭据和会话与 CLI 相同。外壳/客户端插件的变更遵循与 Web GUI 相同的契约——外壳变更后 `pnpm run build:web`，客户端插件 HMR 用 `pnpm run dev:web`，然后重启。

没有一键开发引导（旧的 `setup.bat` 已删除）：把这个文件夹加入 harness 的 `pnpm-workspace.yaml` 成员（名称为 `deepseek-desktop`，或独立仓库自身的文件夹名如 `Deepseek-Workflow`），在 harness 根运行 `pnpm install` 与 `pnpm run build`，然后 `pnpm --filter @deepseek-ai/dsh-desktop start`。桌面构建还会刷新 `apps/cli/lib/package.json`——已构建的 `@deepseek-ai/dsh/profile-boot` 所解析的锚点清单——因此 harness 清理后桌面依然可用。

## 产品表面

桌面端渲染的组合 web profile 与浏览器完全一致——窗口只是真实 Web GUI 之上的加固壳，不含任何桌面自有的产品插件。早期版本曾随包提供四个配套插件（编辑重发、按轮文件撤销、自动压缩阈值控件、自定义插件管理器页签）；其源码已丢失，本仓库不再随包提供，因此这些功能不再存在。表面 overlay 现在只保留面向窗口的配置行（`webserver`、`web-runtime`）。

> 注：上述四项产品能力已由随仓库提交的**自定义插件** `plugins/dsh-client-ui-desktop-plugins`（默认启用）重新提供：设置 → 插件 →「自定义插件」页签管理桌面自有 `plugins/`；输入行右侧的压缩阈值；点击用户消息气泡即可**就地编辑**——失焦仅更新同一会话内的上下文（旧回答保留），「发送」则回卷并删除旧回答、让模型按修改后的内容直接重答（不产生可见新对话）；每轮消息下的「撤销修改」。此外还提供右侧**文件改动**面板：当前会话修改过的文件自上而下显示绿 `+N`/红 `-N` 行数，行尾「撤销/保存」、顶部「一键撤销/一键保存」。插件的宿主半实现编辑提交/重发锚点 IPC、fs 撤销 IPC 与文件改动面板 IPC。

自定义插件机制保留：桌面自有的 `plugins/` 文件夹、启用注册表、每次启动的 profile 链接与生成的组合 overlay 都照常产出，沙箱 preload 仍暴露 `window.dshDesktop.plugins`，页面（或未来的管理器 UI）可以列出/导入/移除自定义插件。插件管理器页签已随仓库再次提供——作为**自定义插件**放在 `plugins/dsh-client-ui-desktop-plugins`（通过随仓库提交的 `plugins/plugins.json` 默认启用），在 设置 → 插件 注册「自定义插件」页签，驱动 preload 桥。

## 自定义插件

自定义插件位于桌面自有目录——`deepseek-desktop/plugins/`（或 `DSH_DESKTOP_PLUGINS_DIR`）——而不是 dsh 安装内部，因此替换 dsh 不会丢失任何东西。随包管理器页签已随丢失的配套包一起消失；通过 `window.dshDesktop.plugins` preload 桥（`list`/`setEnabled`/`import`/`remove`，任何页面脚本都能调用）或手工编辑 `plugins/plugins.json` 来管理：导入插件文件夹（带已构建节点半的 npm 包；UI 插件另需 `dsh.client` 浏览器半）、启用/停用、删除。启用状态持久化到 `plugins/plugins.json`；每次启动把已启用插件链接进 web profile 的 `node_modules` 并生成组合 overlay，因此变更在重启后生效。文件夹契约见 [plugins/README.md](plugins/README.md)。

## 架构

- `src/main.ts` —— 唯一导入 `electron` 的模块：单实例锁、带 overlay 的 `runProfile` 启动、无原生菜单栏的窗口创建（`Menu.setApplicationMenu(null)`）、`ready-to-show` 显示、随页面同步的窗口底色，以及一个把退出推迟到宿主树 dispose 完成之后的 `before-quit` 处理器（进程退出前会话持久化先落盘）。
- `src/desktop.ts` —— 与 Electron 无关的表面事实：overlay 路径、preload 路径、窗口选项、loopback URL，以及 IPC 颜色形状校验器。无需 Electron 二进制即可单测。
- `config/desktop.patch.yml` —— 最后叠加在 web profile 之上的表面 overlay：webserver 钉在 `127.0.0.1` 端口 `0`（OS 分配），`printUrl: false`（URL 展示归窗口所有）。
- `src/preload.cjs` —— 手写的沙箱化 CommonJS preload，暴露冻结的 `window.dshDesktop` 缝（`{ isDesktop, platform, plugins }`），是未来桌面能力的扩展点。它还会把页面的计算主题背景上报给主进程、应用到窗口底色——首帧与缩放边缘随 dsh 外观配置走（`design-platform.css` 绘制的 `ui-theme` body 基础背景）。

## Model Experience

除共享的 Web 表面外没有新增：本应用不贡献自己的提示文本、工具或事件；它托管的会话携带与 `dsh web` 相同的 `app:web-surface` 提示段和 `DSH_WEB_URL` shell 变量。

#### KV Cache effect

无；harness 宿主原样组装 provider 请求。

## Known Limitations and Deferred Work

- **仅 portable/NSIS 打包，无自动更新** —— `package.bat` 产出 `dist/` 产物；签名、更新源和其他平台是下一步打包工作。
- **loopback URL，而非预留的 `file://` + IPC 桥** —— webserver 包将 IPC 桥接的 Electron carrier 记为终态；当前表面加载宿主自己的 loopback URL，使每条 Web 路由、HMR 路径和信任决策原样工作。
- **窗口之外没有原生 chrome** —— 托盘、通知、深链以及渲染层对 `window.dshDesktop` 的消费，都是 preload 缝之后推迟的能力。
- **系统提示仍写着 loopback URL** —— `app:web-surface` 段以 `http://127.0.0.1:<port>` 描述 GUI，对内嵌窗口依然准确。
