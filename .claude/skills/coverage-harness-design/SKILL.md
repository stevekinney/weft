---
name: coverage-harness-design
description: >-
  Use this skill when restoring or protecting Weft coverage with LCOV-backed
  branch targeting, structural test doubles, coverage allowlists, conformance
  fixtures, or tests for hard-to-reach protocol, schema, lifecycle, and CLI paths.
---

# Coverage Harness Design

## When to use

- Restoring verified 100 percent coverage from `coverage/lcov.info` or `scripts/check-coverage.ts`.
- Covering protocol parsing, OpenAPI or AsyncAPI schema branches, conformance harness output, shutdown, or observability helpers.
- Covering subprocess durability, WAL checkpoint behavior, native transaction atomicity, RemoteWorker reconnect/takeover paths, or byte-level WebSocket fault injection.
- Covering codegen declaration output, doctest extraction, skip-count parsing, or generated fixture typechecking.
- Covering workflow visibility indexes, aggregate distinct-key caps, failure-category query aliases, backfill watermarks, or Bun SQLite smoke paths.
- Covering event-log compaction watermark verification, Worker replay signatures, Worker protocol guards, payload-size admission, or post-build distribution guards.
- Covering coverage-runner allowance validation, including duplicate keys, cross-layer-shadowed keys, and dead allowances for paths excluded by `coveragePathIgnorePatterns`.
- Covering CLI output/error paths that moved coverage because of current-branch instrumentation gaps, such as `api`, `server`, `workflow`, `tail`, `version`, `completions`, and output helper regressions.
- Covering callback creator bundles whose wrappers delegate to cleanup handlers, including time-operation and stream cleanup-error paths that coverage may miss until invoked directly.
- Covering `.test-support.ts` harness modules whose consumers execute the behavior but Bun reports nested callback or unnamed-function misses.
- Restoring coverage after feature work by adding focused regressions for real edge paths before touching allowances, such as `LocalClient.startOrSignal`, start-body helpers, fair-share counters, pre-ready health, TLS server config, cleanup timers, workflow handle cache replacement, corrupt serializer payloads, MCP list filters, and bulk-delete terminal revalidation.
- Restoring coverage for session state, `startOrSignal`, schedules, and parity wait helpers by driving real helper behavior first, then deleting stale production branches or allowance entries only when tests prove they are dead.
- Fixing `scripts/check-coverage.ts` path filtering for Bun-generated temporary workflow fixtures, especially when coverage runs from deep git worktrees that record `private/tmp/` or `tmp/` paths with more `../` segments.
- Restoring retry/checkpoint coverage around `run-operation` by proving corrupt persisted retry attempts or sleep counts fail, missing retry policies on replay fail, non-`Error` failures still honor `nonRetryableErrors`, and retry-to-sleep-to-success paths checkpoint correctly.
- Restoring coverage for parallel-operation caches, activity reconciliation, callback checkpoint persistence, or coverage allowance refresh entries.
- Restoring runtime coverage around worker socket lifecycle and result-resolution diagnostics, including stale same-`workerId` socket closes and post-`taskResult` storage failures.
- Covering inline parking regressions where a workflow waiting on `waitForSignal()` replays, resumes, or serves `ctx.onQuery()` from a retained context.
- Covering `ctx.race()` / `ctx.all()` sleep, wait-signal, and activity branches, including nested deferred-consume envelopes, losing `ctx.run()` activity aborts, `ctx.speculate` finalization, duplicate signal-name rejection, and long sleep disposal.
- Covering durable operation helpers such as `getVersion()`, `sleep()`, and `review()`, including cached replay mismatch guards and explain-mode logging paths that normal workflow drives may not hit.
- Editing coverage orchestration itself, especially when a failing child coverage process could be accidentally masked.
- Deciding whether a coverage allowance is justified.
- Building a structural test double to reach a branch hidden by normal constructors or registries.

## Do not use

