import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage, ToolCallId, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import ContextManager, { ContextManagerError } from '../src/service.ts'
import * as commands from '../src/commands.ts'

async function harness(t, config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  let summary = 'short summary'
  let finish = { kind: 'stop' }
  let during = async () => {}
  let busy = false
  let flushError = false
  let callCount = 0
  const captured = []
  ctx.provide('agents', { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 1 }) })
  ctx.provide('tokenMeter', { estimateMessage: message => JSON.stringify(message.content).length })
  ctx.provide('llm', {
    prepareCall: async config => ({ config, stream: options => ctx.waterfall(ctx.llm, 'llm/stream', options, async function* () {
      callCount++; captured.push(options); await during(options)
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: summary }
      yield { type: 'finish', reason: finish }
    }) }),
  })
  ctx.on('session/flush', () => { if (flushError) throw new Error('disk unavailable') })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(ContextManager, config)
  const commandFiber = await ctx.plugin(commands)
  const session = ctx.sessions.create(SessionId(`test-${Math.random()}`))
  const agent = {
    id: session.id, session, options: { provider: 'mock', model: 'model' }, status: 'idle', ctx,
    model: { current: () => ({ provider: 'mock', model: 'model' }) },
    runMaintenance(task) {
      if (busy) throw new Error('busy')
      busy = true
      return Promise.resolve().then(() => task(new AbortController().signal)).finally(() => { busy = false })
    },
  }
  const user = text => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const assistant = (text, extra = []) => session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'mock', model: 'model', replayState: { signature: 'original' } }, content: [{ type: 'text', text }, ...extra] }) }, { surfaceOp: 'append' })
  const tool = (id, text) => session.append('tool/result', { turn: 1, step: 1, meta: { retained: true }, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError: false }) }, { surfaceOp: 'append' })
  const run = async line => {
    const result = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    assert.ok(result); return result.result
  }
  const rewrite = edits => ctx.contextManager.rewrite(agent, edits, new AbortController().signal)
  const text = () => session.deriveMessages().filter(message => message.content.length > 0).flatMap(message => message.content.map(block => block.text ?? '')).join('\n')
  t.after(async () => { await ctx.fiber.dispose() })
  return { ctx, agent, session, user, assistant, tool, run, rewrite, text, captured, commandFiber,
    get calls() { return callCount }, setSummary: value => { summary = value }, setFinish: value => { finish = value }, setDuring: value => { during = value }, setBusy: value => { busy = value }, failFlush: () => { flushError = true } }
}

test('commands change only derived context and keep the original transcript and command text out', async t => {
  const h = await harness(t)
  h.user('question'); const original = h.assistant('long original answer')
  const result = await h.run('/ctx-r replacement\nsecond line  ')
  assert.equal(result.kind, 'success')
  assert.equal(h.text(), 'question\nreplacement\nsecond line  ')
  assert.equal(original.data.message.content[0].text, 'long original answer')
  assert.equal(h.session.eventAt(original.seq).data.message.source.replayState.signature, 'original')
  assert.equal(h.calls, 0)
  const last = h.ctx.contextManager.getContext(h.agent).entries.at(-1)
  assert.equal(last.message.role, 'user')
  assert.equal(last.message.source.kind, 'context-manager')
  assert.equal(last.message.source.replayState, undefined)
  assert.equal((await h.run('/ctx-d')).kind, 'success')
  assert.equal(h.text(), 'question')
  assert.ok(!h.text().includes('ctx-'))
  assert.equal(h.session.deriveMessages().some(message => message.role === 'developer'), false)
})

test('drop removes selected content and replay works without the plugin', async t => {
  const h = await harness(t); h.user('keep'); h.assistant('discard me')
  await h.run('/ctx-d')
  const events = structuredClone(h.session.snapshotEvents())
  const restored = Session.create(SessionId('replayed'), events)
  assert.deepEqual(restored.deriveMessages(), h.session.deriveMessages())
  assert.equal(restored.deriveMessages().filter(message => message.content.length > 0).length, 1)
  assert.deepEqual(restored.deriveMessages().at(-1).content, [])
  assert.ok(events.some(event => event.type === 'assistant/message' && event.data.message.content[0].text === 'discard me'))
  assert.ok(events.every(event => !event.type.startsWith('plugin:')))
})

