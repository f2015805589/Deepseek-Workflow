# DeepSeek Workflow — 自定义插件文件夹

[English](README.md) | 中文

这个文件夹存放通过桌面端（设置 → 插件 → 导入插件文件夹）导入的自定义插件。它特意放在桌面端自己的目录下：替换或重装 dsh（支撑桌面端的 harness）不会影响它——你的插件始终保留。

## 自定义插件是什么

自定义插件是一个 npm 包文件夹（含 `package.json` 的目录），桌面端会把它复制到这里并在下次启动时挂载。两种形态都支持：

- **宿主插件** —— `package.json` 的 `main`/`exports` 入口导出 Cordis 函数插件（`apply` / 可选 `inject` / `Config`），与任何 dsh 包相同。它在桌面主进程中运行。
- **客户端插件** —— 额外声明 `"dsh": { "client": { "platform": "web" } }`，并提供 `exports["./client"]` 浏览器 bundle；桌面端像对待每个随包 UI 插件一样把它提供给窗口（web roster 在运行时组合，无需重建前端）。客户端 roster 会解析 `${name}/package.json`，因此客户端插件的 `exports` 映射还必须声明 `"./package.json": "./package.json"`——与每个随包 dsh 包相同的契约。

同时具备两种形态（双面包）也支持。

`plugins/` 下的文件夹名即包名；loader 从 web profile 的 `node_modules` 解析裸包名，桌面端每次启动都会在这里为本文件夹建立 junction。桌面端自己的出厂行（编辑重发、轮次撤销、压缩设置、插件管理）是桌面自有的包，经桌面端每次启动用自己的依赖闭包修复的 profile 回退目录解析——因此即使 dsh 安装里根本没有这些包也能正常工作。

## 管理插件

使用桌面 UI（设置 → 插件）：

- **导入** —— 选择一个包含已构建插件包的文件夹；桌面端把它复制到这里并启用。
- **启用 / 停用** —— 持久化到 `plugins.json`；变更在下次启动时生效。
- **删除** —— 移除文件夹及其注册表条目。

变更在重启 DeepSeek Workflow 后生效。启用注册表是 `plugins.json`，生成的组合 overlay 是 `desktop-plugins.generated.patch.yml`——两者都是用户本地状态（已 gitignore），每次启动从本文件夹重新生成；不要手工编辑。

## 开发环境

`deepseek-desktop/setup.bat` 引导开发环境（安装 + 构建）并启动桌面端。内置插件注入在每次启动时自动完成——不需要任何逐机设置步骤。

## 文件

- `plugins.json` —— 启用注册表（用户本地，已 gitignore）。
- `desktop-plugins.generated.patch.yml` —— 启动生成的 overlay（用户本地，已 gitignore）。
