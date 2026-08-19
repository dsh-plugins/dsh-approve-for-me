/**
 * @dsh-plugin/dsh-approve-for-me
 *
 * Codex-like auto-approval for run commands, plus an "Approve For Me"
 * (替我同意) option in the sandbox permission choices.
 *
 * What this plugin wires up:
 *
 * 1. An `approval/request` ANSWERER (prepended, so it runs before the UI
 *    answerer) with codex-like modes:
 *    - `off` (default)  — delegate everything to the normal chain (UI).
 *    - `auto`           — approve requests matching `approve` patterns and
 *      reject requests matching `deny` patterns (matched against the tool
 *      name, the approval reason, and the actual command text recovered from
 *      the session log); everything else delegates.
 *    - `full-auto`      — approve every approval prompt.
 *    - `never`          — reject every approval prompt (CI / unattended).
 *    - `review`         — a LIGHTWEIGHT REVIEWER MODEL decides each prompt
 *      (the codex "guardian" design: compact transcript + planned action +
 *      fixed security policy, strict JSON verdict, fail closed on timeout /
 *      transport failure / malformed output, and a per-turn denial circuit
 *      breaker that hands control back to the human when the reviewer keeps
 *      denying). This is the real "替我同意": a cheap model approves on the
 *      user's behalf instead of a human clicking through every prompt.
 *    A session that selected the `approve-for-me` permission preset (the
 *    user's "替我同意" switch in the Web GUI / `/permission`) is treated as
 *    `full-auto` under the rule-based modes.
 *
 * 2. The `approve-for-me` SANDBOX PERMISSION OPTION:
 *    - `approve-for-me` is appended to `ESCALATION_TARGETS`, so every
 *      escalation tool that loads after this plugin advertises it;
 *    - already-registered `pwsh` / `bash` / `fs` (and any future escalation)
 *      tool definitions are patched in place: the `sandbox_permissions` enum
 *      gains `approve-for-me`, the description documents it, and `execute` is
 *      wrapped so that a call with `sandbox_permissions: "approve-for-me"`
 *      is translated into a real escalation to the configured `grantMode`
 *      (default `danger-full-access`) with a `[approve-for-me]` marker in the
 *      justification. The original tool then runs its normal, fail-closed
 *      escalation path against a REAL mode; the answerer sees the marker and
 *      auto-approves. No sandbox backend ever receives a fake mode.
 *    - The tool patches are re-applied on every `tools/change`, so load order
 *      between this plugin and the tool plugins does not matter.
 *
 * 3. A permission PRESET named `approve-for-me` registered into the
 *    `permissionPresets` service's live table, so the Web GUI's sandbox
 *    permission selector (and the `/permission` command) offer it.
 *
 * 4. A SYSTEM-PROMPT section stating the effective auto-approval mode.
 *
 * Security notes:
 * - `mode: "never"` wins over everything (deployment policy, fail-closed).
 * - `approve-for-me` still requires a `justification`; the original tool's
 *   strict-widening and approval machinery are untouched.
 * - This plugin only auto-resolves APPROVAL decisions; it never widens a
 *   sandbox mode itself — every grant still flows through the stock
 *   `approveEscalation` path, just with the human step answered for them
 *   (by rules, by blanket approval, or by a lightweight reviewer model).
 */
