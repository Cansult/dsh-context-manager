/** Human-only context commands; all model-context changes belong to the service. */
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { ContextManagerError } from './service.ts'

export const name = 'context-manager-commands'
export const inject = ['commands', 'contextManager']

export type CommandName = 'ctx-mod' | 'ctx-c' | 'ctx-r' | 'ctx-d'
export type ParsedAction =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'debug' }
  | { kind: 'debug-set'; enabled: boolean }
  | { kind: 'debug-last' }
  | { kind: 'replace'; selector: string; text: string }
  | { kind: 'drop'; selector: string }
  | { kind: 'compact'; selector: string }
  | { kind: 'error'; text: string }

const HELP = [
  '/ctx-mod help                         Show this help',
  '/ctx-mod list                         List index, seq, role and preview',
  '/ctx-mod debug                        Show the full committed context JSON',
  '/ctx-mod debug on|off                 Enable/disable full request logging and compact-result display',
  '/ctx-mod debug last                   Show the full last captured request JSON',
  '/ctx-mod replace <selector> <text>    Replace with the remaining exact text',
  '/ctx-mod drop <selector>              Drop selected context entries',
  '/ctx-mod compact <selector>           Summarize selected context entries',
  '/ctx-c                                Compact last model output',
  '/ctx-r <text>                         Replace last model output',
  '/ctx-d                                Drop last model output',
  'Selectors: last (includes matching tool results), 1,3-5, seq:9. Use list for current indexes and sequences.',
  'Replacement text preserves whitespace and newlines after one separator.',
].join('\n')

function tokenOf(input: string): { token: string; rest: string } | undefined {
  const match = /^\s*(\S+)/u.exec(input)
  if (match === null) return undefined
  return { token: match[1]!, rest: input.slice(match[0].length) }
}

/** Remove only the grammar separator, never trim or normalize payload text. */
function afterSeparator(input: string): string {
  if (input.startsWith('\r\n')) return input.slice(2)
  return /^\s/u.test(input) ? input.slice(1) : input
}

function failure(text: string): ParsedAction {
  return { kind: 'error', text }
}

function replacement(selector: string, text: string): ParsedAction {
  return text.trim().length === 0
    ? failure('Replacement text must be nonempty; use drop to discard.')
    : { kind: 'replace', selector, text }
}

/**
 * Parse registry rawInput (without the slash-command name).
 * Selectors are opaque here: the service validates and resolves them against
 * the receiving agent. Replacement consumes one space/tab/newline separator
 * (a CRLF counts as one), preserving every subsequent payload character.
 */
export function parseInput(rawInput: string, alias: CommandName = 'ctx-mod'): ParsedAction {
  if (alias === 'ctx-r') return replacement('last', afterSeparator(rawInput))
  if (alias === 'ctx-c' || alias === 'ctx-d') {
    if (rawInput.trim().length > 0) return failure(`Usage: /${alias} (no arguments)`)
    return { kind: alias === 'ctx-c' ? 'compact' : 'drop', selector: 'last' }
  }
  if (alias !== 'ctx-mod') return failure(`Unknown context command: ${String(alias)}`)

  const action = tokenOf(rawInput)
  if (action === undefined) return { kind: 'help' }
  switch (action.token) {
    case 'help':
    case 'list':
      return action.rest.trim().length === 0
        ? { kind: action.token }
        : failure(`Usage: /ctx-mod ${action.token} (no arguments)`)
    case 'debug': {
      const option = action.rest.trim()
      if (option === '') return { kind: 'debug' }
      if (option === 'last') return { kind: 'debug-last' }
      if (option === 'on' || option === 'off') return { kind: 'debug-set', enabled: option === 'on' }
      return failure('Usage: /ctx-mod debug [on|off|last]')
    }
    case 'replace':
    case 'drop':
    case 'compact': {
      const selection = tokenOf(action.rest)
      if (selection === undefined) return failure(`Usage: /ctx-mod ${action.token} <selector>${action.token === 'replace' ? ' <text>' : ''}`)
      if (action.token === 'replace') return replacement(selection.token, afterSeparator(selection.rest))
      if (selection.rest.trim().length > 0) return failure(`Usage: /ctx-mod ${action.token} <selector> (no additional arguments)`)
      return { kind: action.token, selector: selection.token }
    }
    default: return failure(`Unknown /ctx-mod subcommand: ${action.token}. Use /ctx-mod help.`)
  }
}

export interface Entry {
  readonly index: number
  readonly seq: SessionSeq
  readonly message: Message
  readonly editable: boolean
}