test('selectors are current surface order, support stable seq and last after replacement', async t => {
  const h = await harness(t); const a = h.user('first'); const b = h.assistant('second'); const c = h.user('third')
  assert.deepEqual(h.ctx.contextManager.select(h.agent, '1,3'), [a.seq, c.seq])
  assert.deepEqual(h.ctx.contextManager.select(h.agent, `seq:${b.seq}`), [b.seq])
  await h.run('/ctx-mod replace 1 first revised')
  const entries = h.ctx.contextManager.getContext(h.agent).entries
  assert.ok(entries[0].seq > entries[1].seq)
  assert.deepEqual(h.ctx.contextManager.select(h.agent, 'last'), [b.seq])
  await h.run('/ctx-r second revised')
  assert.equal(h.ctx.contextManager.getContext(h.agent).entries.find(entry => entry.seq === h.ctx.contextManager.select(h.agent, 'last')[0]).message.content[0].text, 'second revised')
  assert.throws(() => h.ctx.contextManager.select(h.agent, '0'), /outside/)
  assert.throws(() => h.ctx.contextManager.select(h.agent, 'seq:99999'), /Unknown/)
})

test('disconnected selections leave intervening messages untouched and prevalidate all edits', async t => {
  const h = await harness(t); h.user('one'); h.user('two'); h.user('three')
  assert.equal((await h.run('/ctx-mod replace 1,3 changed')).kind, 'success')
  assert.equal(h.text(), 'changed\ntwo\nchanged')
  const before = h.session.seq
  const seq = h.ctx.contextManager.select(h.agent, '1')[0]
  await assert.rejects(h.rewrite([{ kind: 'drop', seqs: [seq] }, { kind: 'drop', seqs: [SessionSeq(99999)] }]), /stale/)
  assert.equal(h.session.seq, before)
})

test('system and developer entries cannot be edited', async t => {
  const h = await harness(t)
  h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('protected') }, { surfaceOp: 'append' })
  const before = h.session.seq
  await assert.rejects(h.rewrite([{ kind: 'drop', seqs: h.ctx.contextManager.select(h.agent, '1') }]), /not editable/)
  assert.equal(h.session.seq, before)
})

test('last-output shortcuts include all matching tool results without touching later user input', async t => {
  for (const command of ['/ctx-d', '/ctx-r revised tool outcome', '/ctx-c']) {
    const h = await harness(t)
    h.user('keep this question')
    const ids = [ToolCallId('parallel-a'), ToolCallId('parallel-b')]
    const original = h.assistant('tool invocation '.repeat(100), ids.map(id => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })))
    const results = [h.tool(ids[1], 'second result'), h.tool(ids[0], 'first result')]
    h.user('keep this later input')
    assert.deepEqual(h.ctx.contextManager.select(h.agent, 'last'), [original.seq, ...results.map(result => result.seq)])
    const outcome = await h.run(command)
    assert.equal(outcome.kind, 'success', outcome.text)
    const replacementText = command === '/ctx-d' ? '' : command === '/ctx-c' ? 'short summary\n' : 'revised tool outcome\n'
    assert.equal(h.text(), `keep this question\n${replacementText}keep this later input`)
    assert.ok(!h.session.deriveMessages().some(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call')))
    assert.equal(original.data.message.content[0].text, 'tool invocation '.repeat(100))
    assert.equal(results[0].data.message.content[0].text, 'second result')
  }
})

test('last-output shortcuts include empty matching tool results', async t => {
  const h = await harness(t); h.user('keep')
  const id = ToolCallId('empty-result')
  const original = h.assistant('invoke tool', [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
  const result = h.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id, content: [], isError: false }) }, { surfaceOp: 'append' })
  assert.deepEqual(h.ctx.contextManager.select(h.agent, 'last'), [original.seq, result.seq])
  const outcome = await h.run('/ctx-d')
  assert.equal(outcome.kind, 'success', outcome.text)
  assert.equal(h.text(), 'keep')
})

