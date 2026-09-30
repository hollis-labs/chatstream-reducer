// The defects this package exists to not carry forward.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduce, toolCalls } from '../dist/index.js'
import { ev, seqd } from './fixtures/util.js'

const toolRun = (resultMeta, resultFinal) => seqd([
  ev('run.start'),
  ev('part.start', { part_id: 'call-1', kind: 'tool_call', meta: { name: 'delete_file' } }),
  ev('part.end', { part_id: 'call-1', final: { path: '/etc/passwd' } }),
  ev('part.start', { part_id: 'res-1', kind: 'tool_result', meta: resultMeta }),
  ev('part.end', { part_id: 'res-1', ...(resultFinal !== undefined ? { final: resultFinal } : {}) }),
  ev('run.finish', { reason: 'tool_calls' }),
])

// Flux's reducer read `data.error` where Nanite sets `is_error`, so a denied tool showed as done.
test('a denied tool (tool_result with meta.is_error true and no meta.error) is an error, not done', () => {
  const m = reduce(toolRun({ call_id: 'call-1', is_error: true }, 'permission denied'))
  const [call] = toolCalls(m)
  assert.equal(call.status, 'error')
  assert.equal(call.resultPart.isError, true)
  // what the naive read sees on this very event: no `error` key at all, so it would say "done"
  assert.equal(call.resultPart.meta.error, undefined)
  const naive = call.resultPart.meta.error ? 'error' : 'done'
  assert.equal(naive, 'done', 'the fixture really is one that the naive read gets wrong')
})

test('a successful tool is done; a tool with no result yet is running; a failed one is error', () => {
  assert.equal(toolCalls(reduce(toolRun({ call_id: 'call-1' }, 'ok')))[0].status, 'done')
  assert.equal(toolCalls(reduce(toolRun({ call_id: 'call-1', is_error: false }, 'ok')))[0].status, 'done')
  assert.equal(toolCalls(reduce(toolRun({ call_id: 'call-1', is_error: true }, 'boom')))[0].status, 'error')
  const running = reduce(seqd([ev('run.start'), ev('part.start', { part_id: 'call-1', kind: 'tool_call', meta: { name: 't' } })]))
  assert.equal(toolCalls(running)[0].status, 'running')
})

test('only the boolean true is an error: the string "true" and a truthy meta.error are not', () => {
  assert.equal(toolCalls(reduce(toolRun({ call_id: 'call-1', is_error: 'true' })))[0].status, 'done')
  assert.equal(toolCalls(reduce(toolRun({ call_id: 'call-1', error: 'x' })))[0].status, 'done')
})

test('a result links to its call by call_id, whatever the order of parts', () => {
  const m = reduce(seqd([
    ev('part.start', { part_id: 'a', kind: 'tool_call', meta: { name: 'one' } }),
    ev('part.start', { part_id: 'b', kind: 'tool_call', meta: { name: 'two' } }),
    ev('part.start', { part_id: 'rb', kind: 'tool_result', meta: { call_id: 'b', is_error: true } }),
    ev('part.start', { part_id: 'ra', kind: 'tool_result', meta: { call_id: 'a' } }),
  ]))
  assert.deepEqual(toolCalls(m).map((c) => [c.name, c.status]), [['one', 'done'], ['two', 'error']])
})

// The other two named defects (a stall detector driven by content; the spike's "every error is
// terminal" and its first-attach gap check) are in the transport, and are tested in
// @hollis-labs/chatstream-client. What the reducer can do about them is below.
test('a non-terminal error does not end the run: raw and activity events carrying errors leave it streaming, and content after them is applied', () => {
  const m = reduce(seqd([
    ev('run.start'),
    ev('raw', { raw: { dialect: 'claude.stream-json', type: 'error', payload: { error: 'overloaded' } } }),
    ev('activity', { kind: 'claude.assistant_error', value: { error: 'rate_limit' } }),
    ev('part.start', { part_id: 't', kind: 'text' }),
    ev('part.delta', { part_id: 't', text: 'recovered' }),
  ]))
  assert.equal(m.status, 'streaming')
  assert.equal(m.raws.length, 1)
  assert.equal(m.parts[0].text, 'recovered')
})

test('only run.error is an error, and it is terminal: nothing after it is applied', () => {
  const m = reduce(seqd([ev('run.start'), ev('run.error', { code: 'upstream_truncated', retryable: true, message: 'cut' }), ev('part.start', { part_id: 'x', kind: 'text' })]))
  assert.equal(m.status, 'error')
  assert.deepEqual(m.error, { code: 'upstream_truncated', retryable: true, message: 'cut' })
  assert.equal(m.parts.length, 0)
  assert.equal(m.anomalies.length, 1)
})
