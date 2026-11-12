import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId, Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ContextManager from '../src/service.ts'
import * as commands from '../src/commands.ts'

class Adapter extends LlmAdapter {
  requests = []
  toolNext = false
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    if (this.toolNext) {
      this.toolNext = false
      const id = ToolCallId('loop-tool-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'echo', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'echo', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = options.purpose === 'compaction' ? 'compressed facts' : 'original answer '.repeat(200)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('built bundle survives edits and compaction across real agent-loop requests with real token meter', { timeout: 20000 }, async t => {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable system prompt' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(CommandRuntime)
  // Load actual emitted entry points, not a relative reference into the Harness.
  const built = await import('../lib/index.js')
  const builtCommands = await import('../lib/commands.js')
  await ctx.plugin(built.default)
  await ctx.plugin(builtCommands)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('real-loop'), agentOptions: { provider: 'mock', model: 'mock' } })
  const agent = handle.agent
  const send = async text => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await agent.whenIdle() }
  const command = async line => { const value = await ctx.commands.execute(agent, line, [], new AbortController().signal); assert.equal(value.result.kind, 'success', value.result.text); return value }
  await send('first question')
  assert.equal(adapter.requests.length, 1)
  await command('/ctx-r manually revised answer')
  await send('second question')
  assert.equal(adapter.requests.length, 2)
  const second = JSON.stringify(adapter.requests[1].messages)
  assert.ok(second.includes('manually revised answer'))
  assert.ok(!second.includes('original answer'))
  await command('/ctx-d')
  await send('third question')
  assert.equal(adapter.requests.length, 3)
  assert.ok(!JSON.stringify(adapter.requests[2].messages).includes('original answer'))
  await command('/ctx-c')
  assert.equal(adapter.requests.length, 4)
  assert.equal(adapter.requests[3].purpose, 'compaction')
  await send('fourth question')
  assert.equal(adapter.requests.length, 5)
  const fourth = JSON.stringify(adapter.requests[4].messages)
  assert.ok(fourth.includes('compressed facts'))
  assert.ok(!fourth.includes('original answer'))
  assert.ok(!fourth.includes('/ctx-'))
  assert.ok(!fourth.includes('Summarize the supplied'))
  assert.deepEqual(ctx.contextManager.lastRequest(agent).messages, adapter.requests[4].messages)
  const restored = Session.create(SessionId('restored-real-loop'), JSON.parse(JSON.stringify(agent.session.snapshotEvents())))
  assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages())
  assert.ok(ctx.tokenMeter.measure(agent.session))
  ctx.tools.register({ name: 'echo', description: 'Return fixture output', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'tool result to discard' })
  adapter.toolNext = true
  await send('question using a tool')
  // First discard the final text reply; the preceding tool-calling output is now last.
  await command('/ctx-d')
  const group = ctx.contextManager.select(agent, 'last')
  assert.equal(group.length, 2)
  const groupMessages = ctx.contextManager.getContext(agent).entries.filter(entry => group.includes(entry.seq)).map(entry => entry.message.role)
  assert.deepEqual(groupMessages, ['assistant', 'tool'])
  await command('/ctx-d')
  await send('after discarding the tool group')
  const subsequent = JSON.stringify(adapter.requests.at(-1).messages)
  assert.ok(!subsequent.includes('loop-tool-call'))
  assert.ok(!subsequent.includes('tool result to discard'))
  assert.ok(subsequent.includes('after discarding the tool group'))
  // Exercise the actual V4 encoder and full lifecycle validator, not just Session.create.
  const root = await mkdtemp(join(tmpdir(), 'context-manager-persistence-'))
  const storageCtx = new Context()
  try {
    await storageCtx.plugin(Jsonl, { root, compression: 'none' })
    const writer = await storageCtx.sessionPersistence.create(agent.session.header)
    try { await writer.append(agent.session.snapshotEvents()); await writer.flush() }
    finally { await writer.close() }
    const reader = await storageCtx.sessionPersistence.open(agent.id, 'read')
    try {
      const stored = await reader.read()
      const fromDisk = Session.create(SessionId('disk-replay'), stored.events)
      assert.deepEqual(fromDisk.deriveMessages(), agent.session.deriveMessages())
    } finally { await reader.close() }
  } finally {
    await storageCtx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  await handle.dispose()
})