test('last-output shortcuts refuse missing or mismatched results instead of expanding into unrelated content', async t => {
  const h = await harness(t); h.user('keep')
  const id = ToolCallId('missing-result')
  const original = h.assistant('invoke tool', [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
  const before = h.session.seq
  const missing = await h.run('/ctx-d')
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /matching tool result/)
  assert.deepEqual(h.session.surface.nodes, [SessionSeq(0), original.seq])
  assert.ok(h.session.seq > before) // Human-only command lifecycle, no surface change.
  h.tool(ToolCallId('unrelated-result'), 'must not be included')
  const mismatch = await h.run('/ctx-d')
  assert.equal(mismatch.kind, 'error')
  assert.ok(h.text().includes('must not be included'))
})

test('tool edits require complete call/result groups for replay-safe idle replacement', async t => {
  const h = await harness(t); h.user('question')
  const id = ToolCallId('call-1')
  const a = h.assistant('tool invocation', [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
  const b = h.tool(id, 'verbose tool result')
  const before = h.session.seq
  await assert.rejects(h.rewrite([{ kind: 'drop', seqs: [a.seq] }]), /matching tool result/)
  await assert.rejects(h.rewrite([{ kind: 'drop', seqs: [b.seq] }]), /Unpaired/)
  await assert.rejects(h.rewrite([{ kind: 'replace', seqs: [b.seq], text: 'short result' }]), /Unpaired/)
  assert.equal(h.session.seq, before)
  await h.rewrite([{ kind: 'replace', seqs: [a.seq, b.seq], text: 'tool completed' }])
  assert.equal(h.text(), 'question\ntool completed')
  assert.equal(b.data.message.content[0].text, 'verbose tool result')
})

test('compact uses auxiliary LLM call and durable summary events, with no instruction in conversation', async t => {
  const h = await harness(t); h.user('keep'); const original = h.assistant('important detail '.repeat(200))
  assert.equal((await h.run('/ctx-c')).kind, 'success')
  assert.equal(h.calls, 1)
  assert.equal(h.captured[0].purpose, 'compaction')
  assert.equal(h.captured[0].tools, undefined)
  assert.equal(h.text(), 'keep\nshort summary')
  assert.ok(!h.text().includes('Summarize'))
  assert.equal(original.data.message.content[0].text, 'important detail '.repeat(200))
  assert.deepEqual(h.session.snapshotEvents().filter(event => event.type.startsWith('compaction/')).map(event => event.type), ['compaction/start', 'compaction/summary', 'compaction/end'])
})

test('debug on displays full compact results for shortcut and explicit selections; off stays concise', async t => {
  const h = await harness(t)
  const summary = 'summary line\n'.repeat(100)
  h.setSummary(summary)
  h.assistant('original detail '.repeat(1000))
  assert.equal(h.ctx.contextManager.isDebug(h.agent), false)
  const plain = await h.run('/ctx-c')
  assert.equal(plain.kind, 'success')
  assert.ok(!plain.text.includes(summary))
  assert.ok(!plain.text.includes('Compacted content'))

  assert.equal((await h.run('/ctx-mod debug on')).kind, 'success')
  assert.equal(h.ctx.contextManager.isDebug(h.agent), true)
  for (const command of ['/ctx-c', '/ctx-mod compact last']) {
    h.assistant('original detail '.repeat(1000))
    const result = await h.run(command)
    assert.equal(result.kind, 'success', result.text)
    assert.ok(result.text.endsWith(summary))
    assert.match(result.text, /Compacted content \(seq \d+\):/)
    assert.ok(!h.text().includes('Compacted content'))
    assert.ok(!h.text().includes('replacement seqs:'))
  }
  await h.run('/ctx-mod debug off')
  assert.equal(h.ctx.contextManager.isDebug(h.agent), false)
  h.assistant('original detail '.repeat(1000))
  const afterOff = await h.run('/ctx-c')
  assert.equal(afterOff.kind, 'success')
  assert.ok(!afterOff.text.includes('Compacted content'))
})

test('debug compact returns each disconnected range summary in selection order', async t => {
  const h = await harness(t)
  h.assistant('first detail '.repeat(200)); h.user('keep between'); h.assistant('second detail '.repeat(200))
  await h.run('/ctx-mod debug on')
  let call = 0
  h.setDuring(async () => { h.setSummary(`summary ${++call}`) })
  const result = await h.run('/ctx-mod compact 1,3')
  assert.equal(result.kind, 'success', result.text)
  assert.equal((result.text.match(/Compacted content/g) ?? []).length, 2)
  assert.ok(result.text.indexOf('summary 1') < result.text.indexOf('summary 2'))
  assert.equal(h.text(), 'summary 1\nkeep between\nsummary 2')
})

test('atomic rewrite returns detached summaries independently of debug mode', async t => {
  const h = await harness(t); h.assistant('original detail '.repeat(200))
  const result = await h.rewrite([{ kind: 'compact', seqs: h.ctx.contextManager.select(h.agent, 'last') }])
  assert.deepEqual(result.summaries, [{ seq: result.replacementSeqs[0], content: [{ type: 'text', text: 'short summary' }] }])
  result.summaries[0].content[0].text = 'mutated by consumer'
  assert.equal(h.text(), 'short summary')
})

test('debug reports complete generated summary as not replaced when it is not smaller', async t => {
  const h = await harness(t); h.assistant('tiny')
  await h.run('/ctx-mod debug on')
  const summary = 'larger summary\n'.repeat(100)
  h.setSummary(summary)
  const result = await h.run('/ctx-c')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Generated summary \(not replaced;/)
  assert.match(result.text, /estimated tokens: \d+ -> \d+/)
  assert.ok(result.text.endsWith(summary))
  assert.equal(h.text(), 'tiny')
  assert.ok(!h.text().includes('Generated summary'))
  assert.ok(!h.session.snapshotEvents().some(event => event.type === 'compaction/summary'))
  await h.run('/ctx-mod debug off')
  const off = await h.run('/ctx-c')
  assert.equal(off.kind, 'error')
  assert.ok(!off.text.includes(summary))
})

test('atomic failures expose detached generated summaries even without debug', async t => {
  const h = await harness(t); const original = h.assistant('tiny')
  h.setSummary('too large '.repeat(100))
  await assert.rejects(h.rewrite([{ kind: 'compact', seqs: [original.seq] }]), error => {
    assert.ok(error instanceof ContextManagerError)
    assert.equal(error.generatedSummaries.length, 1)
    const summary = error.generatedSummaries[0]
    assert.deepEqual(summary.sourceSeqs, [original.seq])
    assert.equal(summary.replacementSeq, undefined)
    assert.ok(summary.afterTokens >= summary.beforeTokens)
    assert.deepEqual(error.committedSeqs, [])
    return true
  })
})

test('debug preserves prior committed summary and later rejected summary in partial batch failures', async t => {
  const h = await harness(t)
  h.assistant('first detail '.repeat(100)); h.user('keep between'); h.assistant('tiny')
  await h.run('/ctx-mod debug on')
  let call = 0
  h.setDuring(async () => { h.setSummary(++call === 1 ? 'first summary' : 'later summary too large '.repeat(100)) })
  const result = await h.run('/ctx-mod compact 1,3')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Already committed replacement seqs:/)
  assert.match(result.text, /replacement committed at seq/)
  assert.match(result.text, /Generated summary \(not replaced;/)
  assert.ok(result.text.includes('first summary'))
  assert.ok(result.text.includes('later summary too large '.repeat(100)))
  assert.equal(h.text(), 'first summary\nkeep between\ntiny')
})

test('debug flush failure does not label an already committed summary as not replaced', async t => {
  const h = await harness(t); h.assistant('original detail '.repeat(100))
  await h.run('/ctx-mod debug on')
  h.failFlush()
  const result = await h.run('/ctx-c')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /replacement committed at seq/)
  assert.ok(!result.text.includes('not replaced'))
  assert.ok(result.text.endsWith('short summary'))
  assert.equal(h.text(), 'short summary')
})

test('debug changed-selection failure still exposes its complete generated summary', async t => {
  const h = await harness(t); const original = h.assistant('original detail '.repeat(100))
  await h.run('/ctx-mod debug on')
  h.setDuring(async () => {
    h.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'external replacement' }] }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
    })
  })
  const result = await h.run('/ctx-c')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Selected context changed/)
  assert.match(result.text, /Generated summary \(not replaced;/)
  assert.ok(result.text.endsWith('short summary'))
  assert.equal(h.text(), 'external replacement')
})

