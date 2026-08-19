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
export declare const PROJECTION_KEY = "approvalStatus";
declare const approvalStatusSchema: z.ZodObject<{
    pending: z.ZodNullable<z.ZodObject<{
        toolName: z.ZodString;
        callId: z.ZodNullable<z.ZodString>;
        startedAt: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        callId: string | null;
        toolName: string;
        startedAt: number;
    }, {
        callId: string | null;
        toolName: string;
        startedAt: number;
    }>>;
    last: z.ZodNullable<z.ZodObject<{
        outcome: z.ZodString;
        toolName: z.ZodNullable<z.ZodString>;
        at: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        toolName: string | null;
        outcome: string;
        at: number;
    }, {
        toolName: string | null;
        outcome: string;
        at: number;
    }>>;
}, "strip", z.ZodTypeAny, {
    pending: {
        callId: string | null;
        toolName: string;
        startedAt: number;
    } | null;
    last: {
        toolName: string | null;
        outcome: string;
        at: number;
    } | null;
}, {
    pending: {
        callId: string | null;
        toolName: string;
        startedAt: number;
    } | null;
    last: {
        toolName: string | null;
        outcome: string;
        at: number;
    } | null;
}>;
/** The folded projection state. */
export type ApprovalStatusState = z.infer<typeof approvalStatusSchema>;
/** A minimal view of one session event. */
export interface SessionEvent {
    type: string;
    time?: number;
    data?: {
        toolName?: string;
        callId?: string | null;
        id?: string;
        outcome?: string;
        [key: string]: unknown;
    };
}
/** The session-projection registration surface provided by DSH. */
export interface ProjectionScope {
    sessionProjections: {
        register(definition: unknown): unknown;
    };
}
/** Register the `approvalStatus` projection on a Cordis ctx that exposes `inject`. */
export declare function registerApprovalProjection(inject: (services: readonly string[], callback: (scope: ProjectionScope) => void) => void): void;
export {};
