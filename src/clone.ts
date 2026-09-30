// Deep copies of JSON-shaped values, frozen, so a message never shares mutable
// structure with an event or with a snapshot it was resumed from.

const MAX_DEPTH = 100

/** A frozen deep copy of a JSON value. Anything deeper than MAX_DEPTH becomes null; non-JSON values become undefined. */
export function freezeClone(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (depth >= MAX_DEPTH) return null
  if (Array.isArray(v)) return Object.freeze(v.map((e) => freezeClone(e, depth + 1) ?? null))
  if (typeof v === 'object') {
    const entries: [string, unknown][] = []
    for (const k of Object.keys(v)) {
      const c = freezeClone((v as Record<string, unknown>)[k], depth + 1)
      if (c !== undefined) entries.push([k, c])
    }
    // fromEntries defines properties, so a "__proto__" key stays data instead of changing a prototype.
    return Object.freeze(Object.fromEntries(entries))
  }
  return undefined
}
