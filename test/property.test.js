// Fuzz and property tests over arbitrary event sequences (seeded, so a failure reproduces).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduce, createReducer, markStalled, toolCalls, messageText } from '../dist/index.js'
import { goldens, deepFreeze, rng, json } from './fixtures/util.js'

const VERBS = ['run.start', 'run.finish', 'run.error', 'run.abort', 'step.start', 'step.finish', 'message.start', 'message.end', 'part.start', 'part.delta', 'part.end', 'approval.request', 'usage', 'activity', 'raw', 'gap', 'nope', '', 'RUN.START']
const KINDS = ['text', 'reasoning', 'tool_call', 'tool_result', 'source', 'file', 'refusal', 'data', 'x', '']
const IDS = ['a', 'b', 'c', '', '__proto__', 'constructor']

const pick = (r, a) => a[Math.floor(r() * a.length)]
function junk(r, depth = 0) {
  switch (Math.floor(r() * (depth > 2 ? 6 : 8))) {
    case 0: return null
    case 1: return Math.floor(r() * 100) - 20
    case 2: return r() < 0.5
    case 3: return pick(r, ['', 'x', 'true', '{"a":1}', 'é', '\u{1F600}'])
    case 4: return 1.5
    case 5: return undefined
    case 6: return Array.from({ length: Math.floor(r() * 3) }, () => junk(r, depth + 1))
    default: return Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, () => [pick(r, ['k', 'name', 'call_id', 'is_error', '__proto__', 'x']), junk(r, depth + 1)]))
  }
}

/** A random event: mostly plausible fields with the right types, sometimes junk anywhere. */
function randomEvent(r) {
  const e = { v: '1', seq: r() < 0.7 ? Math.floor(r() * 30) : junk(r), run_id: r() < 0.9 ? 'run-1' : pick(r, ['', 'other', junk(r)]), time: 't', verb: r() < 0.9 ? pick(r, VERBS) : junk(r) }
  const fields = {
    part_id: () => pick(r, IDS), kind: () => pick(r, KINDS), text: () => pick(r, ['', 'a', 'bc']), json_fragment: () => pick(r, ['', '{', '"x"}', '1']),
    step_id: () => pick(r, IDS), message_id: () => pick(r, IDS), name: () => pick(r, IDS), role: () => 'assistant',
    meta: () => (r() < 0.5 ? { name: pick(r, IDS), call_id: pick(r, IDS), is_error: r() < 0.5 } : junk(r)),
    final: () => junk(r), usage: () => (r() < 0.6 ? { scope: pick(r, ['cumulative', 'final', 'delta', 'weird']), uncached_input: Math.floor(r() * 9), output: Math.floor(r() * 9), cache_read: junk(r), extra: junk(r) } : junk(r)),
    from: () => Math.floor(r() * 9), to: () => Math.floor(r() * 9), reason: () => pick(r, ['stop', 'retention', '']), code: () => 'c', retryable: () => r() < 0.5, message: () => 'm',
    approval_id: () => 'ap', call_id: () => pick(r, IDS), descriptor: () => junk(r), mode: () => 'inband', value: () => junk(r), patch: () => junk(r), raw: () => (r() < 0.6 ? { dialect: 'd', type: 't', payload: junk(r) } : junk(r)),
    provider: () => 'p', model: () => 'm', raw_reason: () => 'x', expires_at: () => 't', ext: () => junk(r),
  }
  for (const k of Object.keys(fields)) if (r() < 0.25) e[k] = r() < 0.9 ? fields[k]() : junk(r)
  return e
}

const NOT_EVENTS = [null, undefined, 1, 'x', [], [1], true]

/** A plausible run of n events, then mutated: dropped, duplicated, reordered, corrupted. */
function mutatedRun(r, base) {
  let events = base.map((e, i) => ({ ...e, seq: i + 1 }))
  const ops = Math.floor(r() * 5)
  for (let i = 0; i < ops; i++) {
    const at = Math.floor(r() * events.length)
    switch (Math.floor(r() * 5)) {
      case 0: events.splice(at, 1); break
      case 1: events.splice(at, 0, { ...events[at] }); break
      case 2: { const b = Math.floor(r() * events.length); [events[at], events[b]] = [events[b], events[at]]; break }
      case 3: events[at] = { ...events[at], [pick(r, ['verb', 'part_id', 'text', 'seq', 'run_id', 'meta'])]: junk(r) }; break
      default: events.splice(at, 0, pick(r, NOT_EVENTS))
    }
  }
  return events
}

