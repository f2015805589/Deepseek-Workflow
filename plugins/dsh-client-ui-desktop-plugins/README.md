# dsh-client-ui-desktop-plugins — 桌面产品插件（自定义插件管理器 + 压缩阈值 + 消息就地编辑 + 文件撤销）

一个随仓库发布的自定义插件（双面）：

- **浏览器半**（`lib/client.js`）：
  - 向 `settings.plugins.tab` 槽注册「自定义插件」页签（设置 → 插件），通过 preload 桥 `window.dshDesktop.plugins` 列出、启用/停用、删除、导入（原生文件夹选择器）桌面自有 `plugins/` 文件夹下的插件。
  - 向 `conversation.input.left` 槽注册压缩阈值下拉框（Full access 右侧，10%–90%），读写 `compaction` 设置命名空间的 `thresholdRatio`。
  - 覆盖 `conversation.chat.node` 的 `user`/`steering` 席位，提供 **Cursor 风格的就地编辑**：点击已发送的气泡 → 气泡变成携带原文的一体化编辑框（取消 / 发送 在框内，点击不会误触失焦）。**失焦**（点击其它处）仅把修改提交进**同一会话**的模型表面（不 fork），后续请求读到修改后的内容、旧回答保留；**发送**（或 Ctrl+Enter）执行真正的**编辑重发**：把会话回卷到该消息所在轮之前（宿主经 `dsh-desktop:conversation-edit:prior-turn-end` 给出 fork 锚点），fork 出子会话并归档父会话（侧栏不出现新对话），再把编辑后的文本发进子会话——**上一轮的回答被删除**，模型直接按修改后的内容重新回答；若编辑的是第一轮消息（无前一轮可回卷），则归档后新建空白会话再发送。取消 / Escape 丢弃。编辑副本经 localStorage 在重载后保持显示。
  - 向 `shell.overlay`（frame 级可叠加 list 槽）注册右侧 **文件改动** 面板：当前会话有待处理文件改动时自动在右侧滑出，文件自上而下列出，每行显示绿色 `+N` / 红色 `-N` 行数（新增文件为 +、被删除文件为 -），行尾是「撤销」（还原到改动前）与「保存」（保留改动、移出待处理列表），顶部是「一键撤销 / 一键保存」，无改动时只保留右侧一个小标签。数据经 `window.dshDesktop.fsChanges` 桥每 2 秒刷新。
  - 向 `conversation.chat.turnTail` 槽注册每轮「撤销修改」动作（`window.dshDesktop.fsRevert`）。
- **宿主半**（`lib/index.js`）：注册 `compaction` 设置命名空间（`thresholdRatio` 0.1–0.9，未设置即未配置）；压缩后端（`@deepseek-ai/dsh-compaction-basic`）每次测量都会读取该值作为覆盖；维护每轮 fs 变更快照日志并提供 IPC 撤销网关（`dsh-desktop:fs-revert:*`）与**文件改动面板**能力（`dsh-desktop:fs-changes:*`：按文件聚合最早快照基线、行级 diff 统计 +N/-N、单文件/全部撤销与保存；纯函数 `lineDiff`、`pendingFilesOf` 可单测）；实现就地编辑 IPC `dsh-desktop:conversation-edit:apply`（表面替换，纯函数 `applyConversationEdit`）与重发锚点 IPC `dsh-desktop:conversation-edit:prior-turn-end`（纯函数 `forkAnchorBeforeMessage`），服务经 `ctx.get('sessions')` 解析（免 inject 声明）。

- 包名 = 文件夹名（自定义插件发现契约：`plugins/` 顶层目录即插件）。
- `plugins/plugins.json` 随仓库提交，默认启用本插件；停用即从设置页与工具行消失，重启后生效。
- 无构建步骤：浏览器半是手写的 ModuleLoader 闭包格式 bundle（外部依赖走平台模块表），与随包 UI 插件的产物同构。

