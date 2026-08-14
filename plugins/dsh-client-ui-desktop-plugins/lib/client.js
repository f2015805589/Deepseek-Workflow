// DeepSeek Workflow custom-plugin manager — browser half.
//
// Registers a "自定义插件" tab in Settings → 插件 (the settings.plugins.tab
// slot declared by @deepseek-ai/dsh-client-ui-settings-plugins) and drives the
// desktop-owned plugins folder through the preload bridge
// window.dshDesktop.plugins (list / setEnabled / import / remove). The host
// half (lib/index.js) is a no-op; this bundle is the whole product.
//
// Hand-written in the loader-closure format every client bundle ships:
// window.__ModuleLoader__.load({ id, factory }) with externals resolved from
// the frozen platform module table (react, ...) — no build step, no bundler.
window.__ModuleLoader__.load({
	id: "dsh-client-ui-desktop-plugins",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { useCallback, useEffect, useRef, useState } = React;

		/** The tab's stable slot id inside the Plugins settings section. */
		const TAB_ID = "desktop-custom";

		/** Services the client plugin needs from the composed runtime. */
		const inject = ["slots", "sessions", "workspaces"];

		/** localStorage key holding staged message edits (sessionId → messageId → text). */
		const EDIT_STORAGE_KEY = "dshDesktop.conversationEdit.v1";

		function loadEditMap() {
			try {
				const raw = localStorage.getItem(EDIT_STORAGE_KEY);
				if (!raw) return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
			} catch {
				return {};
			}
		}

		/** The locally staged edited copy of one message, or undefined when never edited. */
		function readEdit(sessionId, messageId) {
			if (!sessionId || !messageId) return undefined;
			try {
				const value = loadEditMap()[sessionId]?.[messageId];
				return typeof value === "string" ? value : undefined;
			} catch {
				return undefined;
			}
		}

		/** Persist one staged edit (sessionId → messageId → text). */
		function writeEdit(sessionId, messageId, text) {
			if (!sessionId || !messageId) return;
			try {
				const all = loadEditMap();
				const bySession = all[sessionId] || (all[sessionId] = {});
				bySession[messageId] = text;
				localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(all));
			} catch {
				// A storage failure only loses the display overlay; the host
				// surface replacement is the durable source of truth.
			}
		}

		/** Drop one staged edit (rollback after a failed host apply). */
		function clearEdit(sessionId, messageId) {
			if (!sessionId || !messageId) return;
			try {
				const all = loadEditMap();
				const bySession = all[sessionId];
				if (bySession && Object.prototype.hasOwnProperty.call(bySession, messageId)) {
					delete bySession[messageId];
					localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(all));
				}
			} catch {
				// Ignore: the overlay is best-effort display state.
			}
		}

		/** Compaction threshold range, mirrored from the host half (10%..90%). */
		const THRESHOLD_MIN = 10;
		const THRESHOLD_MAX = 90;
		const THRESHOLD_STEP = 5;
		const THRESHOLD_DEFAULT = 80;

		/** Renderer access to the desktop-owned plugin bridge. */
		function bridge() {
			return typeof window !== "undefined" && window.dshDesktop && window.dshDesktop.plugins
				? window.dshDesktop.plugins
				: undefined;
		}

		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			padding: "10px 12px",
			border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
			borderRadius: "8px",
			margin: "6px 0",
		};
		const nameStyle = { fontWeight: 600, flex: "1 1 auto", minWidth: 0 };
		const mutedStyle = { color: "var(--dsw-text-muted, #8b8b93)", fontSize: "12px" };
		const buttonStyle = {
			padding: "4px 10px",
			borderRadius: "6px",
			border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
			background: "transparent",
			cursor: "pointer",
		};
		const dangerStyle = { ...buttonStyle, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" };

		function PluginRow({ plugin, onToggle, onRemove, disabled }) {
			return React.createElement(
				"div",
				{ style: rowStyle, "data-plugin": plugin.name },
				React.createElement(
					"div",
					{ style: { flex: "1 1 auto", minWidth: 0 } },
					React.createElement(
						"div",
						{ style: nameStyle },
						plugin.name,
						plugin.version ? React.createElement("span", { style: mutedStyle }, ` v${plugin.version}`) : null,
					),
					React.createElement(
						"div",
						{ style: mutedStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
						plugin.description || plugin.folder,
					),
				),
				React.createElement(
					"button",
					{
						type: "button",
						style: buttonStyle,
						disabled: disabled,
						onClick: () => onToggle(plugin),
					},
					plugin.enabled ? "停用" : "启用",
				),
				React.createElement(
					"button",
					{
						type: "button",
						style: dangerStyle,
						disabled: disabled,
						onClick: () => onRemove(plugin),
					},
					"删除",
				),
			);
		}

		/** Compaction threshold control for the composer tool row (conversation.input.left). */
		function CompactionThresholdControl() {
			const settings = bridge() && window.dshDesktop.settings;
			const [committed, setCommitted] = useState(THRESHOLD_DEFAULT);
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState(null);
			const inputRef = useRef(null);

			const refresh = useCallback(() => {
				if (!settings) return;
				settings.getCompactionThreshold().then(
					(ratio) => { if (typeof ratio === "number") setCommitted(Math.round(ratio * 100)); },
					() => {},
				);
			}, [settings]);

			useEffect(() => { refresh(); }, [refresh]);

			useEffect(() => {
				if (editing) inputRef.current?.focus();
			}, [editing]);

			if (!settings) return null;

			const pct = editing && draft !== null ? draft : committed;

			const open = () => { setDraft(committed); setEditing(true); };
			const close = () => setEditing(false);

			const commit = (event) => {
				const next = Number(event.currentTarget.value);
				setDraft(next);
				settings.setCompactionThreshold(next / 100).then(
					() => refresh(),
					(error) => {
						console.error("[compaction-threshold] set failed:", error);
						refresh();
					},
				);
			};

			const handleBlur = (event) => {
				// Clicking elsewhere (or tabbing out) collapses back to the number.
				if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false);
			};

			const chipStyle = {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				fontSize: "12px",
				lineHeight: 1,
				padding: "2px 6px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
				borderRadius: "6px",
				background: "transparent",
				color: "var(--dsw-text-muted, #8b8b93)",
				cursor: "pointer",
				whiteSpace: "nowrap",
			};

			if (!editing) {
				return React.createElement(
					"button",
					{
						type: "button",
						style: chipStyle,
						title: "自动压缩阈值：上下文窗口用量的百分比，达到该比例时自动压缩（10%–90%）",
						onClick: open,
					},
					React.createElement("span", null, "压缩 "),
					React.createElement("span", { style: { fontWeight: 600, color: "var(--dsw-text, inherit)" } }, `${committed}%`),
				);
			}

			return React.createElement(
				"span",
				{
					style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--dsw-text-muted, #8b8b93)", whiteSpace: "nowrap" },
					title: "自动压缩阈值（10%–90%）",
					onBlur: handleBlur,
				},
				React.createElement("span", null, "压缩 "),
				React.createElement("input", {
					ref: inputRef,
					type: "range",
					min: THRESHOLD_MIN,
					max: THRESHOLD_MAX,
					step: THRESHOLD_STEP,
					value: pct,
					"aria-label": "自动压缩阈值（百分比）",
					style: { width: "110px", accentColor: "var(--dsw-accent, #4d9fff)", verticalAlign: "middle" },
					onChange: commit,
					onKeyDown: (event) => {
						if (event.key === "Escape") close();
					},
				}),
				React.createElement("span", { style: { minWidth: "28px", textAlign: "right", fontWeight: 600 } }, `${pct}%`),
			);
		}

		/** The custom-plugin manager tab body. */
		function DesktopPluginsTab() {
			const plugins = bridge();
			const [view, setView] = useState({ status: "loading" });
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "", text: "" });

			const reload = useCallback(() => {
				if (plugins === undefined) {
					setView({ status: "error", message: "window.dshDesktop.plugins 不可用（仅在桌面端渲染）" });
					return;
				}
				setView({ status: "loading" });
				plugins.list().then(
					(payload) => setView({ status: "ready", payload }),
					(error) => setView({ status: "error", message: String((error && error.message) || error) }),
				);
			}, [plugins]);

			useEffect(() => { reload() }, [reload]);

			const flash = (kind, text) => setNotice({ kind, text });

			const toggle = (plugin) => {
				if (plugins === undefined) return;
				setBusy(true);
				plugins.setEnabled(plugin.name, !plugin.enabled).then(
					() => { flash("ok", `已${plugin.enabled ? "停用" : "启用"} ${plugin.name}，重启后生效`); reload(); },
					(error) => { flash("err", String((error && error.message) || error)); setBusy(false); },
				);
			};

			const remove = (plugin) => {
				if (plugins === undefined) return;
				if (!window.confirm(`删除插件 ${plugin.name}？`)) return;
				setBusy(true);
				plugins.remove(plugin.name).then(
					() => { flash("ok", `已删除 ${plugin.name}`); reload(); },
					(error) => { flash("err", String((error && error.message) || error)); setBusy(false); },
				);
			};

			const doPick = () => {
				if (plugins === undefined || typeof plugins.pickDirectory !== "function") {
					flash("err", "当前桌面端不支持文件夹选择器（请升级桌面端）");
					return;
				}
				setBusy(true);
				plugins.pickDirectory().then(
					(dir) => {
						if (typeof dir !== "string" || dir === "") { setBusy(false); return; }
						return plugins.import(dir).then(
							(installed) => { flash("ok", `已导入并启用 ${installed.name}，重启后生效`); reload(); },
							(error) => { flash("err", String((error && error.message) || error)); setBusy(false); },
						);
					},
					(error) => { flash("err", String((error && error.message) || error)); setBusy(false); },
				);
			};

			let body;
			if (view.status === "loading") {
				body = React.createElement("p", null, "加载中…");
			} else if (view.status === "error") {
				body = React.createElement(
					"div",
					null,
					React.createElement("p", { role: "alert", style: { color: "#e5484d" } }, `加载失败：${view.message}`),
				);
			} else {
				const custom = view.payload.plugins;
				body = React.createElement(
					"div",
					null,
					view.payload.customPluginsLoadable === false
						? React.createElement(
								"p",
								{ style: { ...mutedStyle, margin: "8px 0" } },
								"当前运行时的内部 loader 不可用，自定义插件可能无法挂载。",
							)
						: null,
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "8px", margin: "10px 0" } },
						React.createElement(
							"button",
							{
								type: "button",
								style: buttonStyle,
								disabled: busy,
								onClick: doPick,
							},
							busy ? "处理中…" : "选择文件夹导入…",
						),
					),
					notice.text !== ""
						? React.createElement(
								"p",
								{ style: { ...mutedStyle, color: notice.kind === "err" ? "#e5484d" : undefined } },
								notice.text,
							)
						: null,
					React.createElement(
						"div",
						{ style: { marginTop: "10px" } },
						custom.length === 0
							? React.createElement("p", { style: mutedStyle }, "没有自定义插件。")
							: custom.map((plugin) => React.createElement(PluginRow, {
									key: plugin.name,
									plugin,
									disabled: busy,
									onToggle: toggle,
									onRemove: remove,
								})),
					),
					view.payload.builtIn && view.payload.builtIn.length > 0
						? React.createElement(
								"div",
								{ style: { marginTop: "14px" } },
								React.createElement("h3", { style: { fontSize: "13px", margin: "0 0 6px" } }, "内置保留插件（只读）"),
								view.payload.builtIn.map((row) =>
									React.createElement(
										"div",
										{ key: row.id, style: { ...rowStyle, opacity: 0.65 } },
										React.createElement("span", { style: nameStyle }, row.id),
										React.createElement("span", { style: mutedStyle }, row.name),
									),
								),
							)
						: null,
				);
			}

			return React.createElement(
				"div",
				{ style: { padding: "4px 0" } },
				React.createElement("h3", { style: { fontSize: "13px", margin: "0 0 4px" } }, "自定义插件"),
				React.createElement(
					"p",
					{ style: { ...mutedStyle, margin: "0 0 8px" } },
					"插件位于桌面自有目录 plugins/（或 DSH_DESKTOP_PLUGINS_DIR），替换 dsh 不会丢失。变更在重启后生效。",
				),
				body,
			);
		}

		/** Message-id used by the host surface lookup: the user/steering node's
		 *  engine correlation is the message id (String(event.data.id)); steering
		 *  nodes also carry it on data.messageId. */
		function messageIdOf(node) {
			const data = node.data;
			if (data && typeof data.messageId === "string" && data.messageId !== "") return data.messageId;
			return typeof node.id === "string" && node.id !== "" ? node.id : undefined;
		}

		/** Join the text blocks of a user message (block.type === "text"). */
		function userTextOf(content) {
			if (!Array.isArray(content)) return typeof content === "string" ? content : "";
			return content
				.filter(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
				.map(block => block.text)
				.join("");
		}

		/** Whether a user message carries image blocks. */
		function hasImagesOf(content) {
			return Array.isArray(content)
				&& content.some(block => block && typeof block === "object" && block.type === "image");
		}

		/** Cursor-style inline edit on user messages. Clicking the sent bubble
		 *  swaps it for a boxed editor carrying the message text with 取消/发送
		 *  actions.
		 *  - Clicking elsewhere (blur) COMMITS the edit in place (surface
		 *    replace in the SAME session): the model reads the edited wording
		 *    on its next request and the old reply stays in place.
		 *  - 发送 (or Ctrl/Cmd+Enter) performs a true EDIT-AND-RESEND: the host
		 *    resolves the turn/end BEFORE the edited message's turn, the client
		 *    forks there (the edited message, its old reply, and any later
		 *    turns fall away), archives the parent so no new dialog appears,
		 *    and sends the edited text into the child — the model answers the
		 *    corrected message directly. A message opening the first turn
		 *    rewinds to a fresh blank session instead.
		 *  - 取消 (or Escape) discards the draft.
		 *  Buttons live INSIDE the editor box and swallow mousedown, so a click
		 *  on them never blurs (and thus never accidentally commits/cancels)
		 *  the editor. */
		function UserMessageEditNode({ node, sessionId, sessions, workspaces }) {
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState("");
			const [hover, setHover] = useState(false);
			const editBridge = bridge() && window.dshDesktop.conversationEdit;

			const content = node.data && node.data.content;
			const text = userTextOf(content);
			const hasImages = hasImagesOf(content);
			const messageId = messageIdOf(node);
			const editable = Boolean(editBridge && messageId);

			// The locally staged edited copy (persisted across reloads); the
			// durable source of truth is the host's surface replacement.
			const staged = readEdit(sessionId, messageId);
			const displayText = staged !== undefined ? staged : text;
			const isEdited = staged !== undefined && staged !== text;

			const startEdit = () => {
				if (!editable) return;
				setDraft(displayText);
				setEditing(true);
			};
			const cancelEdit = () => setEditing(false);

			/** Send one text into a target session through its session face
			 *  (explicit id — no scope dance, works after the session switched). */
			const sendInto = (targetId, textToSend) => {
				const binding = sessions && typeof sessions.binding === "function"
					? sessions.binding(targetId)
					: undefined;
				if (!binding || !binding.session || typeof binding.session.prompt !== "function") {
					return Promise.reject(new Error("conversation-edit: target session binding unavailable"));
				}
				return binding.session.prompt([{ type: "text", text: textToSend }], "queue").then((result) => {
					if (!result || !result.ok) {
						const detail = result && result.error
							? `${result.error.code}: ${result.error.message}`
							: "prompt rejected";
						throw new Error(`conversation-edit: ${detail}`);
					}
				});
			};

			/** Commit the staged draft in place (the blur path): persist the
			 *  display overlay and ask the host to replace the message on the
			 *  model surface. Optimistic: a failed host apply rolls the overlay
			 *  back. */
			const commitEdit = () => {
				setEditing(false);
				const next = draft;
				if (next.trim() === "" || next === displayText) return;
				writeEdit(sessionId, messageId, next);
				if (editBridge) {
					editBridge.apply(sessionId, messageId, next).then(
						(result) => {
							if (result && result.ok === false) {
								clearEdit(sessionId, messageId);
								console.error("[conversation-edit] apply failed:", result.error);
							}
						},
						(error) => {
							clearEdit(sessionId, messageId);
							console.error("[conversation-edit] apply failed:", error);
						},
					);
				}
			};

			/** Wait until the sessions list switches away from `previousId`
			 *  (first-turn fallback: startSession opens the fresh blank). */
			const waitForCurrent = (previousId, timeoutMs) => new Promise((resolve, reject) => {
				const started = Date.now();
				const poll = () => {
					let current;
					try {
						current = sessions.list.getSnapshot().current;
					} catch {
						current = undefined;
					}
					if (current !== undefined && current !== previousId) return resolve(current);
					if (Date.now() - started > timeoutMs) {
						return reject(new Error("conversation-edit: new session did not open"));
					}
					setTimeout(poll, 50);
				};
				poll();
			});

			/** True edit-and-resend: rewind to before the edited turn, open the
			 *  child, archive the parent (no visible new dialog), and send the
			 *  edited text. Any failure falls back to staging the edit in place. */
			const doSend = () => {
				setEditing(false);
				const next = draft;
				if (next.trim() === "") return;
				const sourceId = sessionId;
				const sourceSeq = node.anchorSeq;
				const fallback = () => commitEdit();

				if (!editBridge || !sessions || typeof sessions.fork !== "function") return fallback();

				const archiveParent = () => {
					if (workspaces && typeof workspaces.archiveSession === "function") {
						workspaces.archiveSession(sourceId).catch(() => {});
					}
				};

				editBridge.priorTurnEnd(sourceId, sourceSeq).then(
					(anchor) => {
						if (anchor && anchor.ok && typeof anchor.atSeq === "number") {
							sessions.fork({ sessionId: sourceId, atSeq: anchor.atSeq, increaseTitle: false })
								.then((childId) => {
									sessions.open(childId);
									archiveParent();
									return sendInto(childId, next);
								})
								.then(
									() => { clearEdit(sourceId, messageId); },
									(error) => {
										console.error("[conversation-edit] resend failed:", error);
										fallback();
									},
								);
						} else if (anchor && anchor.ok === false && anchor.error === "first-turn") {
							// The edited message opens the first turn: no prior
							// completed turn exists to fork from, so rewind to a
							// fresh blank session in the same workspace instead.
							archiveParent();
							if (workspaces && typeof workspaces.startSession === "function") {
								workspaces.startSession();
								waitForCurrent(sourceId, 5000).then(
									(newId) => sendInto(newId, next),
									(error) => {
										console.error("[conversation-edit] first-turn resend failed:", error);
										fallback();
									},
								).then(
									() => { clearEdit(sourceId, messageId); },
									(error) => {
										console.error("[conversation-edit] first-turn send failed:", error);
										fallback();
									},
								);
							} else {
								fallback();
							}
						} else {
							fallback();
						}
					},
					(error) => {
						console.error("[conversation-edit] prior-turn lookup failed:", error);
						fallback();
					},
				);
			};

			/** Clicking elsewhere commits the draft (the Cursor flow: type, then
			 *  click away — the edit is staged even without pressing 发送). */
			const handleBlur = (event) => {
				if (event.currentTarget.contains(event.relatedTarget)) return;
				commitEdit();
			};

			const bubbleStyle = {
				maxWidth: "100%",
				background: "var(--dsw-specific-bubble)",
				borderRadius: "22px",
				padding: "10px 16px",
				fontSize: "16px",
				lineHeight: "24px",
				color: "var(--dsw-alias-label-primary)",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
			};
			const clickableBubbleStyle = editable
				? { cursor: "pointer", outline: hover ? "1px solid var(--dsw-border, rgba(128,128,128,.55))" : "none" }
				: {};
			const rowStyle = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" };
			const editorBoxStyle = {
				width: "100%",
				background: "var(--dsw-input-bg, transparent)",
				border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
				borderRadius: "12px",
				overflow: "hidden",
			};
			const textareaStyle = {
				width: "100%",
				minHeight: "120px",
				boxSizing: "border-box",
				background: "transparent",
				color: "var(--dsw-text, inherit)",
				border: "none",
				outline: "none",
				padding: "10px 14px",
				fontSize: "16px",
				lineHeight: "24px",
				fontFamily: "inherit",
				resize: "vertical",
			};
			const actionBarStyle = {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				justifyContent: "flex-end",
				padding: "6px 10px",
				borderTop: "1px solid var(--dsw-border, rgba(128,128,128,.2))",
			};
			const shortcutHintStyle = {
				fontSize: "11px",
				lineHeight: 1,
				color: "var(--dsw-text-muted, #8b8b93)",
				marginRight: "auto",
				whiteSpace: "nowrap",
			};
			const cancelButtonStyle = {
				fontSize: "12px",
				lineHeight: 1,
				padding: "4px 12px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
				borderRadius: "6px",
				background: "transparent",
				color: "var(--dsw-text-muted, #8b8b93)",
				cursor: "pointer",
			};
			const sendButtonStyle = {
				...cancelButtonStyle,
				color: "var(--dsw-accent, #4d9fff)",
				borderColor: "var(--dsw-accent, #4d9fff)",
			};
			const hintStyle = {
				fontSize: "11px",
				lineHeight: 1,
				padding: "0",
				border: "none",
				background: "transparent",
				color: "var(--dsw-text-muted, #8b8b93)",
			};

			if (editing) {
				// Swallow mousedown on the actions so a click on 取消/发送 never
				// moves focus out of the textarea: no blur, no accidental
				// commit/cancel — only the intended onClick runs.
				const preventBlur = (event) => event.preventDefault();
				return React.createElement(
					"div",
					{ style: editorBoxStyle, onBlur: handleBlur },
					React.createElement("textarea", {
						value: draft,
						rows: 5,
						autoFocus: true,
						"aria-label": "编辑消息",
						style: textareaStyle,
						onChange: (event) => setDraft(event.currentTarget.value),
						onKeyDown: (event) => {
							if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); doSend(); }
						},
					}),
					React.createElement(
						"div",
						{ style: actionBarStyle },
						React.createElement("span", { style: shortcutHintStyle }, "Ctrl+Enter 发送 · Esc 取消"),
						React.createElement("button", {
							type: "button",
							style: cancelButtonStyle,
							onMouseDown: preventBlur,
							onClick: cancelEdit,
						}, "取消"),
						React.createElement("button", {
							type: "button",
							style: sendButtonStyle,
							onMouseDown: preventBlur,
							disabled: draft.trim() === "",
							onClick: doSend,
						}, "发送"),
					),
				);
			}

			return React.createElement(
				"div",
				{ style: rowStyle, "data-chat-anchor-key": node.key },
				React.createElement(
					"div",
					{
						style: { ...bubbleStyle, ...clickableBubbleStyle },
						onClick: startEdit,
						onMouseEnter: () => setHover(true),
						onMouseLeave: () => setHover(false),
						title: editable ? "点击编辑这条消息" : undefined,
						role: editable ? "button" : undefined,
						tabIndex: editable ? 0 : undefined,
						onKeyDown: editable
							? (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										startEdit();
									}
								}
							: undefined,
					},
					displayText === "" && hasImages ? "(图片附件)" : displayText,
				),
				editable && (hover || isEdited)
					? React.createElement(
							"span",
							{ style: hintStyle, title: "点击气泡即可修改；失焦仅更新上下文，发送则重发并删除旧回答" },
							isEdited ? "已编辑，点击修改" : "点击编辑",
						)
					: null,
			);
		}

		/** Per-turn file revert: 撤销修改 for the turn's fs-tool changes. */
		function TurnRevertAction({ turn, sessionId }) {
			const fsBridge = bridge() && window.dshDesktop.fsRevert;
			const [files, setFiles] = useState(null);

			useEffect(() => {
				if (!fsBridge || !sessionId) { setFiles(null); return; }
				let current = true;
				fsBridge.list(sessionId).then(
					(rows) => {
						if (!current) return;
						const row = (rows || []).find(candidate => candidate.turn === turn);
						setFiles(row ? row.files : []);
					},
					() => { if (current) setFiles([]); },
				);
				return () => { current = false; };
			}, [fsBridge, sessionId, turn]);

			const onRevert = () => {
				if (!fsBridge || !files || files.length === 0) return;
				const list = files.map(file => file.path || "(未知路径)").join("\n");
				if (window.confirm(`撤销第 ${turn} 轮的文件修改？\n${list}`)) {
					fsBridge.apply(sessionId, turn, turn).then(
						() => { setFiles([]); },
						(error) => { console.error("[fs-revert] failed:", error); },
					);
				}
			};

			if (!files || files.length === 0) return null;
			return React.createElement(
				"button",
				{
					type: "button",
					style: {
						fontSize: "11px",
						lineHeight: 1,
						padding: "2px 6px",
						border: "1px solid rgba(229,72,77,.5)",
						borderRadius: "6px",
						background: "transparent",
						color: "#e5484d",
						cursor: "pointer",
					},
					title: "撤销本轮修改的文件",
					onClick: onRevert,
				},
				`撤销修改 (${files.length})`,
			);
		}

		/** The last path segment of an absolute path (handles / and \). */
		function basenameOf(path) {
			const cleaned = String(path).replace(/[\\/]+$/, "");
			const index = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
			return index === -1 ? cleaned : cleaned.slice(index + 1);
		}

		/** The directory part of an absolute path, for the muted sub-line. */
		function dirnameOf(path) {
			const cleaned = String(path).replace(/[\\/]+$/, "");
			const index = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
			return index === -1 ? "" : cleaned.slice(0, index);
		}

		/** Right-side "文件改动" dock (rides the frame-wide shell.overlay seat):
		 *  the current session's pending file changes, top to bottom, each with
		 *  +N (green) / -N (red) line stats, per-file 撤销/保存, and a top-level
		 *  一键撤销 / 一键保存. Only appears while the current session has
		 *  pending changes; auto-opens on first appearance and collapses to a
		 *  small tab. */
		function FileChangesPanel({ useSessions }) {
			const fsChanges = bridge() && window.dshDesktop.fsChanges;
			const sessionId = useSessions ? useSessions(snapshot => snapshot.current) : undefined;
			const [rows, setRows] = useState(null);
			const [open, setOpen] = useState(false);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");

			const refresh = useCallback(() => {
				if (!fsChanges || !sessionId) { setRows(null); return; }
				fsChanges.list(sessionId).then(
					(result) => {
						setRows(result && result.ok === false ? null : (result && Array.isArray(result.rows) ? result.rows : []));
					},
					() => { setRows(null); },
				);
			}, [fsChanges, sessionId]);

			useEffect(() => {
				refresh();
				if (!fsChanges || !sessionId) return undefined;
				const timer = window.setInterval(refresh, 2000);
				return () => window.clearInterval(timer);
			}, [refresh, fsChanges, sessionId]);

			const pending = rows === null ? 0 : rows.length;

			// Auto-open the dock when changes first appear (then let the user
			// collapse it to the tab).
			const hadPending = useRef(false);
			useEffect(() => {
				if (pending > 0 && !hadPending.current) {
					hadPending.current = true;
					setOpen(true);
				}
				if (pending === 0) hadPending.current = false;
			}, [pending]);

			const flash = (text) => {
				setNotice(text);
				window.setTimeout(() => { setNotice(""); }, 3000);
			};

			const act = (promise) => {
				setBusy(true);
				promise.then(
					(result) => {
						if (result && result.ok === false) flash(result.error || "操作失败");
						else refresh();
						setBusy(false);
					},
					(error) => {
						flash(String((error && error.message) || error));
						setBusy(false);
					},
				);
			};

			const revertOne = (row) => { act(fsChanges.revert(sessionId, row.targetKey)); };
			const saveOne = (row) => { act(fsChanges.save(sessionId, row.targetKey)); };
			const revertAll = () => {
				if (!window.confirm(`撤销全部 ${pending} 个文件的修改？`)) return;
				act(fsChanges.revertAll(sessionId));
			};
			const saveAll = () => { act(fsChanges.saveAll(sessionId)); };

			const panelStyle = {
				position: "fixed",
				top: "72px",
				right: "12px",
				width: "340px",
				maxHeight: "calc(100vh - 140px)",
				display: "flex",
				flexDirection: "column",
				boxSizing: "border-box",
				background: "var(--dsw-bg, #ffffff)",
				color: "var(--dsw-text, inherit)",
				border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
				borderRadius: "12px",
				boxShadow: "0 8px 28px rgba(0,0,0,.18)",
				zIndex: 1200,
				overflow: "hidden",
				pointerEvents: "auto",
			};
			const tabStyle = {
				position: "fixed",
				top: "80px",
				right: "0",
				zIndex: 1200,
				fontSize: "12px",
				lineHeight: 1,
				padding: "8px 10px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
				borderRight: "none",
				borderRadius: "10px 0 0 10px",
				background: "var(--dsw-bg, #ffffff)",
				color: "var(--dsw-accent, #4d9fff)",
				cursor: "pointer",
				pointerEvents: "auto",
			};
			const headerStyle = {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "10px 12px",
				borderBottom: "1px solid var(--dsw-border, rgba(128,128,128,.2))",
				flex: "none",
			};
			const headerTitleStyle = { fontWeight: 600, fontSize: "13px", marginRight: "auto", whiteSpace: "nowrap" };
			const dangerButtonStyle = {
				fontSize: "12px",
				lineHeight: 1,
				padding: "4px 10px",
				border: "1px solid rgba(229,72,77,.5)",
				borderRadius: "6px",
				background: "transparent",
				color: "#e5484d",
				cursor: "pointer",
				whiteSpace: "nowrap",
			};
			const okButtonStyle = {
				fontSize: "12px",
				lineHeight: 1,
				padding: "4px 10px",
				border: "1px solid var(--dsw-accent, #4d9fff)",
				borderRadius: "6px",
				background: "transparent",
				color: "var(--dsw-accent, #4d9fff)",
				cursor: "pointer",
				whiteSpace: "nowrap",
			};
			const closeButtonStyle = {
				fontSize: "14px",
				lineHeight: 1,
				padding: "2px 6px",
				border: "none",
				background: "transparent",
				color: "var(--dsw-text-muted, #8b8b93)",
				cursor: "pointer",
			};
			const rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "7px 8px",
				borderBottom: "1px solid var(--dsw-border, rgba(128,128,128,.12))",
			};
			const nameStyle = { flex: "1 1 auto", minWidth: 0, overflow: "hidden" };
			const fileNameStyle = { fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
			const fileDirStyle = { fontSize: "11px", color: "var(--dsw-text-muted, #8b8b93)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
			const statsStyle = { display: "flex", gap: "6px", flex: "none", fontSize: "12px", fontVariantNumeric: "tabular-nums" };
			const addStyle = { color: "#2f9e44", fontWeight: 600 };
			const delStyle = { color: "#e5484d", fontWeight: 600 };
			const smallButtonStyle = {
				fontSize: "11px",
				lineHeight: 1,
				padding: "3px 8px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,.35))",
				borderRadius: "6px",
				background: "transparent",
				color: "var(--dsw-text-muted, #8b8b93)",
				cursor: "pointer",
				whiteSpace: "nowrap",
			};
			const noticeStyle = {
				fontSize: "11px",
				padding: "4px 12px",
				borderBottom: "1px solid var(--dsw-border, rgba(128,128,128,.12))",
				color: "#e5484d",
				flex: "none",
			};

			if (!fsChanges || pending === 0) return null;

			if (!open) {
				return React.createElement(
					"button",
					{ type: "button", style: tabStyle, title: "显示文件改动", onClick: () => setOpen(true) },
					`改动 ${pending}`,
				);
			}

			return React.createElement(
				"div",
				{ style: panelStyle },
				React.createElement(
					"div",
					{ style: headerStyle },
					React.createElement("span", { style: headerTitleStyle }, `文件改动 (${pending})`),
					React.createElement("button", {
						type: "button",
						style: dangerButtonStyle,
						disabled: busy,
						title: "把全部文件还原到改动前的状态",
						onClick: revertAll,
					}, "一键撤销"),
					React.createElement("button", {
						type: "button",
						style: okButtonStyle,
						disabled: busy,
						title: "保留全部改动（移出待处理列表）",
						onClick: saveAll,
					}, "一键保存"),
					React.createElement("button", {
						type: "button",
						style: closeButtonStyle,
						title: "收起",
						onClick: () => setOpen(false),
					}, "×"),
				),
				notice !== ""
					? React.createElement("div", { style: noticeStyle }, notice)
					: null,
				React.createElement(
					"div",
					{ style: { flex: "1 1 auto", overflowY: "auto", padding: "4px 6px" } },
					rows.map((row) => {
						const name = basenameOf(row.path);
						const dir = dirnameOf(row.path);
						return React.createElement(
							"div",
							{ key: row.targetKey, style: rowStyle, title: row.path },
							React.createElement(
								"div",
								{ style: nameStyle },
								React.createElement("div", { style: fileNameStyle }, name),
								React.createElement("div", { style: fileDirStyle }, dir),
							),
							React.createElement(
								"div",
								{ style: statsStyle },
								row.additions > 0
									? React.createElement("span", { style: addStyle }, `+${row.additions}`)
									: null,
								row.deletions > 0
									? React.createElement("span", { style: delStyle }, `-${row.deletions}`)
									: null,
							),
							React.createElement("button", {
								type: "button",
								style: smallButtonStyle,
								disabled: busy,
								title: "还原此文件到改动前的状态",
								onClick: () => revertOne(row),
							}, "撤销"),
							React.createElement("button", {
								type: "button",
								style: { ...smallButtonStyle, color: "var(--dsw-accent, #4d9fff)" },
								disabled: busy,
								title: "保留此文件的改动（移出待处理列表）",
								onClick: () => saveOne(row),
							}, "保存"),
						);
					}),
				),
			);
		}

		/** Register the manager tab and the compaction threshold control. */
		function apply(ctx) {
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: TAB_ID,
				order: 20,
				label: "自定义插件",
			}, DesktopPluginsTab));

			// Composer tool row, right beside the access-mode (Full access) chrome.
			// The control reads/writes the compaction threshold through the
			// window.dshDesktop.settings preload bridge (the namespace is not part
			// of the web configuration boundary).
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "compaction-threshold",
				order: 10,
			}, CompactionThresholdControl));

			// Per-turn file revert rides the turn-tail chain.
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: "fs-revert",
				priority: 20,
				select: () => true,
			}, TurnRevertAction));

			// Right-side file-changes dock: the frame-wide shell.overlay seat is
			// a root-scope additive list — a fresh id joins beside the shipped
			// entries instead of replacing anything. The panel reads the current
			// session through the global useSessions hook and drives the
			// window.dshDesktop.fsChanges preload bridge.
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "fs-changes",
				order: 20,
			}, FileChangesPanel));

			// Cursor-style inline edit on user messages: override the shipped
			// 'user'/'steering' bubble renderer (lower priority wins the keyed
			// seat) with a click-to-edit bubble and in-place editor. Blur commits
			// the edit through the window.dshDesktop.conversationEdit preload
			// bridge (surface replacement in the SAME session); 发送 rewinds via
			// sessions.fork + workspaces.archiveSession and resends, so the old
			// reply is removed without a visible new dialog.
			const nodeFace = () => ({ sessions: ctx.sessions, workspaces: ctx.workspaces });
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "user",
				priority: -10,
				inject: nodeFace,
			}, UserMessageEditNode));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "steering",
				priority: -10,
				inject: nodeFace,
			}, UserMessageEditNode));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
