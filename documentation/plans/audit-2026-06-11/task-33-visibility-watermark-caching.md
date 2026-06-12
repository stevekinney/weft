# Task 33: Cache the workflow-visibility watermark; batch stream-state reads

**Severity:** high

## Finding: engine.list() falls back to full wf: prefix scan when visibility watermark is stale — O(N) storage reads gated behind a single watermark read per query

- **Severity:** high (performance)
- **Files (audit snapshot):** `src/core/engine/list-candidate-resolution.ts`, `src/core/engine/listing.ts`, `src/core/engine/workflow-state-stream.ts`

### Evidence

src/core/engine/list-candidate-resolution.ts:132–145 — `getWorkflowVisibilityWatermark` is called on every `list()` and `aggregate()` call. When it returns `'stale'` (i.e., the backfill migration has not run) the entire `wf:` prefix is scanned (listing.ts:113: `internals.storage.scan('wf:')`). For new deployments or any deployment that has not explicitly run the backfill, ALL queries are full table scans with no index. The watermark read itself is an additional `storage.get` per query. Additionally, workflow-state-stream.ts:26–37 shows the constrained-ids path issues serial `storage.get` per candidate id rather than a batch, though listing.ts:87–88 uses `Promise.all` per chunk. The full-scan path (listing.ts:124–127) also does a separate per-workflow `storage.get(KEYS.attribute(state.id))` for failed workflows.

### Required fix

Cache the watermark in engine memory and invalidate it only on backfill completion (the backfill already writes to `wf-idx-meta:version`). Invalidation mechanism (decided): direct in-process invalidation — the code path that performs the backfill-completion write also clears the cached watermark on the same engine instance. No storage-event subscription and no polling: Weft's documented posture is one engine process per durable store, so there is no cross-process invalidation to solve. This eliminates one `storage.get` per query. (The original finding also proposed running the backfill automatically on `Engine.create()` for new databases — that is explicitly out of scope here; see the scope section below.)

### Verifier note

The finding is real and accurately evidenced. One nuance worth noting: the constrained-ids path in `listing.ts` (the non-stream `list()` function) DOES use `Promise.all` in 64-element chunks (`CONSTRAINED_ID_CHUNK_SIZE = 64`) at `listing.ts:87-88`, so the claim of serial-per-candidate reads applies specifically to `streamMatchingWorkflowStates` in `workflow-state-stream.ts:26-36`, which is used by bulk streaming operations (`streamWorkflowStateBatches`), not by `list()` itself.

The proposed fix is sound for the watermark caching: adding a `visibilityWatermark: WorkflowVisibilityWatermark | null` field to `EngineInternals` (initialized to `null`, populated on first query, invalidated when the backfill writes the version key) would eliminate the per-query storage read. For auto-setting the watermark on new databases: `Engine.create()` could check whether any `wf:` keys exist on startup; if not, it could atomically write the watermark immediately, bypassing the need for an explicit backfill run on fresh deployments. For existing databases, the external backfill script remains the correct migration path.

## Scope boundary

In scope: (1) cache the watermark in EngineInternals — populated on first query, invalidated on backfill completion writes — eliminating the per-query storage.get; (2) apply the 64-chunk batching to streamMatchingWorkflowStates. OUT of scope (explicitly deferred, do not implement here): changing the default backfill posture on Engine.create() — that changes startup/migration semantics for existing deployments (maintenance-window requirement in CLAUDE.md) and needs its own design. Note the deferral in the PR body.

## Acceptance criteria (all required — completion is binary)

- [ ] list()/aggregate() perform zero watermark storage reads after the first query until invalidation; invalidation on backfill completion is pinned by test.
- [ ] streamMatchingWorkflowStates reads are chunked with Promise.all; bulk streaming results unchanged.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
