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
import * as jsxRuntime from "react/jsx-runtime";
/**
 * dsh-loader 的 UI 套件。
 *
 * 取 `@dsh-plugin/dsh-loader/client`：DSH 客户端模块表在查表前只剥掉
 * `/client` 后缀，于是该 specifier 直接命中 dsh-loader 已注册的工厂并递归物化，
 * 顺序安全且无需别名。图标改用 loader 的策划集（`Icon` + 意图命名），
 * 不再依赖 `@deepseek-ai/dsh-client-ui-primitives` 的具体图标导出名。
 * 该模块在产物中保持 external，经构建壳的 `require` 取共享实例。
 */
import * as loaderUi from "@dsh-plugin/dsh-loader/client";

const ui = loaderUi as unknown as {
  Icon: import("react").FC<{ name: string; size?: number }>;
};

// ------------------------------------------------------------------
// Styles: a codex-style shimmer ("流光") progress row, reusing the same
// visual language as the built-in TurnStatus (linear-gradient text with
// a 1.8s sweep) inside the same compact row geometry as tool calls.
// ------------------------------------------------------------------
const STYLE_ID = "@dsh-plugin/dsh-approve-for-me/ApprovalStatusBar.module.css";
const css =
  ".afmRoot{align-items:center;min-width:0;height:24px;display:flex}" +
  ".afmLeading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex}" +
  ".afmTitle{color:var(--dsw-alias-label-secondary);flex:none;font-size:14px;line-height:24px}" +
  ".afmSep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}" +
  ".afmSummary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}" +
  ".afmSummary[data-outcome=rejected]{color:#BA1A1A}" +
  ".afmShimmer{color:#0000;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);background-size:250% 100%;background-position:100% 0;-webkit-background-clip:text;background-clip:text;animation:1.8s linear infinite afmShimmerSweep}" +
  "@keyframes afmShimmerSweep{to{background-position:0 0}}" +
  "@media (prefers-reduced-motion:reduce){.afmShimmer{background-position:0 0;background-size:100% 100%;animation:none}}";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@dsh-plugin/dsh-approve-for-me";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

// ------------------------------------------------------------------
// Verdict copy, mirroring the host plugin's notices.
// ------------------------------------------------------------------
function verdictLabel(flow: string, outcome: string): string {
  if (flow === "strict") {
    switch (outcome) {
      case "allowed":
        return "审查已通过";
      case "rejected":
        return "审查已拒绝";
      case "ask":
        return "审查已转交人工";
      case "cancelled":
        return "审查已取消";
      default:
        return "审查已结算";
    }
  }
  switch (outcome) {
    case "allowed-once":
      return "已批准权限升级";
    case "rejected":
      return "已拒绝权限升级";
    case "cancelled":
      return "审批已取消";
    case "unavailable":
      return "审批不可用（fail-closed）";
    default:
      return "审批已结算";
  }
}

function toolTitle(toolName: string): string {
  return toolName === "pwsh" ? "Pwsh" : toolName;
}

/** The data shape of one durable approval-status chat node. */
interface ApprovalStatusData {
  flow: "strict" | "approval";
  toolName: string;
  startedAt: number;
  outcome: string | null;
  review: { riskLevel?: string; userAuthorization?: string; rationale?: string } | null;
}

interface ApprovalStatusNodeProps {
  node?: { data?: ApprovalStatusData } | null;
}

/**
 * Durable view over one approval audit pair. The conversation event engine
 * recreates this node from `approval/asked` and `approval/decided` whenever
 * a session is opened, so a settled verdict remains in the chat flow.
 */
function ApprovalStatusNode(props: ApprovalStatusNodeProps) {
  if (props.node === undefined || props.node === null || props.node.data === undefined) return null;
  const status = props.node.data;
  const pending = status.outcome === null;
  const flow = status.flow === "strict" ? "strict" : "approval";
  const reviewText =
    !pending && status.review !== null && status.review !== undefined
      ? status.review.rationale ?? null
      : null;
  const summaryText = pending
    ? flow === "strict"
      ? "正在审查工具调用"
      : "正在审查权限请求"
    : verdictLabel(flow, status.outcome ?? "") + (reviewText === null ? "" : " · " + reviewText);

  return jsxRuntime.jsxs("div", {
    className: "afmRoot",
    "data-approve-for-me": pending ? "reviewing" : "verdict",
    children: [
      jsxRuntime.jsx("span", {
        className: "afmLeading",
        children: jsxRuntime.jsx(ui.Icon, { name: "Config", size: 14 }),
      }),
      jsxRuntime.jsx("span", { className: "afmTitle", children: toolTitle(status.toolName) }),
      jsxRuntime.jsx("span", { className: "afmSep", "aria-hidden": true }),
      jsxRuntime.jsx("span", {
        className: pending ? "afmSummary afmShimmer" : "afmSummary",
        "data-outcome": status.outcome,
        children: summaryText,
      }),
    ],
  });
}

