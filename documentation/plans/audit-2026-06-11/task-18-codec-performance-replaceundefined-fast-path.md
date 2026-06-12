# Task 18: Codec performance: replaceUndefined fast path

**Severity:** medium

## Full replaceUndefined tree-walk on every encode() call — redundant allocation on every checkpoint and event-log write

- **Severity:** medium (performance)
- **Files:** `src/core/codec/api.ts`, `src/core/codec/extension-codec.ts`

**Evidence:** src/core/codec/api.ts:25 — `const preprocessed = replaceUndefined(value, new Set())` runs before every msgpackEncode call. src/core/codec/extension-codec.ts:181–192 — `replaceUndefined` creates a new `Set()` as a cycle guard and recursively clones every array, Map, Set, and plain object in the value tree, replacing nothing if no `undefined` is present. For a typical checkpoint with no `undefined` fields (undefined locals are rare; searchAttributes are user-controlled) this is a full deep copy that allocates intermediate objects and is then discarded after msgpackDecode. This runs on every `encode()` call site: checkpoint writes (checkpoint-io.ts:159), event-log entries (event-log.ts:244), visibility index entries, timer entries, state writes — essentially every storage write. A 100-field locals object gets a full pre-pass clone per checkpoint step.

**Required fix:** Add a fast-path that short-circuits `replaceUndefined` when the value is a primitive or when a shallow scan finds no `undefined` values. Alternatively, track whether any undefined is present during the serialization pass itself (msgpack's encoder visits each field once) rather than doing a separate pre-pass. A dedicated `encodeCheckpoint` function that knows the Checkpoint schema has no undefined could skip the pre-pass entirely.

**Verifier note:** The finding is accurate on the core issue. One minor overstatement: the `new Set()` cycle guard is not created per recursive call — it is created once at api.ts:25 and threaded through by reference, with nodes added on descent and deleted on ascent (lines 186-191). This is a DFS stack pattern, not a new Set per node. This reduces the Set-allocation cost to once per `encode()` call, not O(nodes). The rest of the analysis holds: plain objects and arrays are unconditionally deep-copied with no short-circuit for the no-undefined case. For checkpoint-heavy workloads this is real allocation pressure on every storage write path.
