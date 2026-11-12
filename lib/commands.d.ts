/** Human-only context commands; all model-context changes belong to the service. */
import type { Context } from '@deepseek-ai/cordis';
import type { Message } from '@deepseek-ai/dsh-llm';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
export declare const name = "context-manager-commands";
export declare const inject: string[];
export type CommandName = 'ctx-mod' | 'ctx-c' | 'ctx-r' | 'ctx-d';
export type ParsedAction = {
    kind: 'help';
} | {
    kind: 'list';
} | {
    kind: 'debug';
} | {
    kind: 'debug-set';
    enabled: boolean;
} | {
    kind: 'debug-last';
} | {
    kind: 'replace';
    selector: string;
    text: string;
} | {
    kind: 'drop';
    selector: string;
} | {
    kind: 'compact';
    selector: string;
} | {
    kind: 'error';
    text: string;
};
/**
 * Parse registry rawInput (without the slash-command name).
 * Selectors are opaque here: the service validates and resolves them against
 * the receiving agent. Replacement consumes one space/tab/newline separator
 * (a CRLF counts as one), preserving every subsequent payload character.
 */
export declare function parseInput(rawInput: string, alias?: CommandName): ParsedAction;
export interface Entry {
    readonly index: number;
    readonly seq: SessionSeq;
    readonly message: Message;
    readonly editable: boolean;
}
/** Render the compact list only; debug output must never use this formatter. */
export declare function formatEntries(entries: readonly Entry[]): string;
/** Register commands and unregister them before draining in-flight handlers. */
export declare function apply(ctx: Context): void;
