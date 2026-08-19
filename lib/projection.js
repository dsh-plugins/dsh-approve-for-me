/**
 * @dsh-plugin/dsh-approve-for-me — HOST projection half.
 *
 * Registers a per-session `sessionProjections` projection named `approvalStatus`
 * that folds the approval audit events the approval service already writes
 * (`approval/asked` when an approval question is put to the answerer chain,
 * `approval/decided` when it settles) into a small JSON status the browser half
 * renders in real time.
 *
 * Why this channel: `approval/asked` + `approval/decided` are log-only audit
 * events — they never enter the derived model history, so the browser can
 * render "reviewing… → approved/rejected" live WITHOUT breaking the
 * tool_calls→tool-response protocol (a `user/message` inserted mid-execution
 * would). Session projections are the host→client real-time push mechanism
 * (`permissions` uses the same seam); the client reads it with
 * `useProjection("approvalStatus")`.
 *
 * In `review` mode the gap between asked and decided IS the reviewer model's
 * assessment window, so the status bar reads as a codex-style
 * "● reviewing approval request … → ⚠ approved/denied".
 */
import { z } from "zod";
/** The projection key the browser half reads. */
export const PROJECTION_KEY = "approvalStatus";
const approvalStatusSchema = z.object({
    pending: z
        .object({
        toolName: z.string(),
        callId: z.string().nullable(),
        startedAt: z.number(),
    })
        .nullable(),
    last: z
        .object({
        outcome: z.string(),
        toolName: z.string().nullable(),
        at: z.number(),
    })
        .nullable(),
});
const init = () => ({ pending: null, last: null });
/** Fold one session event; the same reference is returned for unrelated events (the registry's change gate). */
function apply(state, event) {
    switch (event.type) {
        case "approval/asked":
            return {
                pending: {
                    toolName: event.data?.toolName ?? "",
                    callId: event.data?.callId ?? null,
                    startedAt: event.time ?? 0,
                },
                last: null,
            };
        case "approval/decided":
            return {
                pending: null,
                last: {
                    outcome: event.data?.outcome ?? "",
                    toolName: state.pending?.toolName ?? null,
                    at: event.time ?? 0,
                },
            };
        default:
            return state;
    }
}
/** The projection's output is the folded state itself. */
const view = (state) => state;
/** Register the `approvalStatus` projection on a Cordis ctx that exposes `inject`. */
export function registerApprovalProjection(inject) {
    inject(["sessionProjections"], (projectionCtx) => {
        const registry = projectionCtx
            .sessionProjections;
        // The browser status bar is an enhancement; degrade gracefully when the
        // host runtime does not provide the session-projection registry.
        if (registry === undefined)
            return;
        registry.register({
            key: PROJECTION_KEY,
            schema: approvalStatusSchema,
            init,
            apply,
            view,
            stateVersion: 1,
        });
    });
}
