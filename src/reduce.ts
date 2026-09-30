import { freezeClone } from './clone.js'
import type {
  Activity, Anomaly, Approval, ChatstreamEvent, Gap, Message, Part, Raw, RunError, Step, Usage,
} from './types.js'

// The reducer is pure. It has no I/O, no timers and no module state; every function
// here returns new values and never writes to an argument. Messages it returns are
// frozen, and structure the new value does not change is shared with the old one.

const MAX_ANOMALIES = 100
const OWN = new WeakSet<object>() // messages this module built, and therefore already well-formed and frozen

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0)
const freeze = <T extends object>(o: T): T => Object.freeze(o)

/** Copies `o` without keys whose value is undefined, so a stored snapshot round-trips through JSON unchanged. */
function build<T extends object>(o: Record<string, unknown>): T {
  const out: Rec = {}
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k]
  return freeze(out) as T
}

function empty(): Message {
  const m = freeze({
    id: '', runId: '', status: 'idle', parts: freeze([]), steps: freeze([]), approvals: freeze([]),
    activities: freeze([]), raws: freeze([]), gaps: freeze([]), anomalies: freeze([]),
    incomplete: false, lastSeq: 0, started: false, hasMessage: false, messageOpen: false, currentMessage: '',
  }) as Message
  OWN.add(m)
  return m
}

/** Turns a stored snapshot (possibly from JSON, possibly malformed) into a well-formed frozen message. */
function adopt(prior: Message | null | undefined): Message {
  if (prior === null || prior === undefined) return empty()
  if (OWN.has(prior)) return prior
  const p = (isRec(prior) ? prior : {}) as Rec
  const arr = (k: string): unknown[] => (Array.isArray(p[k]) ? (p[k] as unknown[]) : [])
  const status = ['idle', 'streaming', 'stalled', 'error', 'done'].includes(p['status'] as string) ? (p['status'] as Message['status']) : 'idle'
  const m = build<Message>({
    id: str(p['id']),
    runId: str(p['runId']),
    role: str(p['role']) || undefined,
    provider: str(p['provider']) || undefined,
    model: str(p['model']) || undefined,
    status,
    finishReason: str(p['finishReason']) || undefined,
    rawReason: str(p['rawReason']) || undefined,
    aborted: p['aborted'] === true ? true : undefined,
    abortReason: p['abortReason'] === undefined ? undefined : str(p['abortReason']),
    error: isRec(p['error']) ? freezeClone(p['error']) : undefined,
    usage: isRec(p['usage']) ? normalizeUsage(p['usage']) : undefined,
    parts: freezeClone(arr('parts').filter(isRec)),
    steps: freezeClone(arr('steps').filter(isRec)),
    approvals: freezeClone(arr('approvals').filter(isRec)),
    activities: freezeClone(arr('activities').filter(isRec)),
    raws: freezeClone(arr('raws').filter(isRec)),
    gaps: freezeClone(arr('gaps').filter(isRec)),
    anomalies: freezeClone(arr('anomalies').filter(isRec)),
    incomplete: p['incomplete'] === true,
    lastSeq: count(p['lastSeq']),
    started: p['started'] === true,
    hasMessage: p['hasMessage'] === true,
    messageOpen: p['messageOpen'] === true,
    currentMessage: str(p['currentMessage']),
  })
  OWN.add(m)
  return m
}

function normalizeUsage(u: Rec): Usage {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  let extra: Record<string, number> | undefined
  if (isRec(u['extra'])) {
    const entries = Object.keys(u['extra']).map((k): [string, number] => [k, num((u['extra'] as Rec)[k])])
    if (entries.length > 0) extra = freeze(Object.fromEntries(entries))
  }
  const scope = ['cumulative', 'final', 'delta'].includes(u['scope'] as string) ? (u['scope'] as Usage['scope']) : undefined
  // `total` is derived on the Go side and ignored here; usageTotal() recomputes it from the components.
  return build<Usage>({
    scope,
    uncached_input: num(u['uncached_input']),
    cache_read: u['cache_read'] === undefined ? undefined : num(u['cache_read']),
    cache_write: u['cache_write'] === undefined ? undefined : num(u['cache_write']),
    output: num(u['output']),
    reasoning: u['reasoning'] === undefined ? undefined : num(u['reasoning']),
    extra,
  })
}