import z from "@deepseek-ai/schemastery";
import { type GrantMode, type Mode } from "./policy.js";
export declare const name = "@dsh-plugin/dsh-approve-for-me";
export declare const inject: string[];
/** Plugin config — all optional; `z` defaults supply the standing values. */
export declare const Config: z<Schemastery.ObjectS<{
    /**
     * Codex-like auto-approval mode:
     * - `off` (default): delegate every approval prompt to the user (UI).
     * - `auto`: approve `approve` matches, reject `deny` matches, delegate the rest.
     * - `full-auto`: approve every approval prompt.
     * - `never`: reject every approval prompt.
     * - `review`: a lightweight reviewer model decides each prompt (see the
     *   `review*` options). Fail-closed to `reviewFallback` on any failure.
     * A session running the `approve-for-me` permission preset behaves like
     * `full-auto` under the rule-based modes (the user's explicit 替我同意 choice).
     */
    mode: z<"off" | "auto" | "full-auto" | "never" | "review", "off" | "auto" | "full-auto" | "never" | "review">;
    /** Regex sources matched (case-insensitive) in `auto` mode against tool name + reason + command text. */
    approve: z<string[], string[]>;
    /** Regex sources that force a rejection in `auto` mode; deny wins over approve. */
    deny: z<string[], string[]>;
    /** The real sandbox mode granted when the model passes `sandbox_permissions: "approve-for-me"`. */
    grantMode: z<"workspace-write" | "danger-full-access", "workspace-write" | "danger-full-access">;
    /** The permission-preset key registered into `permissionPresets` and folded per session. */
    presetName: z<string, string>;
    /** The sandbox baseline selected by `approve-for-me`; escalations must stay strictly wider than this mode. */
    presetSandbox: z<"workspace-write" | "danger-full-access", "workspace-write" | "danger-full-access">;
    /** The approval-policy knob the preset records (`ask` keeps the model-facing "ask" sentence; the answerer auto-approves anyway). */
    presetApproval: z<"never" | "ask", "never" | "ask">;
    /** The permission-preset key that enables review before every tool call. */
    strictPresetName: z<string, string>;
    /** The sandbox baseline selected by the Strict Mode preset. */
    strictPresetSandbox: z<"workspace-write" | "danger-full-access", "workspace-write" | "danger-full-access">;
    /** The approval-policy knob recorded by the Strict Mode preset. */
    strictPresetApproval: z<"never" | "ask", "never" | "ask">;
    /** Provider route for the reviewer; falls back to the requesting agent's provider. */
    reviewProvider: z<string, string>;
    /** Model id for the reviewer; falls back to the requesting agent's model. Prefer a cheap/fast model. */
    reviewModel: z<string, string>;
    /** Extra deployment rules injected into the reviewer's security policy (`{{ policy }}` slot). */
    reviewPolicy: z<string, string>;
    /** Per-review attempt timeout in milliseconds. */
    reviewTimeoutMs: z<number, number>;
    /** How many attempts at a parseable verdict before failing closed. */
    reviewMaxAttempts: z<number, number>;
    /** What to do when the reviewer fails/times out: `deny` (fail closed, default) or `ask` (hand to the human). */
    reviewFallback: z<"deny" | "ask", "deny" | "ask">;
    /** Consecutive reviewer denials in one turn that trip the circuit breaker (control returns to the human). */
    reviewCircuitMaxConsecutive: z<number, number>;
    /** Reviewer denials within the recent window that trip the circuit breaker. */
    reviewCircuitMaxRecent: z<number, number>;
    /** Queue one terminal review verdict for the next model step. Disabled by default because inbox notices are not live UI status. */
    reviewNotify: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    /**
     * Codex-like auto-approval mode:
     * - `off` (default): delegate every approval prompt to the user (UI).
     * - `auto`: approve `approve` matches, reject `deny` matches, delegate the rest.
     * - `full-auto`: approve every approval prompt.
     * - `never`: reject every approval prompt.
     * - `review`: a lightweight reviewer model decides each prompt (see the
     *   `review*` options). Fail-closed to `reviewFallback` on any failure.
     * A session running the `approve-for-me` permission preset behaves like
     * `full-auto` under the rule-based modes (the user's explicit 替我同意 choice).
     */
    mode: z<"off" | "auto" | "full-auto" | "never" | "review", "off" | "auto" | "full-auto" | "never" | "review">;
    /** Regex sources matched (case-insensitive) in `auto` mode against tool name + reason + command text. */
    approve: z<string[], string[]>;
    /** Regex sources that force a rejection in `auto` mode; deny wins over approve. */
    deny: z<string[], string[]>;
    /** The real sandbox mode granted when the model passes `sandbox_permissions: "approve-for-me"`. */
    grantMode: z<"workspace-write" | "danger-full-access", "workspace-write" | "danger-full-access">;
    /** The permission-preset key registered into `permissionPresets` and folded per session. */
    presetName: z<string, string>;
    /** The sandbox baseline selected by `approve-for-me`; escalations must stay strictly wider than this mode. */
    presetSandbox: z<"workspace-write" | "danger-full-access", "workspace-write" | "danger-full-access">;
    /** The approval-policy knob the preset records (`ask` keeps the model-facing "ask" sentence; the answerer auto-approves anyway). */
    presetApproval: z<"never" | "ask", "never" | "ask">;
    /** The permission-preset key that enables review before every tool call. */
    strictPresetName: z<string, string>;
    /** The sandbox baseline selected by the Strict Mode preset. */
    strictPresetSandbox: z<"workspace-write" | "danger-full-access", "workspace-write" | "danger-full-access">;
    /** The approval-policy knob recorded by the Strict Mode preset. */
    strictPresetApproval: z<"never" | "ask", "never" | "ask">;
    /** Provider route for the reviewer; falls back to the requesting agent's provider. */
    reviewProvider: z<string, string>;
    /** Model id for the reviewer; falls back to the requesting agent's model. Prefer a cheap/fast model. */
    reviewModel: z<string, string>;
    /** Extra deployment rules injected into the reviewer's security policy (`{{ policy }}` slot). */
    reviewPolicy: z<string, string>;
    /** Per-review attempt timeout in milliseconds. */
    reviewTimeoutMs: z<number, number>;
    /** How many attempts at a parseable verdict before failing closed. */
    reviewMaxAttempts: z<number, number>;
    /** What to do when the reviewer fails/times out: `deny` (fail closed, default) or `ask` (hand to the human). */
    reviewFallback: z<"deny" | "ask", "deny" | "ask">;
    /** Consecutive reviewer denials in one turn that trip the circuit breaker (control returns to the human). */
    reviewCircuitMaxConsecutive: z<number, number>;
    /** Reviewer denials within the recent window that trip the circuit breaker. */
    reviewCircuitMaxRecent: z<number, number>;
    /** Queue one terminal review verdict for the next model step. Disabled by default because inbox notices are not live UI status. */
    reviewNotify: z<boolean, boolean>;
}>>;
/** Type of the plugin's runtime config (all keys optional; defaults applied by {@link Config}). */
export interface ApproveForMeConfig {
    mode?: Mode;
    approve?: string[];
    deny?: string[];
    grantMode?: GrantMode;
    presetName?: string;
    presetSandbox?: GrantMode;
    presetApproval?: "ask" | "never";
    strictPresetName?: string;
    strictPresetSandbox?: GrantMode;
    strictPresetApproval?: "ask" | "never";
    reviewProvider?: string;
    reviewModel?: string;
    reviewPolicy?: string;
    reviewTimeoutMs?: number;
    reviewMaxAttempts?: number;
    reviewFallback?: "deny" | "ask";
    reviewCircuitMaxConsecutive?: number;
    reviewCircuitMaxRecent?: number;
    reviewNotify?: boolean;
}
/** The sandbox-permission spec embedded in escalation tool parameters. */
interface SandboxPermissionSpec {
    enum?: string[];
    description?: string;
    [key: string]: unknown;
}
/** A live `ToolDefinition` as held by the tools registry. */
interface ToolDefinition {
    name?: string;
    parameters?: {
        sandbox_permissions?: SandboxPermissionSpec;
    };
    execute?: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>;
    [key: string | symbol]: unknown;
}
/** A minimal view of one session event. */
export interface SessionEvent {
    type: string;
    time?: number;
    seq?: number;
    data?: any;
}
/** A minimal view of the DSH session. */
export interface Session {
    id?: string;
    header: {
        id?: string;
    };
    events: SessionEvent[];
    append(type: string, data: unknown, opts?: unknown): unknown;
}
/** A minimal view of the DSH agent. */
export interface Agent {
    id?: string;
    status?: string;
    session: Session;
    agentOptions?: Record<string, unknown>;
    inject?(message: unknown): void;
}
/** One approval request handed to the answerer chain. */
export interface ApprovalRequest {
    agent: Agent;
    toolName: string;
    callId?: string;
    reason?: string;
    justification?: string;
    arguments?: unknown;
    signal?: AbortSignal;
}
/** The `tools/pre-execute` execution context. */
export interface ToolExec {
    agent?: Agent;
    name: string;
    callId?: string;
    arguments?: Record<string, unknown>;
    signal?: AbortSignal;
    rootCallId?: string;
    id?: string;
}
/** The `ctx.llm.stream` chunk shape the reviewer consumes. */
interface LlmTextDelta {
    type: string;
    text?: string;
}
/** The lightweight reviewer model service surface (`ctx.llm`). */
interface LlmService {
    stream(options: {
        provider: string;
        model: string;
        system: string;
        messages: unknown[];
        signal?: AbortSignal;
        temperature?: number;
    }): AsyncIterable<LlmTextDelta>;
}
/**
 * Minimal cordis-shaped context covering everything `apply()` touches. DSH
 * services (`tools`, `llm`, `systemPrompt`, `permissionPresets`) are not
 * publicly typed, so they are declared at the boundary and read with `get()`.
 */
export interface PluginContext {
    get<T = unknown>(service: string): T | undefined;
    on(event: string, listener: (...args: any[]) => any, options?: Record<string, unknown>): void;
    inject(services: readonly string[], callback: (scope: any) => void): void;
    emit(event: string, ...args: unknown[]): void;
    logger: {
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
    };
    tools?: {
        layers?: {
            global?: {
                tools?: Map<string, ToolDefinition>;
            };
        };
    };
    llm?: LlmService;
    systemPrompt?: unknown;
    [key: string]: unknown;
}
export declare function apply(ctx: PluginContext, config?: ApproveForMeConfig): void;
export {};