test('failed, truncated and expanding summaries do not change the selected surface', async t => {
  const h = await harness(t); h.assistant('tiny')
  h.setSummary('bigger than the tiny original '.repeat(100))
  assert.equal((await h.run('/ctx-c')).kind, 'error')
  assert.equal(h.text(), 'tiny')
  h.setFinish({ kind: 'max-tokens' })
  h.setSummary('x')
  await h.run('/ctx-mod debug on')
  const truncated = await h.run('/ctx-c')
  assert.equal(truncated.kind, 'error')
  assert.ok(!truncated.text.includes('Generated summary'))
  assert.equal(h.text(), 'tiny')
  const brackets = h.session.snapshotEvents().filter(event => ['compaction/start', 'compaction/end'].includes(event.type))
  assert.equal(brackets.length, 4)
})

test('cancelled and changed selections fail without applying a summary', async t => {
  const h = await harness(t); const a = h.assistant('long text '.repeat(100))
  const controller = new AbortController()
  h.setDuring(async () => { controller.abort(new Error('user cancelled')) })
  await assert.rejects(h.ctx.contextManager.rewrite(h.agent, [{ kind: 'compact', seqs: [a.seq] }], controller.signal), /cancelled/)
  assert.equal(h.text(), 'long text '.repeat(100))
  h.setDuring(async () => { h.session.append('developer/message', { turn: 1, step: 1, message: { id: 'drop-racer', role: 'developer', source: { kind: 'user' }, content: [] } }, { surfaceOp: { op: 'replace', startSeq: a.seq, endSeq: a.seq }, sourceEventSeqs: [a.seq] }) })
  await assert.rejects(h.rewrite([{ kind: 'compact', seqs: [a.seq] }]), /changed/)
  assert.equal(h.text(), '')
})

