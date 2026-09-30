import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('./golden/', import.meta.url))

/**
 * The adapters' golden event lists from go-chatstream v0.1.0 (copied from its module
 * cache, unmodified): the events real decoders produce from recorded provider streams.
 * Each is a valid run. `sequenced` numbers them 1..n the way the hub does on publish.
 */
export function goldens() {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const events = JSON.parse(readFileSync(dir + f, 'utf8'))
    return { name: f.replace(/\.json$/, ''), events, sequenced: events.map((e, i) => ({ ...e, seq: i + 1 })) }
  })
}

/** An event with the envelope fields filled in. */
export function ev(verb, fields = {}) {
  return { v: '1', seq: 0, run_id: 'run-1', time: '2026-01-01T00:00:00Z', verb, ...fields }
}
export const seqd = (events) => events.map((e, i) => ({ ...e, seq: i + 1 }))

/** Recursively freezes, so that any write through a reference throws in strict mode. */
export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}
export const clone = (v) => JSON.parse(JSON.stringify(v))
export const json = (v) => JSON.parse(JSON.stringify(v))

export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
