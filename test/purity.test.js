// Purity: the reducer reads only its arguments, writes to none of them, and touches no
// global; the same inputs always give equal outputs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reduce, createReducer, markStalled } from '../dist/index.js'
import { goldens, deepFreeze, clone, ev, seqd } from './fixtures/util.js'

test('reduce never mutates its input events or its prior (both deep-frozen: a write would throw), for every golden', () => {
  for (const g of goldens()) {
    const events = deepFreeze(clone(g.sequenced))
    const cut = Math.floor(events.length / 2)
    const prior = reduce(events.slice(0, cut))
    const stored = deepFreeze(JSON.parse(JSON.stringify(prior)))
    reduce(events.slice(cut), stored)
    reduce(events.slice(cut), prior)
    reduce(events)
    // and nothing leaked back: the inputs are still exactly what they were
    assert.deepEqual(events, g.sequenced, g.name)
    assert.deepEqual(stored, JSON.parse(JSON.stringify(prior)), g.name)
  }
})

test('the input state object is not modified by reduce: same reference, same content, before and after', () => {
  const prior = reduce(seqd([ev('run.start'), ev('part.start', { part_id: 'p', kind: 'text' }), ev('part.delta', { part_id: 'p', text: 'a' })]))
  const before = JSON.stringify(prior)
  const partsBefore = prior.parts
  const next = reduce([ev('part.delta', { seq: 4, part_id: 'p', text: 'b' })], prior)
  assert.equal(JSON.stringify(prior), before)
  assert.equal(prior.parts, partsBefore)
  assert.notEqual(next, prior)
  assert.equal(prior.parts[0].text, 'a')
  assert.equal(next.parts[0].text, 'ab')
})

test('a mutable prior (as if from JSON.parse) is not written to either', () => {
  const prior = JSON.parse(JSON.stringify(reduce(seqd([ev('run.start'), ev('part.start', { part_id: 'p', kind: 'text', meta: { k: [1] } })]))))
  const before = JSON.stringify(prior)
  const next = reduce([ev('part.delta', { seq: 3, part_id: 'p', text: 'x' })], prior)
  assert.equal(JSON.stringify(prior), before)
  assert.equal(Object.isFrozen(prior), false)
  assert.notEqual(next.parts[0].meta, prior.parts[0].meta, 'meta is copied, not shared, with a snapshot that is not ours')
})

test('a message does not alias the events it was built from: mutating an event afterwards changes nothing', () => {
  const e = ev('part.start', { seq: 1, part_id: 'p', kind: 'tool_call', meta: { name: 'a', nested: { x: 1 } } })
  const m = reduce([e])
  e.meta.nested.x = 99
  e.meta.name = 'changed'
  assert.equal(m.parts[0].meta.nested.x, 1)
  assert.equal(m.parts[0].name, 'a')
})

test('returned messages are frozen, so a consumer cannot corrupt a snapshot the reducer shares structure with', () => {
  const m = reduce(seqd([ev('run.start'), ev('part.start', { part_id: 'p', kind: 'text' })]))
  assert.throws(() => { m.status = 'done' }, TypeError)
  assert.throws(() => { m.parts.push({}) }, TypeError)
  assert.throws(() => { m.parts[0].text = 'x' }, TypeError)
  const c = createReducer(); c.push(ev('run.start'))
  assert.throws(() => { c.snapshot().status = 'x' }, TypeError)
  assert.throws(() => { markStalled(m).status = 'x' }, TypeError)
})

test('deterministic: the same events give deeply equal messages, run after run', () => {
  for (const g of goldens()) assert.deepEqual(reduce(g.sequenced), reduce(clone(g.sequenced)), g.name)
})

test('untouched parts are shared between a message and its successor (structural sharing, not a full copy)', () => {
  const a = reduce(seqd([ev('part.start', { part_id: 'a', kind: 'text' }), ev('part.end', { part_id: 'a' }), ev('part.start', { part_id: 'b', kind: 'text' })]))
  const b = reduce([ev('part.delta', { seq: 4, part_id: 'b', text: 'x' })], a)
  assert.equal(b.parts[0], a.parts[0])
  assert.notEqual(b.parts[1], a.parts[1])
})

// The reducer must not read a clock, a random source, the network, the file system or the
// environment. Loaded in a process where every one of them throws when touched, it still
// reduces a run and gives the right answer.
test('with the clock, timers, randomness, network, process and console poisoned, it still reduces (no hidden globals)', () => {
  const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const program = `
    const boom = (n) => () => { throw new Error('touched ' + n) }
    for (const n of ['setTimeout','setInterval','setImmediate','queueMicrotask','fetch','XMLHttpRequest','WebSocket','EventSource','structuredClone','performance','crypto','localStorage','navigator','document','window'])
      { try { Object.defineProperty(globalThis, n, { get: boom(n), configurable: true }) } catch {} }
    Math.random = boom('Math.random'); Date.now = boom('Date.now'); Date.prototype.getTime = boom('Date#getTime')
    const { reduce, createReducer, markStalled } = await import(${JSON.stringify(dist)})
    const ev = (verb, f = {}) => ({ v: '1', seq: 0, run_id: 'r', time: 't', verb, ...f })
    const m = markStalled(reduce([ev('run.start', { seq: 1 }), ev('part.start', { seq: 2, part_id: 'p', kind: 'text' }), ev('part.delta', { seq: 3, part_id: 'p', text: 'hi' })]))
    const r = createReducer(m); r.push(ev('run.finish', { seq: 4 }))
    console.log(JSON.stringify([m.status, r.snapshot().status, r.snapshot().parts[0].text]))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '["stalled","done","hi"]')
})
