# Changelog

## 0.1.0 — 2026-09-30

Initial extraction; not published, not tagged.

- `reduce(events, prior?)`, `createReducer(prior?)`, `markStalled(message)`, and the readers `messageText`, `toolCalls`, `toolArguments`, `usageTotal`. Pure: no I/O, no timers, no globals; never mutates its inputs; returns frozen messages that share unchanged structure.
- Replay from any cursor equals full replay (also through a JSON snapshot); events at or below `lastSeq` are skipped, so an overlapping or duplicated replay changes nothing.
- Never throws: an event that does not fit the stream is recorded in `anomalies` instead of raising, which is where it differs from go-chatstream's `Reduce`.
- `Message.status` is `idle`, `streaming`, `stalled`, `error` or `done`, reconciling kit-chat's `ChatStreamStatus`; `run.abort` is `done` with `aborted: true`.
- Tool results read `meta.is_error`. Flux's reducer read `data.error`, so a denied tool showed as done; that was not carried over.
- Wire types (`Event`, `Usage`, `Verb`, `PartKind`, `FinishReason`) are generated from `manifest/` by go-envelopes v0.4.0's generator and pinned to go-chatstream v0.1.0 by Go tests (`npm run gen:check`, `npm run gen:go-test`).
- Tested over the 59 golden event lists go-chatstream v0.1.0's decoders produce.
- Flux's reducer, kit-chat's status type and the Nanite spike were read for the pattern; none was run, and no equivalence is claimed. go-chatstream's `Reduce` was run against this one over the golden lists once, by hand, and agreed on the fields compared.
- Source maps and declaration maps are not emitted: they would point at `../src`, which the tarball does not ship.
