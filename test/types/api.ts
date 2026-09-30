// Typecheck-only fixture (run by `npm run typecheck`; never executed). A
// `@ts-expect-error` that stops being an error fails the typecheck.
import { reduce, createReducer, markStalled, toolCalls, messageText, usageTotal } from '../../src/index.ts'
import type { ChatstreamEvent, Message, MessageStatus, ToolCall } from '../../src/index.ts'

declare const events: ChatstreamEvent[]
declare const prior: Message | null

export const m: Message = reduce(events, prior)
export const m2: Message = reduce(events)
export const s: MessageStatus = m.status
export const text: string = messageText(m)
export const calls: ToolCall[] = toolCalls(m)
export const total: number | undefined = m.usage ? usageTotal(m.usage) : undefined
export const stalled: Message = markStalled(m)
export const r = createReducer()
export const pushed: Message = r.push(events[0]!)
export const snap: Message = r.snapshot()

// the status is the closed union kit-chat's ChatStreamStatus reconciles into
// @ts-expect-error not a status
export const bad: MessageStatus = 'streamin'
// @ts-expect-error a message is read-only: reduce returns a new one
m.status = 'done'
// @ts-expect-error parts are read-only too
m.parts.push({ id: 'x', kind: 'text', open: true })
// @ts-expect-error events are the generated wire type: an unknown field is an error
export const badEvent: ChatstreamEvent = { v: '1', seq: 1, run_id: 'r', time: 't', verb: 'run.start', extra: 1 }
