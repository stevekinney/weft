# Phase 6C — Workflow-builder refactor cleanup

## Context

The tRPC-style workflow-builder refactor landed on branch
`refactor/workflow-builder-trpc` across 14 commits (Phases 1–5 + most of 6A/6B).
The new builder API ships as the canonical, documented, type-safe path; the
legacy `engine.register(name, handler)` / `engine.register(name, registration)`
overloads and the bare-function `workflow(handler)` overload remain in place
behind `@deprecated` JSDoc markers as a temporary bridge.
`engine.register(activityDefinition)` is NOT a legacy overload — it is the
supported registration path for activities under the builder API and stays.

This task closes out the refactor by:

1. Converting the last test file that still uses the deprecated overloads.
2. Deleting the deprecated overloads, the bridge types, and the global
   `ActivityTypes` augmentation interface.
3. Running the final declaration audit for `any`/`unknown` leaks in public
   exports.

Once shipped, the only path to register a workflow or activity is the new
chained builder; the global module-augmentation `ActivityTypes` interface no
longer exists.

## Scope

### What ships in this PR

- `src/core/engine.test.ts` converted from the deprecated overloads to the
  builder API (152 `engine.register('name', generator|{handler,…})` call sites,
  ~6,500 lines).
- The following legacy overloads deleted from `src/core/engine/index.ts` and
  `src/core/engine/registration.ts`:
  - `engine.register(name: string, handler: WorkflowFunction): void`
  - `engine.register(name: string, registration: WorkflowRegistration): void`
  - The single-argument `engine.register(workflowOrActivityDefinition)` form
    is kept — it is the supported builder-API registration path. Only the
    string-named overloads (and their object-form sibling) are removed.
- The bare-function `workflow(handler)` overload deleted from
  `src/core/types/workflow-function.ts`.
- `WorkflowRegistration`, `WorkflowDefinitionOptions` types deleted from
  `src/core/types/workflow-definition.ts`.
- Global `ActivityTypes` augmentation interface deleted from
  `src/core/types/workflow-registries.ts` along with
  `UnknownActivityNameWhenRegistryIsEmpty` and any helpers that referenced it.
- The `ctx.run<TName extends keyof ActivityTypes>` global-augmentation
  overload deleted from `src/core/types/workflow-context.ts`.
- Public declaration audit: enumerate the exported types
  `WorkflowBuilder`, `WorkflowContext`, `WorkflowDefinition`,
  `NormalizeActivities`, `ActivityArgsFor`, `ActivityResultFor`,
  `SignalPayload`, `Engine`, `Engine.register` return type, `Engine.start`
  return type, and helper exports. For each, build the emitted `.d.ts` and
  confirm no `any` / `unknown` leak in generic positions that should be
  inferred. Fix any leaks discovered.

### What does NOT ship in this PR

- Any new builder methods (e.g. `.replace()` or `.upgrade()` for the
  re-registration case skipped in workflow-retention.test.ts) — separate
  design + RFC.
- Removing the `recovered.register(workflow)` two-engine pattern.
- Unrelated examples changes — but examples that still call deleted overloads MUST be converted to the builder form as part of this PR.
- A separate "deprecated removal" PR — combined conversion + deletion ships in one PR per the rollback boundary in this plan. Migration notes are IN scope: per precondition #5, a CHANGELOG entry (if `CHANGELOG.md` exists) or a dedicated "Migration" section in the PR description (otherwise) is required, enumerating each removed overload and type.

## Preconditions (run before slice 1)

These produce evidence the rest of the plan depends on. Record the results in
the PR description so reviewers can verify.

1. **Baseline runtime measurement**. Run `bun test src/core/engine.test.ts`
   three times on the worktree branch tip; record the median wall time.
   Slice timeouts derive from `2 × median + 2s` floor, not a fixed 5000 ms.
2. **`WorkflowBuilderOptions` ↔ `WorkflowRegistration` field parity**.
   Enumerate the field list of each interface in this plan's PR description.
   Required parity: every `WorkflowRegistration` field except `handler` must
   appear on `WorkflowBuilderOptions` with the same type and semantics. Any
   gap blocks slice work until either the builder or this plan is amended.