function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0))
  let extra: Record<string, number> | undefined
  if (a.extra || b.extra) {
    const keys = [...new Set([...Object.keys(a.extra ?? {}), ...Object.keys(b.extra ?? {})])]
    extra = freeze(Object.fromEntries(keys.map((k): [string, number] => [k, (a.extra?.[k] ?? 0) + (b.extra?.[k] ?? 0)])))
  }
  return build<Usage>({
    scope: 'cumulative',
    uncached_input: a.uncached_input + b.uncached_input,
    cache_read: sum(a.cache_read, b.cache_read),
    cache_write: sum(a.cache_write, b.cache_write),
    output: a.output + b.output,
    reasoning: sum(a.reasoning, b.reasoning),
    extra,
  })
}

function applyUsage(m: Message, u: Usage, scope: string | undefined): Message['usage'] {
  if (scope === 'delta') {
    if (!m.usage) return build<Usage>({ ...u, scope: 'cumulative' })
    return addUsage(m.usage, u)
  }
  return u // cumulative and final replace what was there
}

const rejects = (m: Message, ev: Rec, seq: number, reason: string): Message => {
  const anomalies: Anomaly[] = m.anomalies.length >= MAX_ANOMALIES
    ? (m.anomalies as Anomaly[])
    : [...m.anomalies, freeze({ seq, verb: str(ev['verb']), reason })]
  return freeze({ ...m, anomalies: freeze(anomalies) }) as Message
}

const lastOpen = (parts: readonly Part[], id: string): number => {
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.id === id && parts[i]!.open) return i
  return -1
}
const withPart = (m: Message, i: number, part: Part): Message => {
  const parts = m.parts.slice()
  parts[i] = part
  return freeze({ ...m, parts: freeze(parts) }) as Message
}

/** Applies one event. Never throws, never mutates `m` or `ev`. */
function step(m: Message, evIn: unknown): Message {
  if (!isRec(evIn)) return rejects(m, {}, 0, 'not an event')
  const ev = evIn
  const rawSeq = ev['seq']
  const seq = count(rawSeq)
  if (seq !== 0 && seq <= m.lastSeq) return m // already applied: an overlapping replay is harmless
  let next = apply(m, ev, seq)
  if (seq > next.lastSeq) next = freeze({ ...next, lastSeq: seq }) as Message
  return next
}

