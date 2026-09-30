// Lifecycle, status, usage, gaps and anomalies: what the reducer does with each verb.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduce, createReducer, markStalled, messageText, usageTotal, toolArguments } from '../dist/index.js'
import { ev, seqd, json } from './fixtures/util.js'

test('an empty stream is idle; the first event makes it streaming; run.finish makes it done', () => {
  assert.equal(reduce([]).status, 'idle')
  assert.equal(reduce([ev('run.start', { provider: 'p', model: 'm' })]).status, 'streaming')
  const done = reduce([ev('run.start'), ev('run.finish', { reason: 'stop', raw_reason: 'end_turn' })])
  assert.deepEqual([done.status, done.finishReason, done.rawReason], ['done', 'stop', 'end_turn'])
})

test('run.error is status error with the error; run.abort is done and aborted with its reason', () => {
  const e = reduce([ev('run.error', { code: 'stream_lost', retryable: true, message: 'gone' })])
  assert.deepEqual([e.status, e.error], ['error', { code: 'stream_lost', retryable: true, message: 'gone' }])
  const a = reduce([ev('run.start'), ev('run.abort', { reason: 'user' })])
  assert.deepEqual([a.status, a.aborted, a.abortReason], ['done', true, 'user'])
})

test('the message id is the run id until a message starts, then the message id; provider and model come from run.start', () => {
  const a = reduce([ev('run.start', { provider: 'anthropic', model: 'claude' })])
  assert.deepEqual([a.id, a.runId, a.provider, a.model], ['run-1', 'run-1', 'anthropic', 'claude'])
  const b = reduce([ev('run.start'), ev('message.start', { message_id: 'msg-1', role: 'assistant' })])
  assert.deepEqual([b.id, b.role], ['msg-1', 'assistant'])
})

test('text, reasoning and refusal parts accumulate text; tool_call parts accumulate arguments', () => {
  const m = reduce(seqd([
    ev('message.start', { message_id: 'm', role: 'assistant' }),
    ev('part.start', { part_id: 'r', kind: 'reasoning' }), ev('part.delta', { part_id: 'r', text: 'hmm' }), ev('part.end', { part_id: 'r', final: 'sig' }),
    ev('part.start', { part_id: 't', kind: 'text' }), ev('part.delta', { part_id: 't', text: 'Hel' }), ev('part.delta', { part_id: 't', text: 'lo' }), ev('part.end', { part_id: 't' }),
    ev('part.start', { part_id: 'c', kind: 'tool_call', meta: { name: 'go' } }), ev('part.delta', { part_id: 'c', json_fragment: '{"a":' }), ev('part.delta', { part_id: 'c', json_fragment: '1}' }),
    ev('message.end', { message_id: 'm' }),
  ]))
  assert.equal(messageText(m), 'Hello')
  assert.equal(m.parts[0].final, 'sig')
  assert.equal(m.parts[2].args, '{"a":1}')
  assert.equal(m.parts[2].open, true, 'a tool call still being written is open')
  assert.deepEqual(toolArguments(m.parts[2]), { a: 1 }, 'complete fragments parse')
  assert.equal(toolArguments({ args: '{"a":' }), undefined, 'partial fragments do not')
  assert.equal(m.parts.every((p) => p.messageId === 'm'), true)
  assert.equal(m.messageOpen, false)
})

test('usage: cumulative and final replace; delta adds; total is the sum of components and the wire total is ignored', () => {
  const cum = reduce([ev('usage', { usage: { scope: 'cumulative', uncached_input: 10, output: 1, total: 999 } }), ev('usage', { usage: { scope: 'cumulative', uncached_input: 10, cache_read: 500, output: 40 } })])
  assert.equal(usageTotal(cum.usage), 550)
  assert.equal('total' in cum.usage, false)
  const del = reduce([ev('usage', { usage: { scope: 'delta', uncached_input: 1, output: 2, extra: { web: 1 } } }), ev('usage', { usage: { scope: 'delta', uncached_input: 3, cache_write: 4, output: 5, reasoning: 6, extra: { web: 2, img: 1 } } })])
  assert.deepEqual(del.usage, { scope: 'cumulative', uncached_input: 4, cache_write: 4, output: 7, reasoning: 6, extra: { web: 3, img: 1 } })
  assert.equal(usageTotal(del.usage), 21, 'extra is never part of the total')
  const fin = reduce([ev('usage', { usage: { scope: 'cumulative', uncached_input: 1, output: 1 } }), ev('run.finish', { usage: { scope: 'final', uncached_input: 7, cache_read: 100, output: 9 } })])
  assert.equal(usageTotal(fin.usage), 116, 'the final report replaces what was cumulative')
})

test('a gap makes the message incomplete and is recorded; what its lost opening explains is skipped, not rejected', () => {
  const m = reduce(seqd([
    ev('run.start'),
    ev('gap', { from: 2, to: 9, reason: 'retention' }),
    ev('part.delta', { part_id: 'lost', text: 'x' }), // its part.start fell in the gap
    ev('part.end', { part_id: 'lost' }),
    ev('message.end', { message_id: 'lost' }),
    ev('step.finish', { step_id: 'lost' }),
    ev('part.start', { part_id: 'ok', kind: 'text' }),
    ev('part.delta', { part_id: 'ok', text: 'after' }),
  ]))
  assert.equal(m.incomplete, true)
  assert.deepEqual(m.gaps, [{ from: 2, to: 9, reason: 'retention' }])
  assert.deepEqual(m.anomalies, [])
  assert.equal(messageText(m), 'after')
})

