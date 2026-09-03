/** Minimal cordis-shaped browser context. */
interface ClientContext {
    conversationEvents: {
        register(definition: unknown): unknown;
    };
    slots: {
        inject(name: string, callback: () => unknown): unknown;
        register(options: unknown, component: unknown): unknown;
    };
}
/** cordis client-plugin name — must equal the package name. */
export declare const name = "@dsh-plugin/dsh-approve-for-me";
/** Browser-half cordis services this plugin consumes. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