3. **Import inventory for soon-to-be-deleted types and identifiers**. Run:
   `grep -rnE 'WorkflowRegistration|WorkflowDefinitionOptions|ActivityTypes|UnknownActivityNameWhenRegistryIsEmpty' src/ examples/ documentation/ scripts/ tests/ 2>/dev/null`.
   Classify each hit: (a) legacy bridge — convert/delete, (b) public docs —
   rewrite to builder form, (c) internal helper still needed under another
   name — rename, (d) genuine collision — investigate. Paste the
   classification into the PR description.
4. **Subprocess template-literal call-site inventory**. List each
   `String.raw\`...engine.register(...)...\`` site with its script working
   directory and existing import-resolution strategy. Each conversion must
   match that strategy (same relative path style, same module type).

5. **Package publication status check**. Record in the PR description: `package.json` `name`, `version`, `private` flag, and `publishConfig`. Weft today is `name: "@lostgradient/weft"`, `version: "0.1.0"`, `publishConfig.access: "public"`, no `private` flag. This is a published-on-publish-cadence pre-1.0 package; semver allows breaking changes in the 0.x line. A CHANGELOG entry ships with this PR if `CHANGELOG.md` exists in the repo; otherwise the PR description must include a dedicated Migration section. The entry MUST enumerate the removed overloads (`engine.register(name, handler)`, `engine.register(name, registration)`, `workflow(handler)`) and the removed types (`WorkflowRegistration`, `WorkflowDefinitionOptions`, the global `ActivityTypes` augmentation interface, `UnknownActivityNameWhenRegistryIsEmpty`) so consumers get an unambiguous upgrade path.

6. **Full `engine.register(` inventory across the test file**. Run `grep -nE "engine\.register\(" src/core/engine.test.ts` (159 expected: 152 string-named plus 7 other shapes including `engine.register(activity(...))` and multiline `engine.register(\n` continuations). Classify each by shape: (a) string-name legacy, (b) object-form legacy, (c) activity-definition legacy, (d) builder definition (already converted). Number the legacy hits 1..N in inventory order; slice assignments reference that numbering, not raw line numbers.

## The engine.test.ts conversion (the hard part)

Earlier auto-conversion of this file produced an output that deadlocked at
test load when run as a single batch (`bun test src/core/engine.test.ts`).
Individual tests selected via `bun test -t "<pattern>"` ran fine in ~100 ms;
the full 200-test run wedged at 0% CPU with no output past the bun banner.
The hypothesis behind module-scope lifting is structural resource contention,
but this is **only a hypothesis** until the first slice confirms it.

### Diagnostic-first rule

Before the second conversion slice lands, the first slice must prove the
strategy works. If slice 1 ships and the full-file run still hangs or
degrades materially against the preconditions baseline, stop and diagnose
the actual leak (`engine[Symbol.dispose]`, lingering timers, fake-timer
state, subprocess handles, signal listeners) before continuing. Do not
keep lifting workflows under the assumption deep-freeze cost is the cause.

This PR converts the file by hand, in slices, validating with the full file
test run after every ~10 calls. Strategy:

1. **Module-scope shared workflows — only when safe to share.** A workflow
   is safe to lift to module scope iff: (a) its handler closes over nothing
   per-test, (b) its registration metadata is identical across every test
   that uses it, (c) no test asserts on object identity, frozen state, or
   registration timing for that workflow. Each lifted workflow gets a
   one-line comment noting why it is safe to share. Anything failing those
   conditions stays inline. Phase 3's same-reference idempotency rule lets
   multiple tests share a lifted workflow.

2. **Per-test workflows stay inline.** Workflows whose handler closes over a
   per-test variable (counters, signal targets) keep their builder call inside
   the `it()` body.