test('property: reduce never throws on arbitrary event sequences, including non-events and junk field types (5000 sequences)', () => {
  const r = rng(1)
  for (let n = 0; n < 5000; n++) {
    const events = Array.from({ length: Math.floor(r() * 25) }, () => (r() < 0.03 ? pick(r, NOT_EVENTS) : randomEvent(r)))
    const m = reduce(events)
    assert.ok(['idle', 'streaming', 'stalled', 'error', 'done'].includes(m.status))
    assert.ok(Array.isArray(m.parts) && Number.isSafeInteger(m.lastSeq) && m.lastSeq >= 0)
    JSON.stringify(m) // stays serializable
    toolCalls(m); messageText(m); markStalled(m)
  }
})

test('property: the reducer never mutates its inputs, whatever they are (deep-frozen events and prior, 2000 sequences)', () => {
  const r = rng(2)
  for (let n = 0; n < 2000; n++) {
    const events = deepFreeze(Array.from({ length: Math.floor(r() * 20) }, () => randomEvent(r)).map((e) => json(e)))
    const cut = Math.floor(r() * (events.length + 1))
    const prior = json(reduce(events.slice(0, cut)))
    deepFreeze(prior)
    reduce(events.slice(cut), prior)
    reduce(events, prior)
  }
})

test('property: deterministic, and resume-from-cursor (also through JSON) equals full replay, on arbitrary sequences (3000 sequences)', () => {
  const r = rng(3)
  for (let n = 0; n < 3000; n++) {
    const events = Array.from({ length: Math.floor(r() * 25) }, () => randomEvent(r))
    const full = reduce(events)
    assert.deepEqual(reduce(events), full, 'deterministic')
    const k = Math.floor(r() * (events.length + 1))
    const head = reduce(events.slice(0, k))
    assert.deepEqual(reduce(events.slice(k), head), full, `resume at ${k}`)
    assert.deepEqual(reduce(events.slice(k), json(head)), full, `resume via JSON at ${k}`)
    const p = createReducer()
    for (const e of events) p.push(e)
    assert.deepEqual(p.snapshot(), full, 'incremental push')
  }
})

test('property: replaying a duplicated event id is idempotent (2000 mutated runs from real goldens)', () => {
  const r = rng(4)
  const gs = goldens()
  for (let n = 0; n < 2000; n++) {
    const g = pick(r, gs)
    // idempotence is about SEQUENCED events (a duplicated event id); an unsequenced event (seq 0) is applied every time by design
    const events = mutatedRun(r, g.events).filter((e) => e && typeof e === 'object' && Number.isSafeInteger(e.seq) && e.seq > 0)
    const once = reduce(events)
    // duplicate a random subset of the events (same seq, same content) in place, and replay the tail again
    const dup = events.flatMap((e) => (r() < 0.3 ? [e, e] : [e]))
    assert.deepEqual(reduce(dup), once, 'adjacent duplicates')
    const back = Math.floor(r() * events.length)
    assert.deepEqual(reduce([...events, ...events.slice(back)]), once, 'the tail delivered again after the run')
    assert.deepEqual(reduce(events.slice(Math.max(0, back - 4)), reduce(events.slice(0, back))), once, 'an overlapping resume')
  }
})

test('property: lifecycle mutations of real runs (dropped, duplicated, reordered, corrupted events) never throw and stay serializable (2000 runs)', () => {
  const r = rng(5)
  const gs = goldens()
  for (let n = 0; n < 2000; n++) {
    const events = mutatedRun(r, pick(r, gs).events)
    const m = reduce(events)
    JSON.parse(JSON.stringify(m))
    assert.ok(m.anomalies.length <= 100)
  }
})

test('property: a "__proto__" key or part id in an event does not pollute anything', () => {
  const evil = JSON.parse('{"v":"1","seq":1,"run_id":"r","time":"t","verb":"part.start","part_id":"__proto__","kind":"tool_result","meta":{"__proto__":{"polluted":true},"call_id":"__proto__","is_error":true}}')
  const m = reduce([evil])
  assert.equal({}.polluted, undefined)
  assert.equal(m.parts[0].meta.polluted, undefined)
  assert.equal(Object.getPrototypeOf(m.parts[0].meta), Object.prototype)
  assert.equal(Object.keys(m.parts[0].meta).includes('__proto__'), true)
})
