import test from 'node:test'
import assert from 'node:assert/strict'
import { formatEntries, parseInput } from '../src/commands.ts'
import type { Entry } from '../src/commands.ts'

function entry(index: number, seq: number, role: Entry['message']['role'], text: string): Entry {
  return {
    index,
    seq: seq as Entry['seq'],
    editable: role !== 'system' && role !== 'developer',
    message: { id: `message-${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] } as Entry['message'],
  }
}

test('empty input and explicit help are help actions', () => {
  for (const input of ['', ' ', '\t\r\n', 'help', ' help \t\n']) {
    assert.deepEqual(parseInput(input), { kind: 'help' })
  }
})

test('list is a distinct action with no additional arguments', () => {
  assert.deepEqual(parseInput(' \tlist\r\n'), { kind: 'list' })
  assert.equal(parseInput('list extra').kind, 'error')
  assert.equal(parseInput('help extra').kind, 'error')
})

test('debug parses full snapshot, full last request and toggles', () => {
  assert.deepEqual(parseInput(' debug '), { kind: 'debug' })
  assert.deepEqual(parseInput(' debug on\n'), { kind: 'debug-set', enabled: true })
  assert.deepEqual(parseInput(' debug off'), { kind: 'debug-set', enabled: false })
  assert.deepEqual(parseInput(' debug last'), { kind: 'debug-last' })
  for (const input of ['debug yes', 'debug on extra', 'debug last extra']) {
    assert.equal(parseInput(input).kind, 'error')
  }
})

test('selectors remain opaque for the service to validate and resolve', () => {
  for (const selector of ['last', '1', '1,3-5', 'seq:9']) {
    assert.deepEqual(parseInput(`drop ${selector}`), { kind: 'drop', selector })
    assert.deepEqual(parseInput(`compact ${selector}`), { kind: 'compact', selector })
    assert.deepEqual(parseInput(`replace ${selector} payload`), { kind: 'replace', selector, text: 'payload' })
  }
  assert.deepEqual(parseInput('drop invalid-selector'), { kind: 'drop', selector: 'invalid-selector' })
})

test('replace preserves remaining exact text, trailing spaces and all newlines', () => {
  const text = '  first line\r\n\tsecond line\nthird line  \n'
  assert.deepEqual(parseInput(` \t replace  1,3-5 ${text}`), {
    kind: 'replace', selector: '1,3-5', text,
  })
})

test('replacement has exactly one separator; CRLF is one separator', () => {
  assert.deepEqual(parseInput('replace last\t\tdata'), { kind: 'replace', selector: 'last', text: '\tdata' })
  assert.deepEqual(parseInput('replace last\n\nbody'), { kind: 'replace', selector: 'last', text: '\nbody' })
  assert.deepEqual(parseInput('replace last\r\n\r\nbody'), { kind: 'replace', selector: 'last', text: '\r\nbody' })
})

test('replacement text is not recursively parsed as a command', () => {
  const text = '/ctx-mod drop seq:9\n/ctx-d'
  assert.deepEqual(parseInput(`replace last ${text}`), { kind: 'replace', selector: 'last', text })
  assert.deepEqual(parseInput(` ${text}`, 'ctx-r'), { kind: 'replace', selector: 'last', text })
})

test('missing selectors and empty replacement payloads are errors', () => {
  for (const input of ['replace', 'replace last', 'replace last \t\r\n', 'drop', 'compact']) {
    assert.equal(parseInput(input).kind, 'error', input)
  }
  for (const input of ['', ' ', '\t\r\n']) {
    assert.equal(parseInput(input, 'ctx-r').kind, 'error')
  }
})

test('drop and compact reject extra arguments', () => {
  for (const input of ['drop last text', 'compact last text', 'drop 1 3', 'compact seq:9\nextra']) {
    assert.equal(parseInput(input).kind, 'error', input)
  }
  assert.deepEqual(parseInput('drop seq:9\r\n\t'), { kind: 'drop', selector: 'seq:9' })
})

test('unknown subcommands produce an error instead of model fallback', () => {
  const action = parseInput('does-not-exist arbitrary text')
  assert.equal(action.kind, 'error')
  if (action.kind === 'error') assert.match(action.text, /Unknown \/ctx-mod subcommand/)
  assert.equal(parseInput('/ctx-mod list').kind, 'error')
})

test('ctx-c and ctx-d select last and accept no arguments', () => {
  for (const input of ['', ' \t\r\n']) {
    assert.deepEqual(parseInput(input, 'ctx-c'), { kind: 'compact', selector: 'last' })
    assert.deepEqual(parseInput(input, 'ctx-d'), { kind: 'drop', selector: 'last' })
  }
  for (const alias of ['ctx-c', 'ctx-d'] as const) {
    assert.equal(parseInput('last', alias).kind, 'error')
    assert.equal(parseInput('help', alias).kind, 'error')
  }
})

test('ctx-r replaces last using its entire remaining input, never a selector', () => {
  const text = 'last is literal text\nsecond line  '
  assert.deepEqual(parseInput(` ${text}`, 'ctx-r'), { kind: 'replace', selector: 'last', text })
  assert.deepEqual(parseInput('payload without a separator', 'ctx-r'), {
    kind: 'replace', selector: 'last', text: 'payload without a separator',
  })
  assert.deepEqual(parseInput('   indented\r\n', 'ctx-r'), {
    kind: 'replace', selector: 'last', text: '  indented\r\n',
  })
})

test('long replacement payloads are not truncated', () => {
  const text = `${'full context '.repeat(1000)}\n${'next line '.repeat(1000)}  `
  assert.deepEqual(parseInput(`replace seq:9 ${text}`), { kind: 'replace', selector: 'seq:9', text })
  assert.deepEqual(parseInput(` ${text}`, 'ctx-r'), { kind: 'replace', selector: 'last', text })
})

test('formatEntries displays index, stable seq, role and a single-line preview', () => {
  const entries = [entry(1, 9, 'user', 'hello\n\tworld'), entry(2, 27, 'assistant', 'answer')]
  assert.equal(formatEntries(entries), 'index\tseq\trole\tpreview\n1\t9\tuser\thello world\n2\t27\tassistant\tanswer')
  assert.equal(entries[0]!.message.content[0]!.type, 'text')
  assert.deepEqual(entries[0]!.message.content, [{ type: 'text', text: 'hello\n\tworld' }])
})

test('formatEntries truncates only long list previews and leaves original messages untouched', () => {
  const atLimit = entry(1, 1, 'user', 'x'.repeat(120))
  const overLimit = entry(2, 2, 'assistant', 'x'.repeat(121))
  const result = formatEntries([atLimit, overLimit])
  assert.equal(result, `index\tseq\trole\tpreview\n1\t1\tuser\t${'x'.repeat(120)}\n2\t2\tassistant\t${'x'.repeat(119)}…`)
  assert.deepEqual(overLimit.message.content, [{ type: 'text', text: 'x'.repeat(121) }])
})

test('formatEntries includes non-text content and handles empty entries', () => {
  const item = entry(1, 9, 'assistant', '')
  const withTool = {
    ...item,
    message: {
      ...item.message,
      content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }],
    } as Entry['message'],
  }
  assert.match(formatEntries([withTool]), /tool-call/)
  assert.match(formatEntries([withTool]), /read_file/)
  assert.equal(formatEntries([]), 'No context entries.')
})
