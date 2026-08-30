# Task 34: replaceUndefined fast path in the codec encode pipeline

**Severity:** medium

## Finding: Full replaceUndefined tree-walk on every encode() call — redundant allocation on every checkpoint and event-log write

- **Severity:** medium (performance)
- **Files (audit snapshot):** `src/core/codec/api.ts`, `src/core/codec/extension-codec.ts`

### Evidence

src/core/codec/api.ts:25 — `const preprocessed = replaceUndefined(value, new Set())` runs before every msgpackEncode call. src/core/codec/extension-codec.ts:181–192 — `replaceUndefined` creates a new `Set()` as a cycle guard and recursively clones every array, Map, Set, and plain object in the value tree, replacing nothing if no `undefined` is present. For a typical checkpoint with no `undefined` fields (undefined locals are rare; searchAttributes are user-controlled) this is a full deep copy that allocates intermediate objects and is then discarded after msgpackDecode. This runs on every `encode()` call site: checkpoint writes (checkpoint-io.ts:159), event-log entries (event-log.ts:244), visibility index entries, timer entries, state writes — essentially every storage write. A 100-field locals object gets a full pre-pass clone per checkpoint step.

### Required fix

Add a fast-path that short-circuits `replaceUndefined` when the value is a primitive or when a shallow scan finds no `undefined` values. Alternatively, track whether any undefined is present during the serialization pass itself (msgpack's encoder visits each field once) rather than doing a separate pre-pass. A dedicated `encodeCheckpoint` function that knows the Checkpoint schema has no undefined could skip the pre-pass entirely.

### Verifier note

The finding is accurate on the core issue. One minor overstatement: the `new Set()` cycle guard is not created per recursive call — it is created once at api.ts:25 and threaded through by reference, with nodes added on descent and deleted on ascent (lines 186-191). This is a DFS stack pattern, not a new Set per node. This reduces the Set-allocation cost to once per `encode()` call, not O(nodes). The rest of the analysis holds: plain objects and arrays are unconditionally deep-copied with no short-circuit for the no-undefined case. For checkpoint-heavy workloads this is real allocation pressure on every storage write path.

## Acceptance criteria (all required — completion is binary)

- [ ] encode() no longer deep-clones values containing no undefined (detection pass or copy-on-write); decoded output is byte-identical to before for representative checkpoint/event-log fixtures.
- [ ] Codec semantic-compatibility tests (undefined replacement, cycles, Maps/Sets, typed arrays) all stay green; a test pins that undefined handling is unchanged.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
