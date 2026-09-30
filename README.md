# @hollis-labs/chatstream-reducer

A pure reducer from chat-stream events to one normalized assistant message. Give it the
events of [go-chatstream](https://github.com/hollis-labs/go-chatstream) (from
[`@hollis-labs/chatstream-client`](https://github.com/hollis-labs/chatstream-client), a saved
log, or a test) and get back the message: its parts, tool calls joined with their results,
usage, steps, approvals, gaps and status. No I/O, no timers, no framework, no dependencies.

`reduce(events, prior)` is `go-chatstream`'s `Reduce` in TypeScript, with one deliberate
difference: it never throws (see below).

## Status

**Pre-release.** This project is unreleased, not deployed, and has no outside consumers. It's being built in the open: the code, the docs, and this README describe what exists today, not a pitch for what's planned. Interfaces and behavior change without notice, and there are no compatibility guarantees yet.

See [CHANGELOG.md](./CHANGELOG.md) for what has changed.

## Install

```sh
npm install @hollis-labs/chatstream-reducer
```

Not on npm yet, so that line does not work today.

## Use

```js
import { reduce, createReducer, toolCalls, messageText, markStalled } from '@hollis-labs/chatstream-reducer'

const ev = (seq, verb, more = {}) => ({ v: '1', seq, run_id: 'run-1', time: '2026-01-01T00:00:00Z', verb, ...more })
const events = [
  ev(1, 'run.start', { provider: 'anthropic', model: 'claude' }),
  ev(2, 'message.start', { message_id: 'msg-1', role: 'assistant' }),
  ev(3, 'part.start', { part_id: 't', kind: 'text' }),
  ev(4, 'part.delta', { part_id: 't', text: 'Let me delete that.' }),
  ev(5, 'part.end', { part_id: 't' }),
  ev(6, 'part.start', { part_id: 'c', kind: 'tool_call', meta: { name: 'delete_file' } }),
  ev(7, 'part.end', { part_id: 'c', final: { path: '/etc/passwd' } }),
  ev(8, 'part.start', { part_id: 'r', kind: 'tool_result', meta: { call_id: 'c', is_error: true } }), // denied
  ev(9, 'part.end', { part_id: 'r', final: 'permission denied' }),
  ev(10, 'message.end', { message_id: 'msg-1' }),
  ev(11, 'run.finish', { reason: 'tool_calls', usage: { scope: 'final', uncached_input: 12, output: 30 } }),
]

// All at once ...
const message = reduce(events)
console.log(message.status, JSON.stringify(messageText(message)))       // done "Let me delete that."
console.log(toolCalls(message).map((c) => `${c.name}: ${c.status}`))    // [ 'delete_file: error' ]

// ... one at a time, as they arrive ...
const reducer = createReducer()
for (const e of events) reducer.push(e)

// ... or resume from a stored snapshot, replaying an overlap harmlessly.
const stored = JSON.parse(JSON.stringify(reduce(events.slice(0, 5))))
console.log(reduce(events.slice(3), stored).status)                     // done: events at or below stored.lastSeq were skipped

// A transport that saw no bytes for too long marks the message; the next event clears it.
console.log(markStalled(reduce(events.slice(0, 4))).status)             // stalled
```

## What it does

- **`reduce(events, prior?)`** folds events into a `Message`. It is pure: `prior` is never modified, the same events always give the same result, and the events are never modified. Applying `events[k:]` to the result of `events[:k]` equals applying all of them, also when the snapshot went through JSON in between. An event whose `seq` is at or below the message's `lastSeq` is skipped, so overlapping replays and duplicated events change nothing. An event with `seq` 0 is always applied.
- **`createReducer(prior?)`** holds the message between events: `push(ev)` returns the new message, `snapshot()` the current one.
- **It never throws.** An event that does not fit the stream (a delta for a part that is not open, a second `run.start`, anything after the terminal event, an event of another run, a text delta on a tool call) is not applied and is recorded in `message.anomalies` (the first 100). After a gap (`message.incomplete`), the deltas and ends whose opening fell in the gap are skipped without an anomaly. Verbs it does not know are ignored, since the schema is additive. go-chatstream's `Reduce` returns an error for the same events instead.
- **`Message.status`** is `idle` (no event yet), `streaming`, `stalled`, `error` (`run.error`) or `done` (`run.finish`, or `run.abort` with `aborted: true`). This is the union kit-chat's `ChatStreamStatus` reconciles into. `markStalled(message)` sets `stalled` from `streaming`; the reducer has no clock, so a transport decides when. The next event returns it to `streaming`.
- **Tool calls read `is_error`.** `toolCalls(message)` joins each `tool_call` part with the `tool_result` whose `meta.call_id` names it: `running` with no result, `error` when `meta.is_error` is `true`, else `done`. Flux's reducer read `data.error`, so a denied tool showed as done.
- **Usage is disjoint components.** `cumulative` and `final` reports replace, `delta` reports add, and `usageTotal(usage)` is the sum of the five components; a `total` on the wire is dropped, never trusted.
- Returned messages are frozen and share unchanged structure with the message they came from. A message holds no reference to the events it was built from.

The wire types (`ChatstreamEvent`, `Usage`, `Verb`, `PartKind`, `FinishReason`) are generated, not
hand-written; see Development.

## Compatibility

ESM only, no runtime dependencies, and no clock, timer, randomness, network or environment access (a test
loads it in a process where each of those throws when touched, and it still reduces). Node 24 in CI (26 locally); any current browser. The wire
vocabulary is go-chatstream v0.1.0's `Event`, checked against it by the codegen drift tests described
below; a newer go-chatstream is untested. Its `Message` is not go-chatstream's `Message`: it is
camelCased, has `status` as above, always has its arrays, and adds `anomalies`, the derived `Part` fields
(`name`, `callId`, `isError`) that `toolCalls` reads, and `hasMessage`.

## What was read, and what was run

- **Read and run:** go-chatstream v0.1.0's `Reduce` (`reduce.go`). A one-off script, not committed, ran Go's
  `Reduce` and this package's `reduce` over the same 59 golden event lists (the fixtures under
  `test/fixtures/golden/`) and compared status, finish reason, error code, usage components, every
  part (id, kind, text, arguments, final, open), steps, approvals, raws and message id: no differences.
  That is agreement on those fixtures and those fields, not a proof of equivalence, and it is not checked
  by the test suite.