3. **Object-form metadata moves to builder options.** Migrate
   `{ handler, version, retention, ... }` to
   `workflow({ name, version, retention, ... }).execute(fn)`. This depends
   on the precondition #2 field-parity check; do not begin metadata-bearing
   slices until that parity is recorded.

4. **Pattern D tests — deletion requires a behavior map.** Tests whose subject
   is the deprecated overload itself (e.g. `it('register(name, fn) shorthand
registers a workflow')`) may be deleted, but only after producing a
   one-line mapping per deleted test: either "syntax-only — covered by
   `<other test name>`" or "asserts behavior X — port to `<new test name>`".
   The map lives in the PR description. No silent deletions.

5. **Test intent preservation.** Every converted test must keep the same
   `describe`/`it` titles and the same `expect(...)` assertions unless the
   plan explicitly says otherwise. A test that previously asserted on a
   specific error message or event ordering must still assert on it. Slice
   commits whose diff weakens an assertion are rejected by reviewer; fix
   in-place rather than rolling forward.

6. **Subprocess template literals.** Per the precondition #4 inventory, each
   site keeps its existing import-resolution strategy. Do not introduce a
   new relative-import shape; match the script body's current imports for
   the bun process spawn that runs them. Three sites are expected — already
   shaped correctly in earlier Phase 6 work.

### Slice plan (call-site-anchored, not line-anchored)

Slices consume from the inventory produced by precondition #6 — the full `engine.register(` inventory, classified by shape — not from raw line numbers. Slice work consumes contiguous ranges from the numbered legacy hits. After every slice commit, re-run the inventory greps and confirm: total legacy-hit count dropped by the expected amount; no new legacy-shape `engine.register(` introduced; builder-form count rose by the same amount.

Approximate slicing target (~15 calls / slice, 10 slices total):

