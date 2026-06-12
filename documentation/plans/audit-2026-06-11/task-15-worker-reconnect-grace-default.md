# Task 15: Raise the worker reconnect grace default to 2000ms

**Severity:** medium

## Finding: 100ms default reconnect grace window causes unnecessary task requeues in cloud environments

- **Severity:** medium (durability)
- **Files (audit snapshot):** `src/server/serve-internals.ts`, `src/server/runtime/authentication-bridge.ts`

### Evidence

serve-internals.ts:48: DEFAULT_WORKER_RECONNECT_GRACE_PERIOD_MS = 100. Cloud rolling updates (ECS, Kubernetes, Cloud Run) typically take 1-30s to reconnect. With 100ms grace, every rolling-update triggers runWorkerDisconnectRequeue which calls reassignOrExpireTask with reason 'worker-disconnect', incrementing requeueCount and attempt, and starting backoff delay. Protocol doc does not caution that 100ms is for local/embedded contexts only.

### Required fix

Raise the default to 2000ms. Update documentation and JSDoc to explicitly call out that 100ms is designed for test/embedded scenarios and production cloud deployments should set workerReconnectGracePeriodMs to at least 5000ms. Optionally add a log warning when the grace period fires on a task with low attempt counts.

## Resolved default semantics

The committee resolved the ambiguity in the original fix text: the default becomes `2000ms`. `100ms` is no longer a default anywhere — it may be set explicitly for low-latency test or embedded scenarios. Documentation recommends at least `5000ms` for cloud/load-balancer deployments and explains why the shipped default is lower: Weft's primary deployment shape is single-node or local-first, where 2000ms already covers transient socket churn without delaying genuine dead-worker detection by the 5s a cloud topology warrants.

## Acceptance criteria (all required — completion is binary)

- [ ] Default reconnect grace is 2000ms; the constant and ServeOptions docs say so; nothing defaults to 100ms.
- [ ] Tests that relied on the old default set 100ms explicitly; a test pins the new default.
- [ ] configuration.md documents the option, the default, the ≥5000ms cloud recommendation, and the rationale for the difference.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
