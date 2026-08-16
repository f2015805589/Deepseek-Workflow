# dsh-preset-minimal-powershell — 极简模式（PowerShell）

DeepSeek Workflow 自定义插件。它把 Harness 随附的 `minimal`（极简模式）agent preset
完整复刻为一个本地 preset `minimal-powershell`，唯一的差异是：

- Linux 的持久 bash 栈（`@deepseek-ai/dsh-terminal` +
  `@deepseek-ai/dsh-terminal-bash` +
  `@deepseek-ai/dsh-tool-bash-persistent`）
- 替换为 Windows PowerShell 工具（`@deepseek-ai/dsh-tool-pwsh`）

其余部分与 `minimal` 完全一致：

- 系统提示词固定为 `You are a helpful software engineer assistant.`
  （`complete: true`、`includeRuntimeContext: false`，无身份段、无 Web 方向段、
  无运行时上下文快照）；
- 模型工具严格只有两个：`pwsh` 和 `str_replace_editor`；
- 文件系统使用 preset 私有的 bare `@deepseek-ai/dsh-fs-local` realm，
  `str_replace_editor` 配置 `maxOutputChars: 16000`；
- 不挂载上下文压缩（compaction）。

## 为什么 `enableRunInBackground: false`

`tool-pwsh` 是 Windows 上 bash 工具的官方孪生实现。但 Harness 目前没有持久
PowerShell PTY 后端：每个 `pwsh` 调用都在全新的 `pwsh -Command` 进程中运行。
因此本 preset：

- 使用随附的 `@deepseek-ai/dsh-tool-pwsh`（由 Web 宿主组合中的
  `@deepseek-ai/dsh-pwsh-sandbox` 提供 `shell` seam）；
- 关闭 `run_in_background`，从而不引入 `job_output`/`job_kill` 工具——
  保持与极简模式相同的「两个工具」模型表面。

## 安装与生效

插件位于 `deepseek-desktop/plugins/dsh-preset-minimal-powershell`，
并在 `plugins/plugins.json` 中默认启用。桌面端每次启动：

1. 插件宿主半作为普通 Cordis 插件加载；
2. 首次启动通过 `AgentPresets.copy('minimal', ...)` 在
   `$DSH_HOME/.agent-presets/minimal-powershell` 建立本地 preset；
3. 每次启动都用本包内的 `agent.cordis.yml` / `preset.yml` 覆盖刷新该 preset。

新建会话时在 preset 选择器中选择「极简模式（PowerShell）」即可，无需重新构建
Web 前端。预设只会在 Windows 上安装（PowerShell 是 Windows 专用替代）。
