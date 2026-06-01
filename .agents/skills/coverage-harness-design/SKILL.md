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
- Covering CLI output/error paths that moved coverage because of current-branch instrumentation gaps, such as `api`, `server`, `workflow`, `tail`, `completions`, and output helper regressions.
- Covering `.test-support.ts` harness modules whose consumers execute the behavior but Bun reports nested callback or unnamed-function misses.
- Editing coverage orchestration itself, especially when a failing shard or child coverage process could be accidentally masked.
- Deciding whether a coverage allowance is justified.
- Building a structural test double to reach a branch hidden by normal constructors or registries.

## Do not use

- Adding tests without a concrete uncovered branch or behavior risk.
- Hiding reachable production code with coverage ignores.
- Changing production behavior only to make instrumentation easier.

## Workflow

1. Start from fresh LCOV output and identify the exact uncovered file, line, function, or branch.
2. Decide whether the branch is reachable, dead, generated, or race-only before editing source.
3. Prefer focused regression tests that prove a real invariant, such as component-name collision suffixing or conformance error formatting.
4. For codegen and doctest work, pin both successful output and failure behavior: byte-stable `.d.ts` fixtures, strict typecheck consumers, invalid snapshot diagnostics, and malformed skip-count files.
5. For durability suites, assert all-or-nothing storage outcomes instead of assuming a kill lands before commit; validate close/reopen persistence before constructing the second engine.
6. For worker fault-injection clients, buffer frames that arrive between awaits and drain subprocess output on early exit so marker-based diagnostics do not lie under CI timing.
7. For workflow visibility coverage, prove both indexed and fallback paths when relevant; include conflict/drop behavior for backfills and cap failures for aggregates instead of only testing happy-path lists.
8. Use structural test doubles when normal builders enforce invariants that prevent exercising the target branch.
9. Keep allowlist entries narrow, documented, and removable; remove stale allowances when coverage becomes real.
10. For support-module instrumentation gaps, first add direct helper tests or fix the fake harness semantics. Only then add function-only allowances that name the Bun instrumentation limitation and leave line/branch coverage strict.
11. Remove stale allowances for deleted files immediately; absence from LCOV is not evidence that an allowance is still useful.
12. For test-only helper moves, keep helpers in `.test-support.ts` or another build-excluded shape, then run `bun run build` so the dist guard proves `bun:test`, `fake-indexeddb`, and `jsdom` did not leak into published files.
13. When the coverage runner launches subprocesses or shards, test the non-zero exit path and assert `checkCoverage()` returns `false` immediately enough that failing tests cannot be hidden by a complete-looking LCOV file.

## Verification

- Run `WEFT_COVERAGE_MODE=1 bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage`.
- Parse the generated LCOV with `scripts/check-coverage.ts` or the repository's coverage verification command.
- Run broader validation only when the coverage fix also changes production code, public APIs, or documentation.
