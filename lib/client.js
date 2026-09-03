window.__ModuleLoader__.load({
	id: "@dsh-plugin/dsh-approve-for-me",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react_jsx_runtime = require("react/jsx-runtime");
		react_jsx_runtime = __toESM(react_jsx_runtime, 1);
		let _dsh_plugin_dsh_loader_client = require("@dsh-plugin/dsh-loader/client");
		_dsh_plugin_dsh_loader_client = __toESM(_dsh_plugin_dsh_loader_client, 1);
		//#region src/client.ts
		/**
		* @dsh-plugin/dsh-approve-for-me — BROWSER half.
		*
		* Renders a codex-style auto-review status bar (shimmer progress → verdict)
		* in the Web GUI conversation stream, driven by `approval/asked` +
		* `approval/decided` audit events plus the host plugin's log-only
		* `hook/invoked` + `hook/result` rows for Strict Mode.
		*
		* The source stays plain ESM; the build (tsdown, tsdown.client.config.mjs)
		* wraps the emitted CJS into the web profile's `__ModuleLoader__.load`
		* protocol shell. ESM module scope also keeps every declaration off the
		* shared `window` global — no top-level `const` leaks, no IIFE needed.
		*/
		/**
		* dsh-loader 的 UI 套件。
		*
		* 取 `@dsh-plugin/dsh-loader/client`：DSH 客户端模块表在查表前只剥掉
		* `/client` 后缀，于是该 specifier 直接命中 dsh-loader 已注册的工厂并递归物化，
		* 顺序安全且无需别名。图标改用 loader 的策划集（`Icon` + 意图命名），
		* 不再依赖 `@deepseek-ai/dsh-client-ui-primitives` 的具体图标导出名。
		* 该模块在产物中保持 external，经构建壳的 `require` 取共享实例。
		*/
		const ui = _dsh_plugin_dsh_loader_client;
		const STYLE_ID = "@dsh-plugin/dsh-approve-for-me/ApprovalStatusBar.module.css";
		const css = ".afmRoot{align-items:center;min-width:0;height:24px;display:flex}.afmLeading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex}.afmTitle{color:var(--dsw-alias-label-secondary);flex:none;font-size:14px;line-height:24px}.afmSep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.afmSummary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}.afmSummary[data-outcome=rejected]{color:#BA1A1A}.afmShimmer{color:#0000;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);background-size:250% 100%;background-position:100% 0;-webkit-background-clip:text;background-clip:text;animation:1.8s linear infinite afmShimmerSweep}@keyframes afmShimmerSweep{to{background-position:0 0}}@media (prefers-reduced-motion:reduce){.afmShimmer{background-position:0 0;background-size:100% 100%;animation:none}}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugin/dsh-approve-for-me";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		function verdictLabel(flow, outcome) {
			if (flow === "strict") switch (outcome) {
				case "allowed": return "审查已通过";
				case "rejected": return "审查已拒绝";
				case "ask": return "审查已转交人工";
				case "cancelled": return "审查已取消";
				default: return "审查已结算";
			}
			switch (outcome) {
				case "allowed-once": return "已批准权限升级";
				case "rejected": return "已拒绝权限升级";
				case "cancelled": return "审批已取消";
				case "unavailable": return "审批不可用（fail-closed）";
				default: return "审批已结算";
			}
		}
		function toolTitle(toolName) {
			return toolName === "pwsh" ? "Pwsh" : toolName;
		}
		/**
		* Durable view over one approval audit pair. The conversation event engine
		* recreates this node from `approval/asked` and `approval/decided` whenever
		* a session is opened, so a settled verdict remains in the chat flow.
		*/
		function ApprovalStatusNode(props) {
			if (props.node === void 0 || props.node === null || props.node.data === void 0) return null;
			const status = props.node.data;
			const pending = status.outcome === null;
			const flow = status.flow === "strict" ? "strict" : "approval";
			const reviewText = !pending && status.review !== null && status.review !== void 0 ? status.review.rationale ?? null : null;
			const summaryText = pending ? flow === "strict" ? "正在审查工具调用" : "正在审查权限请求" : verdictLabel(flow, status.outcome ?? "") + (reviewText === null ? "" : " · " + reviewText);
			return react_jsx_runtime.jsxs("div", {
				className: "afmRoot",
				"data-approve-for-me": pending ? "reviewing" : "verdict",
				children: [
					react_jsx_runtime.jsx("span", {
						className: "afmLeading",
						children: react_jsx_runtime.jsx(ui.Icon, {
							name: "Config",
							size: 14
						})
					}),
					react_jsx_runtime.jsx("span", {
						className: "afmTitle",
						children: toolTitle(status.toolName)
					}),
					react_jsx_runtime.jsx("span", {
						className: "afmSep",
						"aria-hidden": true
					}),
					react_jsx_runtime.jsx("span", {
						className: pending ? "afmSummary afmShimmer" : "afmSummary",
						"data-outcome": status.outcome,
						children: summaryText
					})
				]
			});
		}
		const APPROVAL_STATUS_KIND = "approval-status";
		const approvalStatusDefinition = {
			kind: APPROVAL_STATUS_KIND,
			target: "chat",
			match(event) {
				if (event.type === "approval/asked") return {
					id: String(event.data?.id),
					role: "start"
				};
				if (event.type === "approval/decided") return {
					id: String(event.data?.id),
					role: "update"
				};
				if (event.type === "hook/result" && event.data?.hook === "approve-for-me/review") return {
					id: String(event.data?.approvalId),
					role: "update"
				};
				if (event.type === "hook/invoked" && event.data?.hook === "approve-for-me/strict-review") return {
					id: "strict:" + String(event.data?.callId),
					role: "start"
				};
				if (event.type === "hook/result" && event.data?.hook === "approve-for-me/strict-review") return {
					id: "strict:" + String(event.data?.callId),
					role: "update"
				};
				return null;
			},
			start(_context, match) {
				if (match.event.type === "hook/invoked") return {
					flow: "strict",
					toolName: match.event.data?.toolName ?? "",
					startedAt: match.event.time ?? 0,
					outcome: null,
					review: null
				};
				if (match.event.type !== "approval/asked") throw new Error("approval-status start requires an approval or strict-review event");
				return {
					flow: "approval",
					toolName: match.event.data?.toolName ?? "",
					startedAt: match.event.time ?? 0,
					outcome: null,
					review: null
				};
			},
			update(context, match) {
				const state = context.state ?? {
					flow: "approval",
					toolName: "",
					startedAt: 0,
					outcome: null,
					review: null
				};
				if (match.event.type === "hook/result" && match.event.data?.hook === "approve-for-me/strict-review") return {
					flow: "strict",
					toolName: state.toolName,
					startedAt: state.startedAt,
					outcome: match.event.data?.outcome ?? null,
					review: {
						riskLevel: match.event.data?.riskLevel,
						userAuthorization: match.event.data?.userAuthorization,
						rationale: match.event.data?.rationale
					}
				};
				if (match.event.type === "hook/result" && match.event.data?.hook === "approve-for-me/review") return {
					flow: "approval",
					toolName: state.toolName,
					startedAt: state.startedAt,
					outcome: state.outcome,
					review: {
						riskLevel: match.event.data?.riskLevel,
						userAuthorization: match.event.data?.userAuthorization,
						rationale: match.event.data?.rationale
					}
				};
				if (match.event.type !== "approval/decided") return state;
				return {
					flow: "approval",
					toolName: state.toolName,
					startedAt: state.startedAt,
					outcome: match.event.data?.outcome ?? null,
					review: state.review
				};
			},
			buildViewNode(context) {
				if (context.start === void 0 || context.state === void 0) return null;
				return {
					key: context.key,
					kind: APPROVAL_STATUS_KIND,
					id: context.id,
					target: "chat",
					anchorSeq: context.start.event.seq,
					location: context.start.location,
					visibility: "visible",
					data: context.state
				};
			}
		};
		/** cordis client-plugin name — must equal the package name. */
		const name = "@dsh-plugin/dsh-approve-for-me";
		/** Browser-half cordis services this plugin consumes. */
		const inject = ["conversationEvents", "slots"];
		function apply(ctx) {
			ctx.conversationEvents.register(approvalStatusDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: APPROVAL_STATUS_KIND
			}, ApprovalStatusNode));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map