test('busy agents reject edits, and flush failures disclose committed sequences', async t => {
  const h = await harness(t); h.assistant('answer'); h.setBusy(true)
  assert.throws(() => h.rewrite([{ kind: 'drop', seqs: h.ctx.contextManager.select(h.agent, 'last') }]), /busy/)
  h.setBusy(false); h.failFlush()
  await assert.rejects(h.rewrite([{ kind: 'drop', seqs: h.ctx.contextManager.select(h.agent, 'last') }]), error => error instanceof ContextManagerError && error.committedSeqs.length === 1 && /Already committed/.test(error.message))
  assert.equal(h.text(), '')
})

test('debug preserves complete content and captures actual requests without mutating them', async t => {
  const h = await harness(t); const long = 'all of this must remain visible '.repeat(1000); h.user(long)
  const result = await h.run('/ctx-mod debug')
  assert.equal(JSON.parse(result.text).messages[0].content[0].text, long)
  const options = markAgentLoopRequest(Object.freeze({ provider: 'mock', model: 'model', messages: h.session.deriveMessages(), sessionId: h.session.id }))
  const stream = h.ctx.waterfall(h.ctx.llm, 'llm/stream', options, async function* () {})
  for await (const _ of stream) {}
  const captured = await h.run('/ctx-mod debug last')
  assert.equal(JSON.parse(captured.text).messages[0].content[0].text, long)
  assert.ok(Object.isFrozen(options))
  const copy = h.ctx.contextManager.lastRequest(h.agent)
  copy.messages.length = 0
  assert.equal(h.ctx.contextManager.lastRequest(h.agent).messages.length, 1)
})

test('unloading command plugin cancels a pending compact before draining', { timeout: 5000 }, async t => {
  const h = await harness(t); h.assistant('long original '.repeat(200))
  const started = Promise.withResolvers()
  h.setDuring(async options => {
    started.resolve()
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(options.signal.reason)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  })
  const command = h.run('/ctx-c')
  await started.promise
  await h.commandFiber.dispose()
  assert.equal((await command).kind, 'error')
  assert.equal(h.text(), 'long original '.repeat(200))
})

test('missing terminal summary finish never lands partial text', async t => {
  const h = await harness(t); h.assistant('long original '.repeat(200))
  h.ctx.on('llm/stream', options => (async function* () { yield { type: 'text-delta', index: 0, text: 'partial' } })(), { prepend: true })
  assert.equal((await h.run('/ctx-c')).kind, 'error')
  assert.equal(h.text(), 'long original '.repeat(200))
})
