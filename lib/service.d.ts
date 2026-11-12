/** UI-independent atomic context operations over the Harness's durable surface. */
import { Context, Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
/** Configurable summary routing and output budget. Empty routes follow the agent. */
export interface Config {
    summarizationProvider?: string;
    summarizationModel?: string;
    maxTokens?: number;
    instruction?: string;
}
/** One selected edit; disconnected selections are edited as separate contiguous spans. */
export interface ContextEdit {
    seqs: readonly SessionSeq[];
    kind: 'replace' | 'drop' | 'compact';
    text?: string;
}
/** Committed replacements and detached summary content, available to any user interface. */
export interface RewriteResult {
    replacementSeqs: readonly SessionSeq[];
    summaries: readonly {
        seq: SessionSeq;
        content: readonly ContentBlock[];
    }[];
}
/** Current committed provider-neutral model input, not a prediction of future admission. */
export interface ContextSnapshot {
    layer: 'committed-provider-neutral';
    asOf: number;
    contentGeneration: number;
    messages: Message[];
    entries: {
        index: number;
        seq: SessionSeq;
        message: Message;
        editable: boolean;
    }[];
    config: object | undefined;
    tools: readonly object[];
    toolHistory: object;
}
/** Complete generated summary, including one rejected before replacement. Token counts are heuristic. */
export interface GeneratedSummary {
    sourceSeqs: readonly SessionSeq[];
    content: readonly ContentBlock[];
    beforeTokens: number;
    afterTokens: number;
    replacementSeq?: SessionSeq;
}
/** An operation can fail after earlier ranges committed; never claim rollback. */
export declare class ContextManagerError extends Error {
    readonly committedSeqs: readonly SessionSeq[];
    readonly generatedSummaries: readonly GeneratedSummary[];
    constructor(message: string, committedSeqs?: readonly SessionSeq[], options?: ErrorOptions, generatedSummaries?: readonly GeneratedSummary[]);
}
type RequestSnapshot = Omit<GenerateOptions, 'signal'>;
/** Atomic service consumed by commands today and other user interfaces later. */
export default class ContextManager extends Service {
    static inject: string[];
    static Config: schema<Schemastery.ObjectS<NoInfer<{
        summarizationProvider: schema<string, string, "defined">;
        summarizationModel: schema<string, string, "defined">;
        maxTokens: schema<number, number, "defined">;
        instruction: schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        summarizationProvider: schema<string, string, "defined">;
        summarizationModel: schema<string, string, "defined">;
        maxTokens: schema<number, number, "defined">;
        instruction: schema<string, string, "defined">;
    }>>, "plain">;
    private index;
    private readonly requests;
    private readonly debugging;
    private readonly controllers;
    private readonly active;
    readonly config: Required<Config>;
    constructor(ctx: Context, config?: Config);
    protected [Service.init](): Promise<void>;
    /** @param agent - receiving agent. @returns complete committed context with stable selectors. */
    getContext(agent: Agent): ContextSnapshot;
    /** @param agent - receiving agent. @param enabled - log future requests and display compact results when true. */
    setDebug(agent: Agent, enabled: boolean): void;
    /** @param agent - receiving agent. @returns whether this session has debug enabled. */
    isDebug(agent: Agent): boolean;
    /** @param agent - receiving agent. @returns detached last actual loop request, when observed. */
    lastRequest(agent: Agent): RequestSnapshot | undefined;
    /** @param agent - receiving agent. @param selector - last (including matching tool results), 1,3-5 or seq:42. @returns surface-ordered selected event ids. */
    select(agent: Agent, selector: string): readonly SessionSeq[];
    private prepare;
    /** @param agent - idle receiving agent. @param edits - disjoint edits against current event ids. @param signal - caller cancellation. @returns committed replacement sequences; original log values are untouched. */
    rewrite(agent: Agent, edits: readonly ContextEdit[], signal: AbortSignal): Promise<RewriteResult>;
    private executePlan;
    private assertStable;
    private commit;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        contextManager: ContextManager;
    }
}
declare module '@deepseek-ai/dsh-llm' {
    interface LlmRequestPurposeMap {
        compaction: 'compaction';
    }
    interface MessageSourceMap {
        'context-manager': {
            kind: 'context-manager';
            modelOutput: boolean;
        };
    }
}
export {};