- **Read, not run:** Flux's chat reducer inside `useChat` (`apps/flux/src/hooks/useChat.ts`, where the
  tool result's status reads `data.error`), kit-chat's `ChatStreamStatus`, and the Nanite spike's mapper.
  None was run, and **no behavioural equivalence with any of them is claimed**.
- **Run, by this repo's tests:** the replay-equivalence oracle over the golden lists (full replay, incremental push, resume from every
  cursor, resume from a JSON snapshot), lifecycle and anomaly behaviour, purity (deep-frozen inputs, poisoned
  globals), and seeded property tests over arbitrary and mutated event sequences (never throws, never mutates,
  resume equals full replay, a duplicated event id is idempotent).
- **Not run anywhere:** a UI. kit-chat and Flux have not been moved onto it.

## Known limitations

- The golden fixtures are copies of go-chatstream v0.1.0's adapter goldens. They are not re-synced automatically; nothing
  fails if go-chatstream changes them.
- Idempotent replay is by `seq`. A stream whose events carry no `seq` (0) is applied event by event, so replaying it twice
  doubles it.
- Anomalies are capped at 100, and an event that is rejected still advances `lastSeq`.
- A message is JSON, but `final`, `meta`, `descriptor`, `value` and `patch` are copied with a depth limit of 100 and lose
  non-JSON values.
- `abort` is `done` plus `aborted`, because the status union has no `aborted` member.
- The manifest, generator and generated file are duplicated in `@hollis-labs/chatstream-client` (see Development).

## Out of scope

- Transport: connecting, reconnecting, dedupe of a network replay, stall detection (that is `@hollis-labs/chatstream-client`).
- Rendering, markdown, or any React.
- Cost and usage-ledger display.
- Persistence.
- Publishing.

## Development

```sh
npm ci
npm run typecheck   # src plus the typecheck-only fixture in test/types
npm test            # builds, then node --test against dist/ (no Go needed)
```

The wire types in `src/generated/chatstream-types.generated.ts` are generated from the manifest in
`manifest/` (go-envelopes' manifest layout) by go-envelopes' own generator, pinned at v0.4.0; `tools/gen`
makes the calls `cmd/envelopes-export` makes, with the manifest filesystem swapped, because that command has no
flag for another manifest. Never edit the generated file.

```sh
npm run gen           # regenerate after editing the manifest (needs Go)
npm run gen:check     # fails if the checked-in file differs from a fresh regeneration
npm run gen:go-test   # fails if the manifest drifts from go-chatstream's Go source
```

CI runs all three in a `codegen` job. Release steps: [docs/RELEASING.md](./docs/RELEASING.md).

## License

MIT. See [LICENSE](./LICENSE).
