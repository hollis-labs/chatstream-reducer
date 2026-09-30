import type { Message, Part, ToolCall, ToolStatus, Usage } from './types.js'

/** The concatenated text of the message's text parts. */
export function messageText(m: Pick<Message, 'parts'>): string {
  let out = ''
  for (const p of m.parts) if (p.kind === 'text' && p.text) out += p.text
  return out
}

/** A tool_call part's arguments: `final` when the part ended with one, else the fragments when they form valid JSON, else undefined. */
export function toolArguments(p: Pick<Part, 'final' | 'args'>): unknown {
  if (p.final !== undefined) return p.final
  if (p.args) {
    try {
      return JSON.parse(p.args)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Every tool call joined with its result. A call is `error` when its result's
 * `meta.is_error` is true (a failed or denied tool), `done` when it has a result,
 * and `running` when it has none yet. The status reads `is_error`, the key the
 * wire uses; Flux's reducer read `error` and showed denied tools as done.
 */
export function toolCalls(m: Pick<Message, 'parts'>): ToolCall[] {
  const results = new Map<string, Part>()
  for (const p of m.parts) if (p.kind === 'tool_result' && p.callId) results.set(p.callId, p)
  const out: ToolCall[] = []
  for (const p of m.parts) {
    if (p.kind !== 'tool_call') continue
    const resultPart = results.get(p.id)
    const status: ToolStatus = resultPart ? (resultPart.isError === true ? 'error' : 'done') : 'running'
    const call: ToolCall = {
      id: p.id,
      name: p.name ?? '',
      status,
      arguments: toolArguments(p),
      callPart: p,
      ...(resultPart ? { resultPart } : {}),
    }
    out.push(call)
  }
  return out
}

/** The sum of a usage report's five disjoint components. `total` on the wire is never trusted. */
export function usageTotal(u: Pick<Usage, 'uncached_input' | 'cache_read' | 'cache_write' | 'output' | 'reasoning'>): number {
  return u.uncached_input + (u.cache_read ?? 0) + (u.cache_write ?? 0) + u.output + (u.reasoning ?? 0)
}
