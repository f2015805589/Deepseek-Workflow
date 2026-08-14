# dsh-client-ui-desktop-plugins — 桌面产品插件（自定义插件管理器 + 压缩阈值）

一个随仓库发布的自定义插件（双面）：

- **浏览器半**（`lib/client.js`）：
  - 向 `settings.plugins.tab` 槽注册「自定义插件」页签（设置 → 插件），通过 preload 桥 `window.dshDesktop.plugins` 列出、启用/停用、删除、导入（原生文件夹选择器）桌面自有 `plugins/` 文件夹下的插件。
  - 向 `conversation.input.left` 槽注册压缩阈值下拉框（Full access 右侧，10%–90%），读写 `compaction` 设置命名空间的 `thresholdRatio`。
- **宿主半**（`lib/index.js`）：注册 `compaction` 设置命名空间（`thresholdRatio` 0.1–0.9，未设置即未配置）；压缩后端（`@deepseek-ai/dsh-compaction-basic`）每次测量都会读取该值作为覆盖。

- 包名 = 文件夹名（自定义插件发现契约：`plugins/` 顶层目录即插件）。
- `plugins/plugins.json` 随仓库提交，默认启用本插件；停用即从设置页与工具行消失，重启后生效。
- 无构建步骤：浏览器半是手写的 ModuleLoader 闭包格式 bundle（外部依赖走平台模块表），与随包 UI 插件的产物同构。

