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
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { ESCALATION_TARGETS } from "@deepseek-ai/dsh-sandbox";
import { effectivePermissionPreset } from "@deepseek-ai/dsh-permission-presets";
import { APPROVE_FOR_ME_MARKER, APPROVE_FOR_ME_MODE, GRANT_MODES, MODES, buildReviewAction, collectReviewTranscript, compilePatterns, createDenialTracker, decideApproval, isApproveForMeRequest, parseGuardianAssessment, renderReviewSystemPrompt, renderReviewUserPrompt, rewriteApproveForMe, } from "./policy.js";
export const name = "@dsh-plugin/dsh-approve-for-me";
export const inject = ["tools", "systemPrompt"];
// `hook/*` are known log-only DSH events, which lets plugin display metadata
// survive reload in a harness that does not have plugin event registration.
const REVIEW_HOOK = "approve-for-me/review";
const STRICT_REVIEW_HOOK = "approve-for-me/strict-review";
/** Plugin config — all optional; `z` defaults supply the standing values. */
export const Config = z.object({
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
    mode: z.union(MODES).default("off"),
    /** Regex sources matched (case-insensitive) in `auto` mode against tool name + reason + command text. */
    approve: z.array(z.string()).default([]),
    /** Regex sources that force a rejection in `auto` mode; deny wins over approve. */
    deny: z.array(z.string()).default([]),
    /** The real sandbox mode granted when the model passes `sandbox_permissions: "approve-for-me"`. */
    grantMode: z.union(GRANT_MODES).default("danger-full-access"),
    /** The permission-preset key registered into `permissionPresets` and folded per session. */
    presetName: z.string().default("approve-for-me"),
    /** The sandbox baseline selected by `approve-for-me`; escalations must stay strictly wider than this mode. */
    presetSandbox: z.union(GRANT_MODES).default("workspace-write"),
    /** The approval-policy knob the preset records (`ask` keeps the model-facing "ask" sentence; the answerer auto-approves anyway). */
    presetApproval: z.union(["ask", "never"]).default("ask"),
    /** The permission-preset key that enables review before every tool call. */
    strictPresetName: z.string().default("strict-review"),
    /** The sandbox baseline selected by the Strict Mode preset. */
    strictPresetSandbox: z.union(GRANT_MODES).default("workspace-write"),
    /** The approval-policy knob recorded by the Strict Mode preset. */
    strictPresetApproval: z.union(["ask", "never"]).default("ask"),
    // Review mode (lightweight reviewer model).
    /** Provider route for the reviewer; falls back to the requesting agent's provider. */
    reviewProvider: z.string(),
    /** Model id for the reviewer; falls back to the requesting agent's model. Prefer a cheap/fast model. */
    reviewModel: z.string(),
    /** Extra deployment rules injected into the reviewer's security policy (`{{ policy }}` slot). */
    reviewPolicy: z.string().default(""),
    /** Per-review attempt timeout in milliseconds. */
    reviewTimeoutMs: z.natural().default(30000),
    /** How many attempts at a parseable verdict before failing closed. */
    reviewMaxAttempts: z.natural().min(1).default(2),
    /** What to do when the reviewer fails/times out: `deny` (fail closed, default) or `ask` (hand to the human). */
    reviewFallback: z.union(["deny", "ask"]).default("deny"),
    /** Consecutive reviewer denials in one turn that trip the circuit breaker (control returns to the human). */
    reviewCircuitMaxConsecutive: z.natural().default(3),
    /** Reviewer denials within the recent window that trip the circuit breaker. */
    reviewCircuitMaxRecent: z.natural().default(10),
    /** Queue one terminal review verdict for the next model step. Disabled by default because inbox notices are not live UI status. */
    reviewNotify: z.boolean().default(false),
});
/** Marker used to avoid double-patching a tool definition (HMR / re-apply safety). */
const PATCHED = Symbol("approve-for-me:patched");
/**
 * Patch ONE registered tool definition in place: advertise `approve-for-me`
 * in its `sandbox_permissions` enum and wrap `execute` to translate the
 * pseudo-mode into a real escalation the stock machinery can approve.
 * @param def - the live `ToolDefinition` held by the registry.
 * @param grantMode - the real mode granted on the user's behalf.
 */