| Commit | Calls covered                                  | Purpose                                           |
| ------ | ---------------------------------------------- | ------------------------------------------------- |
| 1      | first describe block of register calls         | proves conversion strategy + module-scope lifting |
| 2      | metadata-bearing tests, schemas                | exercises builder-options parity                  |
| 3      | engine-state and replay tests                  | covers replay semantics                           |
| 4      | search-attribute and visibility tests          | covers visibility filter coverage                 |
| 5      | interceptor + child-workflow tests             | covers interceptor and child paths                |
| 6      | review and signal tests                        | covers signals                                    |
| 7      | termination + cleanup tests                    | covers cleanup ordering                           |
| 8      | terminal-state subprocess tests                | template-literal sites (preconditions #4 applies) |
| 9      | activity-worker tests                          | last register sites                               |
| 10     | overload + type deletion (no test conversions) | delete the bridge as one isolated commit          |

After each conversion commit, run `bun test src/core/engine.test.ts` foreground
with `--timeout <2 × baseline + 2s>` and confirm a full pass before moving to
the next slice. The 5 s number from earlier drafts of this plan is replaced
by the measured value; the only purpose of the timeout is hang detection.
If a slice hangs, bisect within that slice; the cause may be structural
(resource contention) or may be a missed `engine[Symbol.dispose]()`. Likely
remedies: tighten disposal, move more workflows to module scope, or split
the file into `engine.basic.test.ts` + `engine.advanced.test.ts`.

### Rollback boundary

Slice 10 (overload + type deletion) is its own commit. Slices 1–9 must
leave the deprecated overloads in place. If anything in the audit gates
fails after slice 10, revert slice 10 alone — the test conversion stays
green against the still-present deprecated overloads, and the deletion can
be retried as a separate follow-up commit. The PR is mergeable only when
slice 10 lands cleanly with all gates green.

### Caller-breakage stop signal

If deleting any overload breaks **any** non-test caller that the import
inventory (precondition #3) did not flag, stop and classify before
continuing. The earlier "≥10 unrelated callers" rule is wrong — a single
missed supported caller signals a coverage gap in the inventory.

## Audit gates

After slice 10 lands and the test file is green, run the canonical
verification list (one entry per command, no duplicates):

- `bun run typecheck` — clean.
- `bun run typecheck:tests` — clean.
- `bun run lint` — clean (no new oxlint-disable directives).
- `bun test` — full suite green. **Strictly binary gate**: if any test fails, fix it. Documenting a failure signature or referencing a tracker is not a substitute for green; the gate fails until the suite is green.
- `bun run build` — clean.
- `bun ./dist/index.js examples/hello-world.ts` — completes successfully.
- `bun run verify:documentation` — clean.
- `bun run verify:markdown-doctests` — clean.
- `bun run verify:jsdoc:doctests` — clean.
- `bun run verify:jsdoc:full` — clean.

### Public declaration audit

Greppable `: any` / `: unknown` review is a supplement, not the gate. The
gate is type-level assertions in
`src/core/types/__tests__/workflow-builder.test-d.ts` (and adjacent
`.test-d.ts` files) covering every public-surface type listed below. Any
type-test deletions or weakenings during this PR require explicit
justification in the PR description.

Types covered: `WorkflowBuilder`, `WorkflowContext`, `WorkflowDefinition`,
`BuiltWorkflowDefinition`, `NormalizeActivities`, `ActivityArgsFor`,
`ActivityResultFor`, `SignalPayload`, `UpdatePayload`, `Engine`,
`Engine.register` return type, `Engine.start` return type, `Engine.create`
return type, `WorkflowAlreadyRegistered`.

Supplement: after `bun run build`, audit `dist/index.d.ts` for `any` and
`unknown` in generic positions on the listed types using the exact
commands below (rg with explicit word-boundary alternation, avoiding
shell-quote ambiguity):

```sh
rg --no-heading --line-number '(^|[^A-Za-z0-9_$])any([^A-Za-z0-9_$]|$)' dist/index.d.ts
rg --no-heading --line-number '(^|[^A-Za-z0-9_$])unknown([^A-Za-z0-9_$]|$)' dist/index.d.ts
```

Every remaining hit must match the **intentional-`unknown` allowlist**
below. Anything not on the allowlist is a leak and blocks merge until the
underlying generic is fixed.

Intentional-`unknown` allowlist (type + position + reason):

- `DefinitionSchema<unknown, unknown>` on `WorkflowBuilderOptions.inputSchema`
  and `.outputSchema` parameters — the schema's input and output are the
  point of inference; pre-narrowing them is wrong.
- `Storage` interface methods that accept arbitrary encoded payloads
  (`Uint8Array`-of-`unknown`) — the storage layer is type-erased by design.
- `JSONValue` content fields in effect-log records — the codec is the
  enforcement boundary, not the type system.
- `migrate: (checkpoint: unknown, fromVersion: string) => unknown` on
  `WorkflowBuilderOptions` — the checkpoint shape is per-workflow and
  predates any specific version; the caller narrows.
- `WorkflowContext.run<TName>` when called with a bare string in a
  registry-empty context — the public type is `never` after deletion of
  `UnknownActivityNameWhenRegistryIsEmpty`, but the runtime path remains
  `unknown` and the declaration reflects that.

Any allowlist addition during this PR requires explicit justification in
the PR description naming the type, position, and reason. New entries are
not free — they each represent a permanent boundary in the public type
surface.

### Export-surface diff review

Diff the public export surface against the branch's merge-base with `main`
(`git merge-base HEAD main` at the time of audit). Confirm public exports
include the intended helpers and exclude every deleted type/overload. Do
not hard-code a commit SHA — use the live merge-base.

### Sweep for stragglers

After slice 10, run the final mechanical sweep. Use `rg` (ripgrep) with
explicit roots on every command — GNU/BSD grep extension differences make
shell-escaped patterns brittle. All sweep commands run from the repo root:

```sh
ROOTS="src examples documentation scripts tests"
rg --no-heading --line-number 'ActivityTypes' -t ts -t md $ROOTS
rg --no-heading --line-number "declare module ['\"][^'\"]*types\.ts" -t ts $ROOTS
rg --no-heading --line-number 'UnknownActivityNameWhenRegistryIsEmpty' -t ts $ROOTS
rg --no-heading --line-number 'ctx\.run<' -t ts $ROOTS
rg --no-heading --line-number 'workflow\(\s*(async\s+)?(function\*?|function|\(|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)' -t ts $ROOTS
rg --no-heading --line-number "engine\.register\(['\"]" -t ts $ROOTS
rg --no-heading --line-number 'engine\.register\(' -t ts -t md $ROOTS
```

The fifth pattern is a broader inventory of `workflow(` callers; classify
each hit as (a) builder-object form `workflow({ name: ... })`, or
(b) bare-function form `workflow(<callable>)`. Every (b) hit must be
converted to the builder form or the deletion will break it. The sixth
pattern — string-named `engine.register('...)` — must return zero hits
after slice 10; any hit blocks merge. The seventh pattern is a broad
`engine.register(` inventory across all roots and Markdown; classify each
hit as (i) builder-definition registration
`engine.register(<workflow-or-activity-definition-variable>)`, (ii) the
supported two-engine pattern `recovered.register(workflow)`, or (iii) a
deleted legacy shape (string-name, object-form, or activity-definition
overload). Any (iii) hit anywhere — source, tests, docs, examples,
scripts — blocks merge.

Each hit must be resolved or explained in the PR description.

## Verification

End-to-end checks all required before merge. Each maps to a command, not a
narrative:

1. **Type-level**: `bun run typecheck:tests` green. Declaration audit
   (type-test based) passes per the section above.
2. **Runtime**: `bun test` green. `bun ./dist/index.js examples/hello-world.ts`
   completes. Per-workflow activity isolation pinned by the existing
   `src/core/engine.test.ts` block covering "activities defined on one
   workflow are not callable from another" (rename if missing — must exist
   by end of conversion).
3. **Hot-add scenario**: covered by the existing test `src/core/engine/workflow-builder.test.ts` — case `hot-add after start: registerWorkflows is callable post-construction`. This test must remain present and green. No skip path.
4. **Remote worker**: `bun test src/worker/`. Required assertions live in: `src/worker/registry-routing.test.ts` (qualified activity-name routing including `welcome.formatGreeting`-style cases), `src/worker/protocol.test.ts` and `src/worker/index.test.ts` (protocolVersion negotiation and incompatible-worker rejection), `src/worker/workflow-activity-binding.test.ts` (per-workflow activity isolation at the worker boundary). All four files must be green; any added or removed test cases against those assertions go in the PR description.
5. **Documentation**: `bun run verify:jsdoc:full` green plus the doctest
   commands listed in audit gates.

## Out of scope reminders (do not let these creep in)

- New builder methods (`.replace()`, `.upgrade()`, etc.).
- Re-introducing same-name-different-reference re-registration support.
- Renaming `WorkflowDefinition` to `BuiltWorkflowDefinition` everywhere.
- Splitting `engine.test.ts` into multiple files unless required to land
  Phase 6C cleanly.
- Worker SDK migration helpers beyond what Phase 4 already shipped.

## Risks and stop signals

- **Slice 1 fails to confirm the hang hypothesis**: stop, diagnose the
  actual leak with `engine[Symbol.dispose]` audits and async-handle
  inspection before continuing. Do not mass-lift workflows on faith.
- **`WorkflowBuilderOptions` parity gap (precondition #2)**: stop. Either
  extend the builder options or carve the affected fields out of this PR's
  scope. Do not silently drop test metadata.
- **Import inventory turns up an unsupported consumer (precondition #3)**:
  classify and resolve before slice 10. A single hit blocks deletion.
- **`bun test src/core/engine.test.ts` hangs after a slice lands**: bisect
  within that slice; investigate disposal and async lifecycle before
  defaulting to "needs more module-scope lifting."
- **Declaration audit type-tests surface a leak**: do not paper over with
  type assertions; fix the underlying generic.
- **Caller-breakage stop signal**: any unexpected non-test caller of a
  deleted overload halts deletion until the caller is converted or the
  inventory is corrected.
