/**
 * @dsh-plugin/dsh-approve-for-me — BROWSER half.
 *
 * Renders a codex-style auto-review status bar (shimmer progress → verdict)
 * in the Web GUI conversation stream, driven by `approval/asked` +
 * `approval/decided` audit events plus the host plugin's log-only
 * `hook/invoked` + `hook/result` rows for Strict Mode.
 *
 * The module registers itself through the web profile's `__ModuleLoader__`
 * protocol; `require` is provided by the loader, not by Node.
 */
export {};
