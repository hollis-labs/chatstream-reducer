// Names for the generated wire types, and the shape a run's events reduce to.
// The wire vocabulary is generated from manifest/; everything here is hand-written.
import type {
  ChatstreamEventApprovalMode,
  ChatstreamEventData,
  ChatstreamEventFinishReason,
  ChatstreamEventPartKind,
  ChatstreamEventUsage,
  ChatstreamEventVerb,
  ChatstreamEventRaw,
} from './generated/chatstream-types.generated.js'

/** One item of a chat stream (go-chatstream's Event). Generated. */
export type ChatstreamEvent = ChatstreamEventData
export type Usage = ChatstreamEventUsage
export type Verb = ChatstreamEventVerb
export type PartKind = ChatstreamEventPartKind
export type FinishReason = ChatstreamEventFinishReason
export type ApprovalMode = ChatstreamEventApprovalMode
export type Raw = ChatstreamEventRaw

/**
 * Where the message stands. `idle`: no event yet. `streaming`: events are arriving.
 * `stalled`: set by `markStalled` (the reducer has no clock, so a transport decides),
 * and cleared by the next event. `error`: the run ended with run.error. `done`: the run
 * ended with run.finish, or with run.abort (see `Message.aborted`).
 */
export type MessageStatus = 'idle' | 'streaming' | 'stalled' | 'error' | 'done'

/** One piece of a message, built from a part.start, its deltas and its part.end. */
export interface Part {
  readonly id: string
  readonly messageId?: string
  /** A PartKind, or a kind a newer producer added. */
  readonly kind: string
  readonly meta?: Readonly<Record<string, unknown>>
  /** The accumulated text of a text, reasoning or refusal part. */
  readonly text?: string
  /** The accumulated JSON fragments of a tool_call part. */
  readonly args?: string
  /** part.end's final value: a tool call's parsed arguments, a reasoning part's signature. */
  readonly final?: unknown
  /** True until the part.end arrives. */
  readonly open: boolean
  /** tool_call: the tool's name (`meta.name`). */
  readonly name?: string
  /** tool_result: the part id of the tool_call it answers (`meta.call_id`). */
  readonly callId?: string
  /** tool_result: whether the tool failed or was denied (`meta.is_error`, not `meta.error`). */
  readonly isError?: boolean
}

export interface Step {
  readonly id: string
  readonly name?: string
  readonly open: boolean
}

export interface Approval {
  readonly id: string
  readonly callId?: string
  readonly reason?: string
  readonly descriptor?: unknown
  readonly mode?: string
  readonly expiresAt?: string
}

export interface Activity {
  readonly kind: string
  readonly value?: unknown
  readonly patch?: unknown
}

export interface Gap {
  readonly from: number
  readonly to: number
  readonly reason: string
}

export interface RunError {
  readonly code: string
  readonly retryable: boolean
  readonly message: string
}

/**
 * An event the reducer did not apply because it does not fit the stream (a delta for
 * a part that is not open, a second run.start, anything after the terminal event, an
 * event of another run). The reducer never throws; it records this instead. The list
 * holds the first 100.
 */
export interface Anomaly {
  readonly seq: number
  readonly verb: string
  readonly reason: string
}

/**
 * What a run's events reduce to: the normalized assistant message plus the run's
 * status. It is plain JSON, so it can be stored and resumed with `reduce`.
 */
export interface Message {
  /** The first message's id, or the run's id until a message starts. */
  readonly id: string
  readonly runId: string
  readonly role?: string
  readonly provider?: string
  readonly model?: string

  readonly status: MessageStatus
  readonly finishReason?: string
  readonly rawReason?: string
  /** True when the run ended with run.abort; `status` is `done`. */
  readonly aborted?: boolean
  readonly abortReason?: string
  readonly error?: RunError
  readonly usage?: Usage

  readonly parts: readonly Part[]
  readonly steps: readonly Step[]
  readonly approvals: readonly Approval[]
  readonly activities: readonly Activity[]
  readonly raws: readonly Raw[]
  readonly gaps: readonly Gap[]
  readonly anomalies: readonly Anomaly[]

  /** True once a gap was seen: what precedes it may be missing events, so content may be missing. */
  readonly incomplete: boolean
  /** The highest seq applied. Events at or below it are skipped, so replaying an overlap is safe. */
  readonly lastSeq: number

  // The reducer's own state, kept in the value so a stored snapshot can be resumed.
  readonly started: boolean
  readonly hasMessage: boolean
  readonly messageOpen: boolean
  readonly currentMessage: string
}

export type ToolStatus = 'running' | 'done' | 'error'

/** A tool call joined with its result, from `toolCalls`. */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly status: ToolStatus
  /** The call's arguments: `final` if the part ended with one, else the fragments when they parse. */
  readonly arguments: unknown
  readonly callPart: Part
  readonly resultPart?: Part
}
