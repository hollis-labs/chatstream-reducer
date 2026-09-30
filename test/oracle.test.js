// The reducer oracle (go-chatstream's conformance.CheckReplayEquivalence, in TypeScript):
// for every cursor k, reducing events[:k] then applying events[k:] to that snapshot equals
// reducing everything, and equals pushing one event at a time, and equals doing so through
// a snapshot that went through JSON in between. Run over every golden event list the Go
// decoders produce, with and without the hub's seq.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduce, createReducer, messageText, usageTotal } from '../dist/index.js'
import { goldens } from './fixtures/util.js'

const all = goldens()

test('there are golden fixtures to run the oracle over', () => {
  assert.ok(all.length >= 50, `only ${all.length}`)
})

for (const variant of ['sequenced', 'unsequenced']) {
  test(`oracle (${variant}): full replay == incremental push == resume from every cursor == resume from a JSON snapshot, for every golden`, () => {
    for (const g of all) {
      const events = variant === 'sequenced' ? g.sequenced : g.events
      const full = reduce(events)
      const pushed = createReducer()
      for (const e of events) pushed.push(e)
      assert.deepEqual(pushed.snapshot(), full, `${g.name}: incremental push`)
      for (let k = 0; k <= events.length; k++) {
        const head = reduce(events.slice(0, k))
        assert.deepEqual(reduce(events.slice(k), head), full, `${g.name}: resume from cursor ${k}`)
        const stored = JSON.parse(JSON.stringify(head))
        assert.deepEqual(reduce(events.slice(k), stored), full, `${g.name}: resume from a JSON snapshot at ${k}`)
        assert.deepEqual(createReducer(stored).snapshot(), head, `${g.name}: a stored snapshot adopts to itself at ${k}`)
      }
    }
  })
}

test('every golden reduces with no anomalies: they are valid runs, so nothing is rejected', () => {
  for (const g of all) {
    const m = reduce(g.sequenced)
    assert.deepEqual(m.anomalies, [], g.name)
    assert.ok(m.status === 'done' || m.status === 'error', `${g.name}: ${m.status}`)
    assert.equal(m.incomplete, false, g.name)
    assert.equal(m.lastSeq, g.events.length, g.name)
    assert.ok(m.parts.every((p) => !p.open), `${g.name}: a part was left open`)
  }
})

test('an overlapping replay changes nothing: events at or below lastSeq are skipped', () => {
  for (const g of all) {
    const full = reduce(g.sequenced)
    for (const back of [1, 2, 5]) {
      const cut = Math.max(0, g.sequenced.length - back)
      assert.deepEqual(reduce(g.sequenced.slice(Math.max(0, cut - 3)), reduce(g.sequenced.slice(0, cut))), full, `${g.name} back ${back}`)
    }
    assert.deepEqual(reduce([...g.sequenced, ...g.sequenced]), full, `${g.name}: the whole run delivered twice`)
  }
})

test('golden spot checks: the anthropic tool_use run', () => {
  const g = all.find((x) => x.name === 'anthropic--tool_use')
  const m = reduce(g.sequenced)
  assert.equal(m.status, 'done')
  assert.equal(m.finishReason, 'tool_calls')
  assert.equal(messageText(m), 'Okay, let me check the weather.')
  const call = m.parts.find((p) => p.kind === 'tool_call')
  assert.equal(call.name, 'get_weather')
  assert.deepEqual(call.final, { location: 'San Francisco, CA' })
  assert.equal(usageTotal(m.usage), 472 + 1200 + 89, 'usage is the final report, components summed, cache read counted once')
})