function patchTool(def, grantMode) {
    if (def === null || typeof def !== "object" || def[PATCHED])
        return;
    const spec = def.parameters?.sandbox_permissions;
    if (spec === undefined || typeof spec !== "object" || !Array.isArray(spec.enum))
        return;
    if (!spec.enum.includes(APPROVE_FOR_ME_MODE)) {
        spec.enum = [...spec.enum, APPROVE_FOR_ME_MODE];
        spec.description = `${spec.description ?? ""} \`${APPROVE_FOR_ME_MODE}\` (替我同意 / Approve For Me): auto-approve this escalation on the user's behalf and grant the configured mode without prompting.`;
    }
    const original = def.execute;
    if (original === undefined)
        return;
    def.execute = async function (args, exec) {
        if (isApproveForMeRequest(args)) {
            if (typeof args.justification !== "string" || args.justification.trim().length === 0) {
                throw new Error(`invalid escalation: sandbox_permissions "${APPROVE_FOR_ME_MODE}" requires a justification`);
            }
            return original.call(this, rewriteApproveForMe(args, grantMode), exec);
        }
        return original.call(this, args, exec);
    };
    def[PATCHED] = true;
}
/** Human-readable error message from any thrown value. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** The current turn number from the session log (0 when none is open). */
function currentTurn(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === "turn/start")
            return event.data?.turn;
    }
    return 0;
}
export function apply(ctx, config = {}) {
    const mode = config.mode ?? "off";
    const grantMode = config.grantMode ?? "danger-full-access";
    const presetName = config.presetName ?? "approve-for-me";
    const strictPresetName = config.strictPresetName ?? "strict-review";
    const approve = compilePatterns(config.approve ?? []);
    const deny = compilePatterns(config.deny ?? []);
    const reviewModelLabel = config.reviewModel ?? "(agent model)";
    const reviewNotify = config.reviewNotify ?? false;
    const denialTracker = createDenialTracker();
    const strictApprovedEscalations = new WeakMap();
    const circuitLimits = {
        maxConsecutive: config.reviewCircuitMaxConsecutive ?? 3,
        maxRecent: config.reviewCircuitMaxRecent ?? 10,
    };
    // Advertise the option for any escalation tool that loads AFTER this plugin.
    // `ESCALATION_TARGETS` is shipped readonly; the marker mode is appended at
    // runtime exactly as the JS version did, so the live registry advertises it.
    if (!ESCALATION_TARGETS.includes(APPROVE_FOR_ME_MODE)) {
        ESCALATION_TARGETS.push(APPROVE_FOR_ME_MODE);
    }
    /** Fold the session's effective auto-approval stance. */
    const resolveState = (session) => {
        // The DSH permission-preset helper expects the runtime's own event type;
        // our minimal view is structurally compatible, so relax at the boundary.
        const preset = effectivePermissionPreset(session.events);
        return {
            mode,
            presetActive: presetName !== "" && preset === presetName,
            strictActive: strictPresetName !== "" && preset === strictPresetName,
        };
    };
    /** Remember a strict-review approval only until its downstream sandbox gate asks for this call. */
    const rememberStrictEscalation = (session, callId, args) => {
        if (callId === undefined || typeof args !== "object" || args === null || typeof args.sandbox_permissions !== "string")
            return;
        let callIds = strictApprovedEscalations.get(session);
        if (callIds === undefined) {
            callIds = new Set();
            strictApprovedEscalations.set(session, callIds);
        }
        callIds.add(callId);
    };
    /** Consume a pre-execution strict approval so a sandbox escalation is not reviewed twice. */
    const consumeStrictEscalation = (session, callId) => {
        if (callId === undefined)
            return false;
        const callIds = strictApprovedEscalations.get(session);
        if (callIds === undefined || !callIds.delete(callId))
            return false;
        if (callIds.size === 0)
            strictApprovedEscalations.delete(session);
        return true;
    };
    /**
     * Patch every escalation tool already registered, and any registered later.
     * Reaches `ctx.tools.layers.global.tools` — TS-private registry internals
     * (`ToolRuntime.layers` / `ScopedLayers.global` / `ToolLayer.tools`), walked
     * deliberately because rc.6 exposes no public "replace a registered tool"
     * API. Guarded with optional chaining: if the layout ever changes, this
     * degrades to a no-op instead of crashing, and only the schema enum + the
     * execute wrap are lost.
     */
    const patchAll = () => {
        const table = ctx.tools?.layers?.global?.tools;
        if (table === undefined)
            return;
        for (const def of table.values())
            patchTool(def, grantMode);
    };
    patchAll();
    ctx.on("tools/change", () => patchAll(), { prepend: true });
    /** Recover the exact command text of the tool call under approval, when logged. */
    const commandTextFor = (session, callId) => {
        if (callId === undefined)
            return "";
        const events = session.events;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event.type !== "tool/call" || event.data?.callId !== callId)
                continue;
            try {
                const parsed = JSON.parse(event.data.arguments);
                return typeof parsed.command === "string" ? parsed.command : "";
            }
            catch {
                return "";
            }
        }
        return "";
    };
    /**
     * Find this answerer's still-open audit record. `ApprovalService` creates it
     * before dispatching answerers but does not expose its id on the request.
     */
    const pendingApprovalIdFor = (session, req) => {
        const decided = new Set();
        const candidates = [];
        for (let index = session.events.length - 1; index >= 0; index -= 1) {
            const event = session.events[index];
            if (event.type === "approval/decided") {
                decided.add(event.data?.id);
                continue;
            }
            if (event.type === "approval/asked" &&
                !decided.has(event.data?.id) &&
                (event.data?.callId ?? null) === (req.callId ?? null)) {
                candidates.push(event.data?.id);
                if (req.callId !== undefined)
                    return event.data?.id;
            }
        }
        return candidates.length === 1 ? candidates[0] : undefined;
    };
    /** Persist the reviewer rationale for the matching browser conversation node. */
    const appendReviewLog = (req, assessment) => {
        const session = req.agent.session;
        const approvalId = pendingApprovalIdFor(session, req);
        if (approvalId === undefined)
            return;
        try {
            session.append("hook/result", {
                hook: REVIEW_HOOK,
                approvalId,
                riskLevel: assessment.riskLevel,
                userAuthorization: assessment.userAuthorization,
                rationale: assessment.rationale,
            });
        }
        catch (error) {
            ctx.logger.warn(`[approve-for-me] could not persist reviewer rationale: ${errorMessage(error)}`);
        }
    };
    /** Persist one Strict Mode status in the chat flow, independent of native approvals. */
    const appendStrictReviewLog = (exec, outcome, assessment, fallbackRationale) => {
        const session = exec.agent?.session;
        if (session === undefined)
            return;
        try {
            const data = {
                hook: STRICT_REVIEW_HOOK,
                callId: exec.callId,
                toolName: exec.name,
                outcome,
                rationale: fallbackRationale ?? assessment?.rationale,
            };
            if (assessment !== undefined) {
                data.riskLevel = assessment.riskLevel;
                data.userAuthorization = assessment.userAuthorization;
            }
            session.append("hook/result", data);
        }
        catch (error) {
            ctx.logger.warn(`[approve-for-me] could not persist strict reviewer rationale: ${errorMessage(error)}`);
        }
    };
    /** Start a durable Strict Mode status row before the reviewer request begins. */
    const appendStrictReviewStarted = (exec) => {
        const session = exec.agent?.session;
        if (session === undefined)
            return;
        try {
            session.append("hook/invoked", { hook: STRICT_REVIEW_HOOK, callId: exec.callId, toolName: exec.name });
        }
        catch (error) {
            ctx.logger.warn(`[approve-for-me] could not persist strict review start: ${errorMessage(error)}`);
        }
    };
    /**
     * Queue one terminal plugin notice for the next model step.
     *
     * `agent.inject` is an inbox queue rather than a live status channel. It is
     * safe here only after the verdict is known: it flushes at the NEXT step
     * boundary, after the pending tool call has settled. Do not use it for a
     * "reviewing" progress row: the browser can render that stale row after the
     * authoritative `approval/decided` event, making the UI appear stuck.
     *
     * The native `approval/asked` / `approval/decided` audit pair remains the
     * Web UI's authoritative progress and completion state.
     * Failures are contained — a session tearing down must not break the
     * approval decision.
     * @param agent - the live agent whose session receives the notice.
     * @param summary - one-line terminal account shown on the collapsed row.
     * @param text - full model-facing text (defaults to `summary`).
     */
    const injectReviewNotice = (agent, summary, text) => {
        if (!reviewNotify)
            return;
        try {
            agent.inject?.(createUserMessage({
                content: [{ type: "text", text: text ?? summary }],
                source: { kind: "plugin", plugin: name, form: "notice", summary },
            }));
        }
        catch {
            // session may be mid-teardown; the decision still stands
        }
    };
    /**
     * One reviewer round-trip: assemble the codex-guardian-style prompt (fixed
     * security policy + compact transcript + exact action JSON), call the
     * lightweight model through `ctx.llm.stream` with a timeout, and parse the
     * strict-JSON verdict. Any failure throws — the caller applies
     * `reviewFallback` (fail closed to deny by default).
     */
    const runReview = async (req) => {
        const llm = ctx.get("llm");
        if (llm === undefined)
            throw new Error("review mode requires ctx.llm (no LLM service mounted)");
        const agent = req.agent;
        const session = agent.session;
        // The session's actual model route is recorded per request as
        // `request/context` events (the agent loop appends them); fold the last
        // one so an unconfigured reviewer inherits the session's live model.
        let inheritedProvider;
        let inheritedModel;
        for (let index = session.events.length - 1; index >= 0; index -= 1) {
            const event = session.events[index];
            if (event.type === "request/context") {
                inheritedProvider = event.data?.provider;
                inheritedModel = event.data?.model;
                break;
            }
        }
        const provider = config.reviewProvider ?? inheritedProvider;
        const model = config.reviewModel ?? inheritedModel;
        if (!provider || !model) {
            throw new Error("review mode requires reviewProvider/reviewModel (or a session with a recorded model route); nothing to review with");
        }
        const reason = req.reason ?? "";
        const justification = reason.startsWith("escalate sandbox to ")
            ? reason.slice(reason.indexOf(":") + 1).trim()
            : reason;
        const actionJson = buildReviewAction({
            toolName: req.toolName,
            callId: req.callId,
            arguments: req.arguments,
            reason,
            justification,
            command: commandTextFor(session, req.callId),
        });
        const { lines, omitted } = collectReviewTranscript(session.events);
        const userText = renderReviewUserPrompt({
            transcriptLines: lines,
            omitted,
            sessionId: session?.header?.id ?? "unknown",
            actionJson,
        });
        const system = renderReviewSystemPrompt(config.reviewPolicy);
        const message = createUserMessage({
            content: [{ type: "text", text: userText }],
            source: { kind: "plugin", plugin: name },
        });
        const timeoutMs = config.reviewTimeoutMs ?? 30000;
        const attempts = Math.max(1, config.reviewMaxAttempts ?? 2);
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const text = await collectReviewText(llm, {
                    provider,
                    model,
                    system,
                    messages: [message],
                    signal: req.signal,
                    timeoutMs,
                });
                const assessment = parseGuardianAssessment(text);
                if (assessment !== null)
                    return assessment;
                lastError = new Error("reviewer returned no parseable assessment");
            }
            catch (error) {
                if (req.signal?.aborted)
                    throw error; // cancellation: do not retry
                lastError = error;
            }
        }
        throw lastError ?? new Error("review failed");
    };
    /**
     * One `ctx.llm.stream` call collected to text, raced against the caller's
     * signal and the review timeout. Timeout and cancellation surface as
     * distinct errors so the caller can apply the right fallback.
     */
    const collectReviewText = async (llm, options) => {
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort();
        if (options.signal !== undefined)
            options.signal.addEventListener("abort", onAbort, { once: true });
        const timer = options.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, options.timeoutMs)
            : null;
        try {
            const parts = [];
            const stream = llm.stream({
                provider: options.provider,
                model: options.model,
                system: options.system,
                messages: options.messages,
                signal: controller.signal,
                temperature: 0,
            });
            for await (const chunk of stream) {
                if (chunk.type === "text-delta")
                    parts.push(chunk.text ?? "");
            }
            return parts.join("");
        }
        catch (error) {
            if (timedOut)
                throw new Error(`reviewer timed out after ${options.timeoutMs}ms`);
            if (options.signal?.aborted)
                throw new Error("review aborted");
            throw error;
        }
        finally {
            if (timer !== null)
                clearTimeout(timer);
            if (options.signal !== undefined)
                options.signal.removeEventListener("abort", onAbort);
        }
    };
    // Strict Mode gates every tool call before its tool body or any downstream
    // sandbox policy. Allowing delegates so the stock tool policies still run.
    ctx.on("tools/pre-execute", async (exec, next) => {
        if (exec.agent === undefined || exec.signal?.aborted === true)
            return next();
        const session = exec.agent.session;
        const state = resolveState(session);
        if (state.mode !== "review" || !state.strictActive)
            return next();
        appendStrictReviewStarted(exec);
        const key = session;
        const turn = currentTurn(session.events);
        if (denialTracker.tripped(key, turn)) {
            const rationale = "审查拒绝次数已达到本轮阈值，已转交人工审批。";
            appendStrictReviewLog(exec, "ask", undefined, rationale);
            return { kind: "ask", reason: rationale };
        }
        const args = exec.arguments;
        const justification = typeof args === "object" && args !== null && typeof args.justification === "string"
            ? args.justification
            : "";
        let assessment;
        try {
            assessment = await runReview({
                agent: exec.agent,
                toolName: exec.name,
                callId: exec.callId,
                arguments: args,
                reason: "Strict Mode review before tool execution.",
                justification,
                signal: exec.signal,
            });
        }
        catch (error) {
            if (exec.signal?.aborted) {
                appendStrictReviewLog(exec, "cancelled", undefined, "审查已取消。");
                return { kind: "deny", reason: "strict review was cancelled" };
            }
            const message = errorMessage(error);
            ctx.logger.warn(`[approve-for-me] strict review failed for ${exec.name}: ${message}`);
            if ((config.reviewFallback ?? "deny") === "ask") {
                const rationale = `自动审查失败，已转交人工审批：${message}`;
                appendStrictReviewLog(exec, "ask", undefined, rationale);
                return { kind: "ask", reason: rationale };
            }
            const rationale = `自动审查失败，已拒绝执行：${message}`;
            appendStrictReviewLog(exec, "rejected", undefined, rationale);
            return { kind: "deny", reason: rationale };
        }
        if (assessment.outcome === "allow") {
            denialTracker.record(key, turn, false, circuitLimits);
            rememberStrictEscalation(session, exec.callId, args);
            appendStrictReviewLog(exec, "allowed", assessment);
            ctx.logger.info(`[approve-for-me] strict reviewer approved ${exec.name} (risk=${assessment.riskLevel}, auth=${assessment.userAuthorization}, rationale=${assessment.rationale})`);
            return next();
        }
        const circuit = denialTracker.record(key, turn, true, circuitLimits);
        if (circuit === "tripped") {
            const rationale = `${assessment.rationale} 审查拒绝次数已达到本轮阈值，已转交人工审批。`;
            appendStrictReviewLog(exec, "ask", assessment, rationale);
            ctx.logger.warn(`[approve-for-me] strict review circuit breaker tripped for ${exec.name}; handing control to the human`);
            return { kind: "ask", reason: rationale };
        }
        appendStrictReviewLog(exec, "rejected", assessment);
        ctx.logger.info(`[approve-for-me] strict reviewer denied ${exec.name} (risk=${assessment.riskLevel}, auth=${assessment.userAuthorization}, rationale=${assessment.rationale})`);
        return { kind: "deny", reason: `strict review denied tool "${exec.name}": ${assessment.rationale}` };
    }, { prepend: true });
    // The answerer: runs before the UI answerer (prepend), claims only what the
    // policy decides, delegates everything else to `next()`.
    ctx.on("approval/request", async (req, next) => {
        if (req.signal?.aborted === true)
            return "cancelled";
        const session = req.agent.session;
        const state = resolveState(session);
        // Strict Mode already assessed the complete tool call before execution.
        // A downstream sandbox gate for that same call inherits the verdict;
        // uncorrelated approval requests remain native and never bypass review.
        if (state.mode === "review" && state.strictActive) {
            if (consumeStrictEscalation(session, req.callId)) {
                ctx.logger.info(`[approve-for-me] strict reviewer already approved ${req.toolName}${req.callId !== undefined ? ` (call ${req.callId})` : ""}`);
                return "allowed-once";
            }
            return next();
        }
        // Review mode is opt-in per session through the permission preset.
        // Other presets keep DSH's native approval UI and never invoke the reviewer.
        if (state.mode === "review" && !state.presetActive)
            return next();
        // Review mode: a lightweight model decides on the user's behalf.
        if (state.mode === "review") {
            // An explicit per-call `sandbox_permissions: "approve-for-me"` is the
            // user's pre-consent for exactly this action — no review needed.
            if ((req.reason ?? "").includes(APPROVE_FOR_ME_MARKER)) {
                ctx.logger.info(`[approve-for-me] approved ${req.toolName} (explicit approve-for-me call)`);
                return "allowed-once";
            }
            const key = session;
            const turn = currentTurn(session.events);
            if (denialTracker.tripped(key, turn)) {
                ctx.logger.warn("[approve-for-me] review circuit breaker is tripped; handing this approval to the human");
                return next();
            }
            const toolLabel = `${req.toolName}${req.callId !== undefined ? ` (call ${req.callId})` : ""}`;
            let decision;
            try {
                const assessment = await runReview(req);
                decision = assessment.outcome === "allow" ? "allowed-once" : "rejected";
                const verdict = decision === "allowed-once" ? "通过" : "拒绝";
                appendReviewLog(req, assessment);
                if (reviewNotify) {
                    const summary = `⚠ 自动审查${verdict}（risk: ${assessment.riskLevel}，authorization: ${assessment.userAuthorization}）`;
                    const detail = [
                        `${summary}：${assessment.rationale}`,
                        decision === "allowed-once" ? `✔ 已批准 ${toolLabel} 的权限升级` : `✖ 已拒绝 ${toolLabel} 的权限升级`,
                    ].join("\n");
                    injectReviewNotice(req.agent, summary, detail);
                }
                ctx.logger.info(`[approve-for-me] reviewer ${assessment.outcome === "allow" ? "approved" : "denied"} ${req.toolName} (risk=${assessment.riskLevel}, auth=${assessment.userAuthorization}, rationale=${assessment.rationale})`);
            }
            catch (error) {
                if (req.signal?.aborted) {
                    if (reviewNotify)
                        injectReviewNotice(req.agent, "⏹ 审查已取消（请求中止）");
                    return "cancelled";
                }
                ctx.logger.warn(`[approve-for-me] review failed: ${errorMessage(error)}`);
                if (reviewNotify) {
                    injectReviewNotice(req.agent, `⚠ 自动审查失败（${errorMessage(error)}）→ ${(config.reviewFallback ?? "deny") === "ask" ? "已转交人工审批" : "已拒绝（fail-closed）"}`);
                }
                if ((config.reviewFallback ?? "deny") === "ask")
                    return next();
                decision = "rejected";
            }
            if (decision === "rejected") {
                if (denialTracker.record(key, turn, true, circuitLimits) === "tripped") {
                    ctx.logger.warn("[approve-for-me] review circuit breaker tripped by repeated denials; handing this approval to the human");
                    return next();
                }
            }
            else {
                denialTracker.record(key, turn, false, circuitLimits);
            }
            return decision;
        }
        // Rule-based modes (off / auto / full-auto / never, plus the preset).
        const decision = decideApproval({
            mode: state.mode,
            presetActive: state.presetActive,
            approve,
            deny,
            reason: req.reason ?? "",
            toolName: req.toolName,
            commandText: commandTextFor(session, req.callId),
        });
        if (decision === null)
            return next();
        ctx.logger.info(`[approve-for-me] ${decision === "allowed-once" ? "approved" : "rejected"} ${req.toolName}${req.callId !== undefined ? ` (call ${req.callId})` : ""} (mode=${state.mode}${state.presetActive ? ", preset=approve-for-me" : ""})`);
        return decision;
    }, { prepend: true });
    // Register the "Approve For Me" permission preset so the Web GUI sandbox
    // permission selector and the `/permission` command offer it.
    const presets = ctx.get("permissionPresets");
    if (presets !== undefined && presets.presets !== undefined && !Object.hasOwn(presets.presets, presetName)) {
        presets.presets[presetName] = {
            sandbox: config.presetSandbox ?? "workspace-write",
            approval: config.presetApproval ?? "ask",
            name: "替我同意 / Approve For Me",
            description: "Auto-approve sandbox escalations and approval prompts on the user's behalf (Approve For Me).",
        };
        ctx.logger.info(`[approve-for-me] registered permission preset "${presetName}"`);
    }
    if (presets !== undefined &&
        presets.presets !== undefined &&
        strictPresetName !== "" &&
        strictPresetName !== presetName &&
        !Object.hasOwn(presets.presets, strictPresetName)) {
        presets.presets[strictPresetName] = {
            sandbox: config.strictPresetSandbox ?? "workspace-write",
            approval: config.strictPresetApproval ?? "ask",
            name: "Approve For Me - Strict Mode",
            description: "Review every tool call automatically before it executes.",
        };
        ctx.logger.info(`[approve-for-me] registered permission preset "${strictPresetName}"`);
    }
    // Model-facing statement of the current auto-approval stance.
    ctx.inject(["systemPrompt"], (scope) => {
        scope.systemPrompt.context({
            name: "approve-for-me:mode",
            order: 116,
            text: (context) => {
                const agent = context.agent;
                if (agent === undefined)
                    return "";
                const state = resolveState(agent.session);
                if (state.mode === "review") {
                    if (state.strictActive) {
                        return `Approval auto-resolution: Strict Mode — the "${strictPresetName}" (Approve For Me - Strict Mode) permission preset is active, so a lightweight reviewer model (${reviewModelLabel}) assesses every tool call before execution. Approved sandbox escalations inherit that same verdict; reviewer failures follow ${config.reviewFallback ?? "deny"}.`;
                    }
                    if (state.presetActive) {
                        return `Approval auto-resolution: review — the "${presetName}" (替我同意 / Approve For Me) permission preset is active, so every approval prompt is assessed by a lightweight reviewer model (${reviewModelLabel}) and approved or rejected automatically on the user's behalf; reviewer failures fail closed to ${config.reviewFallback ?? "deny"}.`;
                    }
                    return `Approval auto-resolution: review is configured but inactive. Select "${presetName}" (替我同意 / Approve For Me) to review permission escalations, or "${strictPresetName}" (Approve For Me - Strict Mode) to review every tool call, with the lightweight reviewer model (${reviewModelLabel}); until then, approval prompts remain in the native user approval UI.`;
                }
                if (state.presetActive) {
                    return `Approval auto-resolution: the "${presetName}" (替我同意 / Approve For Me) permission preset is active — approval prompts and sandbox escalations are approved automatically on the user's behalf; do not wait for a human to approve them.`;
                }
                switch (state.mode) {
                    case "full-auto":
                        return "Approval auto-resolution: full-auto — every approval prompt is approved automatically without asking the user.";
                    case "auto":
                        return "Approval auto-resolution: auto — approval prompts matching the configured rules are approved automatically, prompts matching deny rules are rejected, and anything else is presented to the user.";
                    case "never":
                        return "Approval auto-resolution: never — every approval prompt is rejected automatically; do not request sandbox escalation (do not set `sandbox_permissions`).";
                    default:
                        return "Approval auto-resolution: off — approval prompts are presented to the user.";
                }
            },
        });
    });
    ctx.logger.info(`[approve-for-me] loaded (mode=${mode}, grantMode=${grantMode}, preset="${presetName}", strictPreset="${strictPresetName}"${mode === "review" ? `, reviewer=${reviewModelLabel}, fallback=${config.reviewFallback ?? "deny"}` : ""})`);
}
