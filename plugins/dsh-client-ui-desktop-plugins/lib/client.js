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
		const inject = ["slots"];

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
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