- Adding tests without a concrete uncovered branch or behavior risk.
- Hiding reachable production code with coverage ignores.
- Changing production behavior only to make instrumentation easier.

## Workflow

1. Start from fresh LCOV output and identify the exact uncovered file, line, function, or branch.
2. Decide whether the branch is reachable, dead, generated, or race-only before editing source.
3. Prefer focused regression tests that prove a real invariant, such as malformed async-activity JSON shaping, client-contract helper behavior, or conformance error formatting.
4. For codegen and doctest work, pin both successful output and failure behavior: byte-stable `.d.ts` fixtures, strict typecheck consumers, invalid snapshot diagnostics, and malformed skip-count files.
5. For durability suites, assert all-or-nothing storage outcomes instead of assuming a kill lands before commit; validate close/reopen persistence before constructing the second engine.
6. For worker fault-injection clients, buffer frames that arrive between awaits and drain subprocess output on early exit so marker-based diagnostics do not lie under CI timing.
7. For workflow visibility coverage, prove both indexed and fallback paths when relevant; include conflict/drop behavior for backfills and cap failures for aggregates instead of only testing happy-path lists.
8. Use structural test doubles when normal builders enforce invariants that prevent exercising the target branch.
9. Keep allowlist entries narrow, documented, and removable; remove stale allowances when coverage becomes real.
10. For support-module instrumentation gaps, first add direct helper tests or fix the fake harness semantics. Only then add function-only allowances that name the Bun instrumentation limitation and leave line/branch coverage strict.
11. Remove stale allowances for deleted files immediately; absence from LCOV is not evidence that an allowance is still useful.
12. For test-only helper moves, keep helpers in `.test-support.ts` or another build-excluded shape, then run `bun run build` so the dist guard proves `bun:test`, `fake-indexeddb`, and `jsdom` did not leak into published files.
13. When the coverage runner launches a child process, test the non-zero exit path and assert `checkCoverage()` returns `false` immediately enough that failing tests cannot be hidden by a complete-looking LCOV file.
14. Keep the current single-pass coverage shape intact unless a test proves a better split: one Bun coverage run writes `coverage/lcov.info`, and the checker should fail fast when that run exits non-zero.
15. For line-keyed allowances after cleanup PRs, re-derive the LCOV lines from a fresh `coverage/lcov.info`; do not shift allowance numbers by inspection alone.
16. For Bun anonymous-function instrumentation drift in callback-heavy test-support modules, prefer direct helper tests first and document any residual function-only allowance as instrumentation drift, not unreachable behavior.
17. For callback bundle coverage, prefer a focused test that calls the created wrapper and asserts the delegated cleanup handler receives the same error over an allowance for a reachable delegator.
18. For coverage-restoration-only pull requests, classify each miss before editing allowances: add direct behavior tests for reachable code, use structural doubles for otherwise hidden branches, and update line-keyed allowances only after a fresh `coverage/lcov.info` proves the residual miss is Bun reporting drift.
19. For server runtime worker coverage, assert externally visible diagnostics and ownership effects: stale socket close should warn, avoid requeue, and preserve the fresh socket; post-`taskResult` storage failure should emit the in-flight-leak error. Only then adjust an allowance for a residual unreachable exhaustiveness branch proven by fresh LCOV.
20. For load-sensitive tests, replace fixed sleeps with condition-based synchronization first. Add a file to `LOAD_SENSITIVE_TEST_PATHS` only when the real-time invariant cannot be made load-robust, after splitting the case into its own file and keeping the list ceiling assertion explicit.
21. For retry-state coverage, drive the persisted-state edge rather than asserting the helper directly when possible; only expose `ForTesting` helpers when the branch is otherwise unreachable through a real workflow drive.
22. For inline parking coverage, prefer a real workflow that parks on `waitForSignal()`, queries while parked, resumes to a second park, and proves replay failure handling instead of only inspecting parked-context maps.
23. For race/all branch coverage, drive real workflows through top-level and nested coordinators before adding helper-level assertions. Prove losing signal branches do not consume `sig:` records, losing `ctx.run()` branches see an aborted `ActivityContext.signal` when a sibling wins, winning branches checkpoint encoded values, and `ctx.all` waits for all finalizers before throwing.
24. For `ctx.runAll()` cache coverage, assert both fully fulfilled cache reconstruction and partial cache re-yielding so replay topology failures do not hide behind helper-only assertions.
25. For activity reconciliation coverage, prefer malformed persisted records, verifier-normalization rejection, and structural storage doubles that force claim or fenced-write conflicts over allowances for reachable ownership branches.
26. For callback checkpoint persistence coverage, drive the callback through a live engine and assert the durable workflow state, including `history.maxEvents` circuit-breaker termination, instead of only awaiting a handle-level error.
27. For schedule and `startOrSignal` coverage, prove real lifecycle edges: cancelled schedules cannot resume, cleanup-error callbacks report failures, buffered-signal races converge on one winner, and plain storage batch failures do not masquerade as idempotent success.
28. For coverage artifact filters, require both a generalized temporary-root prefix and the known generated-fixture filename pattern; add negative tests proving unrelated files under `tmp/` still count as uncovered.
29. For coverage allowance edits, test duplicate allowance keys and cross-layer-shadowed keys explicitly so one broad production allowance cannot hide a narrower source/test allowance; delete duplicate current-branch refresh entries when fresh LCOV proves the branch-level allowance is stale.
30. For coverage ignore-pattern integration, read `coveragePathIgnorePatterns` from `bunfig.toml` as the source of truth and reject allowances for files the coverage runner never instruments.
31. For `resolveDefaultStorage()` coverage, inject runtime globals instead of mutating `globalThis`, and assert the selected adapter receives the same WebExtension namespace or IndexedDB globals used during detection.