test('without a gap, the same orphans are anomalies (recorded, not applied, and nothing throws)', () => {
  const m = reduce(seqd([
    ev('part.delta', { part_id: 'lost', text: 'x' }), ev('part.end', { part_id: 'lost' }), ev('message.end'), ev('step.finish', { step_id: 's' }),
    ev('run.start'), ev('run.start'),
    ev('part.start', { part_id: 'p', kind: 'tool_call' }), ev('part.start', { part_id: 'p', kind: 'tool_call' }),
    ev('part.delta', { part_id: 'p', text: 'x' }), ev('part.delta', { part_id: 'p', text: 'x', json_fragment: '{}' }),
    ev('part.start', { part_id: 'q', kind: 'text' }), ev('part.delta', { part_id: 'q', json_fragment: '{}' }),
    ev('message.start', { message_id: 'a' }), ev('message.start', { message_id: 'b' }),
    ev('usage'), { ...ev('part.start', { part_id: 'z' }), run_id: 'other-run' },
  ]))
  assert.deepEqual(m.anomalies.map((a) => a.reason.split(' ').slice(0, 3).join(' ')), [
    'part.delta for part', 'part.end for part', 'message.end with no', 'step.finish for step',
    'run.start twice', 'part "p" is', 'text on a', 'part.delta carries both',
    'json_fragment on a', 'message.start inside message', 'usage event without', 'run id "other-run",',
  ])
  assert.equal(m.status, 'streaming')
})

test('an event after the terminal event is an anomaly and changes nothing', () => {
  const done = reduce(seqd([ev('run.start'), ev('run.finish')]))
  const after = reduce(seqd([ev('part.start', { part_id: 'x', kind: 'text' })]).map((e) => ({ ...e, seq: 3 })), done)
  assert.equal(after.parts.length, 0)
  assert.equal(after.anomalies.length, 1)
  assert.equal(after.status, 'done')
})

test('unknown verbs and unknown part kinds are ignored or kept, never fatal (the schema is additive)', () => {
  const m = reduce(seqd([ev('a.new.verb', { whatever: 1 }), ev('part.start', { part_id: 'n', kind: 'hologram' }), ev('part.delta', { part_id: 'n', text: 'x' })]))
  assert.equal(m.anomalies.length, 0)
  assert.equal(m.parts[0].kind, 'hologram')
  assert.equal(m.parts[0].text, 'x')
})

test('steps, approvals, activities and raws are collected', () => {
  const m = reduce(seqd([
    ev('step.start', { step_id: 's1', name: 'call 1' }), ev('step.finish', { step_id: 's1' }),
    ev('approval.request', { approval_id: 'ap', call_id: 'c', reason: 'rm -rf', descriptor: { cmd: 'rm' }, mode: 'inband', expires_at: '2026-01-01T00:01:00Z' }),
    ev('activity', { kind: 'nanite.slot', value: { a: 1 }, patch: [{ op: 'add' }] }),
    ev('raw', { raw: { dialect: 'd', type: 't', payload: 'not json' } }),
    ev('raw'),
  ]))
  assert.deepEqual(m.steps, [{ id: 's1', name: 'call 1', open: false }])
  assert.deepEqual(m.approvals, [{ id: 'ap', callId: 'c', reason: 'rm -rf', descriptor: { cmd: 'rm' }, mode: 'inband', expiresAt: '2026-01-01T00:01:00Z' }])
  assert.deepEqual(m.activities, [{ kind: 'nanite.slot', value: { a: 1 }, patch: [{ op: 'add' }] }])
  assert.deepEqual(m.raws, [{ dialect: 'd', type: 't', payload: 'not json' }])
})

test('markStalled: streaming becomes stalled, the next event returns it to streaming, other statuses are untouched', () => {
  const s = markStalled(reduce([ev('run.start')]))
  assert.equal(s.status, 'stalled')
  assert.equal(reduce([ev('message.start', { message_id: 'm' })], s).status, 'streaming')
  assert.equal(markStalled(reduce([])).status, 'idle')
  assert.equal(markStalled(reduce([ev('run.finish')])).status, 'done')
  assert.equal(markStalled(json(s)).status, 'stalled', 'a stored stalled snapshot is adopted')
})

test('createReducer: push returns the new message, snapshot the current one, and a prior resumes it', () => {
  const r = createReducer()
  assert.equal(r.snapshot().status, 'idle')
  const a = r.push(ev('run.start', { seq: 1 }))
  assert.equal(a.status, 'streaming')
  assert.equal(r.snapshot(), a)
  r.push(ev('part.start', { seq: 2, part_id: 'p', kind: 'text' }))
  r.push(ev('part.start', { seq: 2, part_id: 'p', kind: 'text' })) // a duplicate id: skipped
  assert.equal(r.snapshot().parts.length, 1)
  assert.equal(r.snapshot().anomalies.length, 0)
  const resumed = createReducer(json(r.snapshot()))
  assert.equal(resumed.push(ev('part.delta', { seq: 3, part_id: 'p', text: 'z' })).parts[0].text, 'z')
})

test('a stored snapshot that is malformed is adopted without throwing', () => {
  for (const bad of [{}, { parts: 'no' }, { status: 'weird', lastSeq: -3, parts: [1, null, {}] }, [], 'str', 7]) {
    const m = reduce([ev('run.start', { seq: 1 })], bad)
    assert.equal(m.status, 'streaming')
  }
})