function apply(m0: Message, ev: Rec, seq: number): Message {
  if (m0.status === 'done' || m0.status === 'error') return rejects(m0, ev, seq, 'event after the terminal event')
  let m = m0
  if (m.status === 'idle' || m.status === 'stalled') m = freeze({ ...m, status: 'streaming' }) as Message

  const runId = str(ev['run_id'])
  if (runId !== '') {
    if (m.runId === '') m = freeze({ ...m, runId, ...(m.hasMessage ? {} : { id: runId }) }) as Message
    else if (m.runId !== runId) return rejects(m, ev, seq, `run id ${JSON.stringify(runId)}, expected ${JSON.stringify(m.runId)}`)
  }

  switch (str(ev['verb'])) {
    case 'run.start':
      if (m.started) return rejects(m, ev, seq, 'run.start twice')
      return build<Message>({ ...m, provider: str(ev['provider']) || undefined, model: str(ev['model']) || undefined, started: true })

    case 'run.finish': {
      const u = isRec(ev['usage']) ? normalizeUsage(ev['usage']) : undefined
      return build<Message>({
        ...m, status: 'done', finishReason: str(ev['reason']) || undefined, rawReason: str(ev['raw_reason']) || undefined,
        usage: u ? applyUsage(m, u, 'final') : m.usage,
      })
    }
    case 'run.error': {
      const error: RunError = freeze({ code: str(ev['code']), retryable: ev['retryable'] === true, message: str(ev['message']) })
      return build<Message>({ ...m, status: 'error', error })
    }
    case 'run.abort':
      return build<Message>({ ...m, status: 'done', aborted: true, abortReason: str(ev['reason']) })

    case 'step.start': {
      const s = build<Step>({ id: str(ev['step_id']), name: str(ev['name']) || undefined, open: true })
      return freeze({ ...m, steps: freeze([...m.steps, s]) }) as Message
    }
    case 'step.finish': {
      const id = str(ev['step_id'])
      for (let i = m.steps.length - 1; i >= 0; i--) {
        const s = m.steps[i]!
        if (s.id === id && s.open) {
          const steps = m.steps.slice()
          steps[i] = freeze({ ...s, open: false })
          return freeze({ ...m, steps: freeze(steps) }) as Message
        }
      }
      return m.incomplete ? m : rejects(m, ev, seq, `step.finish for step ${JSON.stringify(id)} that is not open`)
    }

    case 'message.start': {
      if (m.messageOpen) return rejects(m, ev, seq, `message.start inside message ${JSON.stringify(m.currentMessage)}`)
      const id = str(ev['message_id'])
      return build<Message>({
        ...m, messageOpen: true, currentMessage: id,
        ...(m.hasMessage ? {} : { hasMessage: true, id, role: str(ev['role']) || undefined }),
      })
    }
    case 'message.end':
      if (!m.messageOpen) return m.incomplete ? m : rejects(m, ev, seq, 'message.end with no open message')
      return freeze({ ...m, messageOpen: false }) as Message

    case 'part.start': {
      const id = str(ev['part_id'])
      if (lastOpen(m.parts, id) >= 0) return rejects(m, ev, seq, `part ${JSON.stringify(id)} is already open`)
      const meta = isRec(ev['meta']) ? (freezeClone(ev['meta']) as Rec) : undefined
      const kind = str(ev['kind'])
      const part = build<Part>({
        id, messageId: m.currentMessage || undefined, kind, meta, open: true,
        name: kind === 'tool_call' ? str(meta?.['name']) || undefined : undefined,
        callId: kind === 'tool_result' ? str(meta?.['call_id']) || undefined : undefined,
        // The wire key is is_error. Reading `error` (as Flux's reducer did) shows a denied tool as done.
        isError: kind === 'tool_result' ? meta?.['is_error'] === true : undefined,
      })
      return freeze({ ...m, parts: freeze([...m.parts, part]) }) as Message
    }
    case 'part.delta': {
      const id = str(ev['part_id'])
      const i = lastOpen(m.parts, id)
      if (i < 0) return m.incomplete ? m : rejects(m, ev, seq, `part.delta for part ${JSON.stringify(id)} that is not open`)
      const p = m.parts[i]!
      const text = str(ev['text'])
      const frag = str(ev['json_fragment'])
      if (frag !== '' && text !== '') return rejects(m, ev, seq, 'part.delta carries both text and json_fragment')
      if (frag !== '') {
        if (p.kind !== 'tool_call') return rejects(m, ev, seq, `json_fragment on a ${p.kind} part`)
        return withPart(m, i, freeze({ ...p, args: (p.args ?? '') + frag }))
      }
      if (text !== '') {
        if (p.kind === 'tool_call') return rejects(m, ev, seq, 'text on a tool_call part')
        return withPart(m, i, freeze({ ...p, text: (p.text ?? '') + text }))
      }
      return m
    }
    case 'part.end': {
      const id = str(ev['part_id'])
      const i = lastOpen(m.parts, id)
      if (i < 0) return m.incomplete ? m : rejects(m, ev, seq, `part.end for part ${JSON.stringify(id)} that is not open`)
      const final = ev['final'] === undefined ? undefined : freezeClone(ev['final'])
      return withPart(m, i, build<Part>({ ...m.parts[i]!, open: false, ...(final !== undefined ? { final } : {}) }))
    }

    case 'approval.request': {
      const a = build<Approval>({
        id: str(ev['approval_id']), callId: str(ev['call_id']) || undefined, reason: str(ev['reason']) || undefined,
        descriptor: ev['descriptor'] === undefined ? undefined : freezeClone(ev['descriptor']),
        mode: str(ev['mode']) || undefined, expiresAt: str(ev['expires_at']) || undefined,
      })
      return freeze({ ...m, approvals: freeze([...m.approvals, a]) }) as Message
    }
    case 'usage': {
      if (!isRec(ev['usage'])) return rejects(m, ev, seq, 'usage event without usage')
      const u = normalizeUsage(ev['usage'])
      return build<Message>({ ...m, usage: applyUsage(m, u, u.scope) })
    }
    case 'activity': {
      const a = build<Activity>({
        kind: str(ev['kind']),
        value: ev['value'] === undefined ? undefined : freezeClone(ev['value']),
        patch: ev['patch'] === undefined ? undefined : freezeClone(ev['patch']),
      })
      return freeze({ ...m, activities: freeze([...m.activities, a]) }) as Message
    }
    case 'raw': {
      if (!isRec(ev['raw'])) return m
      const r = freezeClone(ev['raw']) as Raw
      return freeze({ ...m, raws: freeze([...m.raws, r]) }) as Message
    }
    case 'gap': {
      const g: Gap = freeze({ from: count(ev['from']), to: count(ev['to']), reason: str(ev['reason']) })
      return freeze({ ...m, gaps: freeze([...m.gaps, g]), incomplete: true }) as Message
    }
    default:
      return m // a verb this reducer does not know: the schema is additive, so it is ignored
  }
}