// ------------------------------------------------------------------
// Plugin: turn each approval audit pair into a replayable chat-flow node.
// ------------------------------------------------------------------
interface FlowEvent {
  type: string;
  time?: number;
  seq?: number;
  data?: {
    id?: string;
    approvalId?: string;
    callId?: string;
    toolName?: string;
    outcome?: string;
    hook?: string;
    riskLevel?: string;
    userAuthorization?: string;
    rationale?: string;
    [key: string]: unknown;
  };
}

interface MatchResult {
  id: string;
  role: "start" | "update";
}

interface DefinitionContext {
  state?: ApprovalStatusData;
  start?: { event: FlowEvent; location?: unknown };
  key?: string;
  id?: string;
}

interface ViewNode {
  key?: string;
  kind: string;
  id?: string;
  target: "chat";
  anchorSeq?: number;
  location?: unknown;
  visibility: "visible";
  data: ApprovalStatusData;
}

const APPROVAL_STATUS_KIND = "approval-status";
const approvalStatusDefinition = {
  kind: APPROVAL_STATUS_KIND,
  target: "chat" as const,
  match(event: FlowEvent): MatchResult | null {
    if (event.type === "approval/asked") {
      return { id: String(event.data?.id), role: "start" as const };
    }
    if (event.type === "approval/decided") {
      return { id: String(event.data?.id), role: "update" as const };
    }
    if (event.type === "hook/result" && event.data?.hook === "approve-for-me/review") {
      return { id: String(event.data?.approvalId), role: "update" as const };
    }
    if (event.type === "hook/invoked" && event.data?.hook === "approve-for-me/strict-review") {
      return { id: "strict:" + String(event.data?.callId), role: "start" as const };
    }
    if (event.type === "hook/result" && event.data?.hook === "approve-for-me/strict-review") {
      return { id: "strict:" + String(event.data?.callId), role: "update" as const };
    }
    return null;
  },
  start(_context: DefinitionContext, match: { event: FlowEvent }): ApprovalStatusData {
    if (match.event.type === "hook/invoked") {
      return {
        flow: "strict",
        toolName: match.event.data?.toolName ?? "",
        startedAt: match.event.time ?? 0,
        outcome: null,
        review: null,
      };
    }
    if (match.event.type !== "approval/asked") {
      throw new Error("approval-status start requires an approval or strict-review event");
    }
    return {
      flow: "approval",
      toolName: match.event.data?.toolName ?? "",
      startedAt: match.event.time ?? 0,
      outcome: null,
      review: null,
    };
  },
  update(context: DefinitionContext, match: { event: FlowEvent }): ApprovalStatusData {
    const state = context.state ?? {
      flow: "approval" as const,
      toolName: "",
      startedAt: 0,
      outcome: null,
      review: null,
    };
    if (match.event.type === "hook/result" && match.event.data?.hook === "approve-for-me/strict-review") {
      return {
        flow: "strict",
        toolName: state.toolName,
        startedAt: state.startedAt,
        outcome: match.event.data?.outcome ?? null,
        review: {
          riskLevel: match.event.data?.riskLevel,
          userAuthorization: match.event.data?.userAuthorization,
          rationale: match.event.data?.rationale,
        },
      };
    }
    if (match.event.type === "hook/result" && match.event.data?.hook === "approve-for-me/review") {
      return {
        flow: "approval",
        toolName: state.toolName,
        startedAt: state.startedAt,
        outcome: state.outcome,
        review: {
          riskLevel: match.event.data?.riskLevel,
          userAuthorization: match.event.data?.userAuthorization,
          rationale: match.event.data?.rationale,
        },
      };
    }
    if (match.event.type !== "approval/decided") return state;
    return {
      flow: "approval",
      toolName: state.toolName,
      startedAt: state.startedAt,
      outcome: match.event.data?.outcome ?? null,
      review: state.review,
    };
  },
  buildViewNode(context: DefinitionContext): ViewNode | null {
    if (context.start === undefined || context.state === undefined) return null;
    return {
      key: context.key,
      kind: APPROVAL_STATUS_KIND,
      id: context.id,
      target: "chat",
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: "visible",
      data: context.state,
    };
  },
};

/** Minimal cordis-shaped browser context. */
interface ClientContext {
  conversationEvents: { register(definition: unknown): unknown };
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(options: unknown, component: unknown): unknown;
  };
}

/** cordis client-plugin name — must equal the package name. */
export const name = "@dsh-plugin/dsh-approve-for-me";

/** Browser-half cordis services this plugin consumes. */
export const inject = ["conversationEvents", "slots"];

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(approvalStatusDefinition);
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register(
      {
        name: "conversation.chat.node",
        key: APPROVAL_STATUS_KIND,
      },
      ApprovalStatusNode,
    ),
  );
}