## Verification

- Run `bun run scripts/check-coverage.ts`; it clears stale coverage, runs one Bun coverage pass, parses `coverage/lcov.info`, applies explicit allowances, and enforces adjusted 100 percent line and function coverage.
- For changes to the coverage runner itself, also run the focused `scripts/check-coverage.test.ts` tests that cover coverage-process failure, LCOV parsing, and allowance handling.
- For feature-adjacent coverage restoration, run the focused tests that exercise the newly covered behavior before `bun run scripts/check-coverage.ts`, so the coverage gate is not the only proof that the assertion is meaningful.
- For retry-state coverage, run `bun test src/core/context/run-operation.test.ts` before the coverage gate.
- For parallel-cache, reconciliation, and callback checkpoint persistence coverage, run `bun test src/core/context.test.ts src/core/engine/activity-reconciliation.test.ts src/core/engine/callback-checkpoint-persistence.test.ts src/core/engine/checkpoint-io.test.ts` before the coverage gate.
- For inline parking coverage, run `bun test src/core/engine/inline-parking.test.ts src/core/engine.test.ts src/core/engine/suspend-resume.test.ts` before the coverage gate.
- For race/all branch coverage, run `bun test src/core/engine/race-branches.test.ts src/core/engine/operations-coordination.test.ts src/core/crash-recovery.test.ts` before the coverage gate.
- For durable operation helper coverage, run `bun test src/core/context/durable-operations.test.ts` before the coverage gate.
- For session-state, schedule, and `startOrSignal` coverage, run `bun test src/core/session-state-helpers.test.ts src/core/schedule.test.ts src/core/engine/start-or-signal.test.ts src/core/engine/callback-creators.test.ts src/core/parity/real-timer-wait.test-support.test.ts` before the coverage gate.
- When editing the test-sleep verifier or load-sensitive list, run `bun test scripts/verify-no-test-sleeps.test.ts scripts/husky/run-tests.test.ts` and `bun run scripts/verify-no-test-sleeps.ts`.
- Run broader validation only when the coverage fix also changes production code, public APIs, or documentation.
