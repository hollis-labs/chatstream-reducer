# chatstream-reducer

A pure reducer from go-chatstream's events to one normalized assistant message.
TypeScript, ESM, no runtime dependencies, no framework. Pre-release; see the README's
Status.

## Start Here

- `src/reduce.ts` owns `reduce`, `createReducer` and `markStalled`: the per-verb rules and the anomaly policy.
- `src/events.ts` owns the readers (`messageText`, `toolCalls`, `toolArguments`, `usageTotal`). `src/types.ts` owns `Message` and its parts, and names the generated types. `src/clone.ts` owns the frozen deep copy.
- `src/generated/chatstream-types.generated.ts` is GENERATED. `manifest/` (go-envelopes' manifest layout) is its source; `tools/gen` runs go-envelopes' generator over it.
- `test/fixtures/golden/` are go-chatstream v0.1.0's adapter golden event lists, copied unmodified: real decoder output, every one a valid run.
- `@hollis-labs/chatstream-client` is the sibling package. It carries a copy of `manifest/`, `tools/gen` and the generated file; the two must stay byte-identical (`cmp`).

## Commands

```sh
npm ci
npm run typecheck
npm test              # builds, then node --test against dist/; no Go needed
npm run gen           # regenerate src/generated/ from manifest/ (needs Go)
npm run gen:check     # fails if the checked-in generated file is out of date
npm run gen:go-test   # fails if the manifest drifts from go-chatstream's Go source
```

Tests import `dist/`, so `npm test` builds first. Do not run `npm publish`, tag or
push from here; publishing is the scope owner's manual step, in `docs/RELEASING.md`.

## Boundaries

Each invariant below is guarded by a named test. Break one on purpose and that test
should fail; if it does not, the guard is not doing its job.

- **A tool result's failure is `meta.is_error`, never `meta.error`.** A denied tool is an error, not done. `defects.test.js` "a denied tool (tool_result with meta.is_error true and no meta.error) is an error, not done", "only the boolean true is an error ...", "a result links to its call by call_id ...". Flux's reducer read `data.error` and showed denied tools as done.
- **Pure: it never mutates `prior` or the events, whatever they are.** `purity.test.js` "reduce never mutates its input events or its prior (both deep-frozen ...)", "the input state object is not modified ...", "a mutable prior ... is not written to either"; `property.test.js` "the reducer never mutates its inputs, whatever they are".
- **No hidden state: no clock, timers, randomness, network or environment.** `purity.test.js` "with the clock, timers, randomness, network, process and console poisoned, it still reduces", and `isolation.test.js` (the entry loads with nothing but relative imports resolvable). Deterministic: "deterministic: the same events give deeply equal messages".
- **A message shares no mutable structure with the events it came from or the snapshot it resumed from, and is frozen.** `purity.test.js` "a message does not alias the events ...", "returned messages are frozen ...", "untouched parts are shared ...".
- **Replay from any cursor equals full replay, incrementally, and through a JSON snapshot.** `oracle.test.js` (the oracle over every golden, sequenced and not) and `property.test.js` "deterministic, and resume-from-cursor (also through JSON) equals full replay, on arbitrary sequences".
- **Events at or below `lastSeq` are skipped: a duplicated event id is idempotent.** `oracle.test.js` "an overlapping replay changes nothing ...", `property.test.js` "replaying a duplicated event id is idempotent". Unsequenced events (seq 0) are applied every time, by design.
- **It never throws, on any input.** `property.test.js` "reduce never throws on arbitrary event sequences, including non-events and junk field types", "lifecycle mutations of real runs ... never throw", `semantics.test.js` "a stored snapshot that is malformed is adopted without throwing". An event that does not fit is recorded in `anomalies` and not applied: `semantics.test.js` "without a gap, the same orphans are anomalies ...", "an event after the terminal event is an anomaly and changes nothing".
- **After a gap, what its lost opening explains is skipped without an anomaly.** `semantics.test.js` "a gap makes the message incomplete and is recorded ...".
- **Only `run.error` is an error and only `run.finish`, `run.error` and `run.abort` end the run; a non-terminal error in `raw` or `activity` does not.** `defects.test.js` "a non-terminal error does not end the run ...", "only run.error is an error, and it is terminal ...".
- **`Message.status` is the closed union `idle | streaming | stalled | error | done`; `stalled` is set only by `markStalled` and cleared by the next event.** `semantics.test.js` "markStalled: ...", `test/types/api.ts` (typecheck).
- **Usage is disjoint components: `total` is their sum, a wire `total` is never trusted, `delta` adds and `cumulative`/`final` replace.** `semantics.test.js` "usage: cumulative and final replace; delta adds ...".
- **A `__proto__` key in an event does not pollute anything.** `property.test.js` "a \"__proto__\" key or part id in an event does not pollute anything".
- **The reducer has no dependency on the client package (or any package), and no React.** `isolation.test.js`.
- **The wire types are generated, never hand-edited.** `npm run gen:check` (CI job `codegen`); `generated.test.js` checks the header. Edit `manifest/`, run `npm run gen`.
- **The manifest matches go-chatstream's Go source.** `tools/gen/drift_test.go` (`npm run gen:go-test`): `TestEnumsMatchGoConstants`, `TestCapabilitiesMatchGoStruct`, `TestEventUsageRawMatchGoStructs`, `TestRealGoldenEventsValidateAgainstTheManifest`.
- **The public type surface, including read-only messages.** `test/types/api.ts`, checked by `npm run typecheck`.
- **The tarball ships `dist`, README, CHANGELOG, LICENSE and nothing else; no source maps; no fixtures, `tools/`, `manifest/` or Go.** Not guarded by a test. It is `files` in `package.json`, `sourceMap`/`declarationMap` false in `tsconfig.build.json`, `rm -rf dist` in `build`, and the `npm pack --dry-run` step in CI and the release runbook.
- **No `file:`, `link:` or `workspace:` entries in `package.json` or the lockfile; no tarballs or local paths committed.** Review-only.
- **Do not add transport (connect, reconnect, timers) here.** That is `@hollis-labs/chatstream-client`.

## Conventions

- Source imports carry `.js` extensions; `tsconfig.build.json` emits with no maps.
- Tests are plain `.js` against `dist/`. Property tests use a seeded generator so a failure reproduces.
- Do not write a new check that asserts the content of a mutable file or that two sources agree; raise it instead. The golden fixtures are copies and are not re-synced by any test. (The drift tests in `tools/gen` compare the manifest with go-chatstream's source by design of the codegen mechanism; do not add more of that kind.)
