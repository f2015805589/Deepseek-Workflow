# dsh-client-ui-desktop-plugins — 自定义插件管理器页签

设置 → 插件 → 自定义插件。一个随仓库发布的自定义插件：浏览器半（`lib/client.js`）向 `settings.plugins.tab` 槽注册页签，通过 preload 桥 `window.dshDesktop.plugins` 列出、启用/停用、导入、删除桌面自有 `plugins/` 文件夹下的插件；宿主半（`lib/index.js`）为空实现，仅保证 loader 行可解析。

- 包名 = 文件夹名（自定义插件发现契约：`plugins/` 顶层目录即插件）。
- `plugins/plugins.json` 随仓库提交，默认启用本插件；停用即从设置页消失，重启后生效。
- 无构建步骤：浏览器半是手写的 ModuleLoader 闭包格式 bundle（外部依赖走平台模块表），与随包 UI 插件的产物同构。