function finalize(m: Message): Message {
  OWN.add(m)
  return m
}

/**
 * Folds `events` into a Message. It is pure: `prior` (null to start) is not modified and the
 * same events always give the same result. Applying `events[k:]` to the result of applying
 * `events[:k]` gives the same Message as applying all of them (replay from any cursor equals
 * full replay), including when the snapshot went through JSON in between. An event whose
 * `seq` is at or below `prior.lastSeq` is skipped, so an overlapping replay, or a duplicated
 * event, changes nothing. An event with no `seq` (0) is always applied.
 *
 * It never throws. An event that does not fit the stream is not applied and is recorded in
 * `anomalies`. Once a gap was seen (`incomplete`), a delta, part.end, message.end or
 * step.finish whose opening event fell in the gap is skipped without an anomaly. Verbs it
 * does not know are ignored.
 */
export function reduce(events: readonly ChatstreamEvent[], prior?: Message | null): Message {
  let m = adopt(prior)
  for (const ev of events) m = finalize(step(m, ev))
  return m
}

/** A reducer that holds its message between events. */
export interface Reducer {
  /** Applies one event and returns the new message. */
  push(ev: ChatstreamEvent): Message
  /** The message as it stands. */
  snapshot(): Message
}

/** Starts a reducer, from `prior` (a stored snapshot) or from nothing. */
export function createReducer(prior?: Message | null): Reducer {
  let m = adopt(prior)
  return {
    push(ev) {
      m = finalize(step(m, ev))
      return m
    },
    snapshot: () => m,
  }
}

/**
 * The message with `status` `stalled`, when it is `streaming`. The reducer has no clock:
 * whoever detects the stall (a transport that saw no bytes for too long) calls this. The
 * next event applied returns the status to `streaming`. Any other status is returned as is.
 */
export function markStalled(m: Message): Message {
  const a = adopt(m)
  if (a.status !== 'streaming') return a
  return finalize(freeze({ ...a, status: 'stalled' }) as Message)
}