/** Render the compact list only; debug output must never use this formatter. */
export function formatEntries(entries: readonly Entry[]): string {
  if (entries.length === 0) return 'No context entries.'
  return ['index\tseq\trole\tpreview', ...entries.map(entry => {
    const content = entry.message.content.map(block =>
      'text' in block && typeof block.text === 'string' ? block.text : JSON.stringify(block),
    ).join(' ').replace(/\s+/gu, ' ')
    const preview = content.length <= 120 ? content : `${content.slice(0, 119)}…`
    return `${entry.index}\t${entry.seq}\t${entry.message.role}\t${preview}`
  })].join('\n')
}

async function execute(ctx: Context, invocation: CommandInvocation, alias: CommandName): Promise<CommandResult> {
  try {
    invocation.signal.throwIfAborted()
    const action = parseInput(invocation.rawInput, alias)
    const service = ctx.contextManager
    switch (action.kind) {
      case 'error': return { kind: 'error', text: action.text }
      case 'help': return { kind: 'success', text: HELP }
      case 'list': return { kind: 'success', text: formatEntries(service.getContext(invocation.agent).entries) }
      case 'debug': return { kind: 'success', text: JSON.stringify(service.getContext(invocation.agent), null, 2) }
      case 'debug-set':
        service.setDebug(invocation.agent, action.enabled)
        return { kind: 'success', text: `Full request logging and compact-result display ${action.enabled ? 'enabled' : 'disabled'}.` }
      case 'debug-last': {
        const request = service.lastRequest(invocation.agent)
        if (request === undefined) return { kind: 'error', text: 'No request has been captured yet.' }
        return { kind: 'success', text: JSON.stringify(request, null, 2) }
      }
      case 'replace':
      case 'drop':
      case 'compact': {
        const seqs = service.select(invocation.agent, action.selector)
        const edit = action.kind === 'replace'
          ? { seqs, kind: action.kind, text: action.text }
          : { seqs, kind: action.kind }
        const result = await service.rewrite(invocation.agent, [edit], invocation.signal)
        const verb = { replace: 'Replaced', drop: 'Dropped', compact: 'Compacted' }[action.kind]
        const feedback = `${verb} ${seqs.length} context entries; replacement seqs: ${result.replacementSeqs.join(', ')}.`
        const details = action.kind === 'compact' && service.isDebug(invocation.agent)
          ? result.summaries.map(summary => `\n\nCompacted content (seq ${summary.seq}):\n${summary.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('')}`).join('')
          : ''
        return { kind: 'success', text: feedback + details }
      }
    }
  } catch (error: unknown) {
    // Preserve partial-commit diagnostics; debug may expose complete generated
    // summaries without implying that their replacement or durability succeeded.
    if (error instanceof ContextManagerError && ctx.contextManager.isDebug(invocation.agent)) {
      const details = error.generatedSummaries.map(summary => {
        const status = summary.replacementSeq === undefined
          ? 'not replaced'
          : `replacement committed at seq ${summary.replacementSeq}; operation failed, durability may be unconfirmed`
        return `\n\nGenerated summary (${status}; source seqs: ${summary.sourceSeqs.join(', ')}; estimated tokens: ${summary.beforeTokens} -> ${summary.afterTokens}):\n${summary.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('')}`
      }).join('')
      return { kind: 'error', text: error.message + details }
    }
    if (error instanceof Error) return { kind: 'error', text: error.message || 'Context command failed.' }
    throw error
  }
}

/** Register commands and unregister them before draining in-flight handlers. */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const controllers = new Set<AbortController>()
  const handler = (alias: CommandName) => (invocation: CommandInvocation): Promise<CommandResult> => {
    const controller = new AbortController()
    controllers.add(controller)
    const operation = execute(ctx, { ...invocation, signal: AbortSignal.any([invocation.signal, controller.signal]) }, alias)
    active.add(operation)
    const retire = (): void => { active.delete(operation); controllers.delete(controller) }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Effect teardown is LIFO: remove all registrations, then drain promises.
    yield async () => {
      for (const controller of controllers) controller.abort(new Error('Context commands unloaded.'))
      await Promise.allSettled(active)
    }
    for (const [command, description, hint] of [
      ['ctx-mod', 'Inspect and edit current model context', 'help|list|debug|replace|drop|compact'],
      ['ctx-c', 'Compact last model output', 'No arguments'],
      ['ctx-r', 'Replace last model output with exact text', 'Replacement text'],
      ['ctx-d', 'Drop last model output', 'No arguments'],
    ] as const) {
      yield ctx.commands.register({
        definitionId: CommandDefinitionId(`dsh-context-manager/${command}`),
        name: command,
        description,
        input: { hint },
        recordInput: false,
        handler: handler(command),
      })
    }
  }, 'context-manager commands lifecycle')
}
