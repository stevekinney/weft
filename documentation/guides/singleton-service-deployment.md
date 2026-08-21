# Running Weft as a Singleton Service

Weft's supported production topology is a **singleton**: one engine process driving one durable store. This guide is the operator's checklist for running that topology safely—how to enforce a single instance at the infrastructure layer, which boot checks to wire in, how to back up and restore your store, and how to confirm recovery after a deploy.

> [!NOTE]
> "Singleton" here is a deployment shape, not a code pattern. It means exactly one engine process owns a given durable store at a time. It is the only supported model until fenced multi-process ownership (`MultiEngine`) lands—see [One engine per durable store](recovery-and-deploys.md#one-engine-per-durable-store).

## Why one instance

Recovery runs on boot by default: a fresh engine sweeps the store for in-flight workflows and resumes them. With one owner, that sweep is safe. Point two engines at the same store and recovery is uncoordinated—both can resume the same workflow and both can execute its next step, firing the next activity twice. By default (`ownership: 'none'`), there is no lock, lease, or fence preventing this, so the constraint lives entirely in your deployment configuration. Opting into `ownership: 'lease'` (below) adds a genuine engine-side lease-epoch fence, and because exactly one engine holds that lease for the whole store, it does prevent two _legitimate_ owners from running at once. Two limits remain. A deposed owner—one that stalled past its lease TTL while a successor took over—can still execute a workflow's next step in the window before its next durable write loses the epoch compare-and-swap. And because the lease is global rather than per workflow, it serializes the entire store behind one writer instead of letting distinct workflows progress on distinct engines. Both are the gap [ADR 0002—Fenced Per-Workflow Ownership (MultiEngine)](../contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md) closes as an accepted contract, not yet implemented behavior.

That makes infrastructure-level enforcement the real control. Everything else in this guide—boot assertions, the optional second-instance detector—is a backstop, not a substitute.

## Enforce a single instance at the infrastructure layer

Pin your deployment to exactly one running engine, and make deploys hand off rather than overlap.

On Kubernetes, run a single replica and choose a rollout strategy that terminates the old pod before starting the new one. A `Recreate` strategy does this directly; a `RollingUpdate` must be capped so the two never coexist:

```yaml
spec:
  replicas: 1
  strategy:
    type: Recreate
  # Or, with RollingUpdate, forbid surge so the new pod waits for the old to go:
  # strategy:
  #   type: RollingUpdate
  #   rollingUpdate:
  #     maxSurge: 0
  #     maxUnavailable: 1
```

A `StatefulSet` with `replicas: 1` works equally well and gives you stable identity. Whichever you choose, **do not enable a HorizontalPodAutoscaler** (or any autoscaler) that could scale the engine above one replica.

On a single host, a single systemd unit—not a templated `@.service` instance—gives you the same guarantee:

```ini
[Service]
ExecStart=/usr/local/bin/my-weft-service
Restart=on-failure
```

The common failure modes are an autoscaler quietly set above one replica and a rolling deploy that briefly runs the old and new processes together. Both put two engines on one store. Close them at the infrastructure layer first.

## Use one production store, and require authentication

A singleton owns one durable store. Point every instance—including the one that briefly exists mid-deploy—at the same backend, and never share that store with a second service. See [Choosing a backend](storage.md#choosing-a-backend) for selecting a durable adapter; `SQLiteStorage`, `LMDBStorage`, and `NeonStorage` are all durable production options.

If you expose the engine over the network with [`serve()`](server.md), require authentication so a misconfigured deploy fails closed instead of binding an open port. Set `unauthenticatedAccess: 'reject'` or `WEFT_SERVER_AUTHENTICATION_REQUIRED=1`; either makes `serve()` throw before binding unless `auth` is configured. See [Authentication](server.md#authentication) and the [configuration reference](../reference/configuration.md#environment-variables).

## Assert durable storage at boot

Make boot fail loudly when the store is not durable enough for recovery, rather than discovering it after a crash. Call [`assertDurableStorageForRecovery()`](../reference/api-storage.md#assertdurablestorageforrecovery) before you create the engine:

```ts
import { assertDurableStorageForRecovery, Engine } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

using storage = new SQLiteStorage('./weft.db');
assertDurableStorageForRecovery(storage);
await using engine = new Engine({ storage });
void engine;
```

It accepts `persistence: 'local'` or `'remote'`, linearizable read-after-write, snapshot scans, atomic batches, and compare-and-swap. `SQLiteStorage`, `LMDBStorage`, and `NeonStorage` pass; an ephemeral or eventually-consistent backend is rejected. This is the single line that turns "I think the store is durable" into "the process refuses to start otherwise."

## Back up and restore the store

Durable execution is only as durable as your backups. The procedure is backend-specific:

- **`NeonStorage`** (managed Postgres): use Neon's built-in point-in-time restore and branching. A branch gives you a cheap, isolated copy to test a restore against before you need it for real.
- **`SQLiteStorage`**: the store is a file (plus its WAL). Back it up with the SQLite `.backup` command or a `VACUUM INTO` snapshot—both produce a consistent copy while the engine runs. Copying the raw file without checkpointing the WAL can capture a torn state, so prefer the online-backup path.
- **`LMDBStorage`**: copy the data directory, or use LMDB's `mdb_copy` for a consistent snapshot of the memory-mapped store.

Whatever the backend, rehearse a restore on a staging copy before you depend on it. A backup you have never restored is a hypothesis, not a safety net.

## Confirm recovery after a deploy

A deploy is not done when the new process binds—it is done when the new process has resumed the workflows the old one left in flight. Recovery runs on boot by default, so confirm it actually happened: list running workflows and watch one resume to a later step.

```ts
import { Engine } from '@lostgradient/weft';
declare const engine: Engine;

const running = await engine.list({ status: 'running' });
console.log(`resumed ${running.total} running workflow(s)`);
```

Make this part of your deploy smoke test rather than a manual check. See [Recovery and deploys](recovery-and-deploys.md) for the full recovery model, including how to retire unknown workflow types.

## Optional: the second-instance detector

For an extra backstop—catching the misconfigured `replicas: 2` or the overlapping deploy that slipped past your infrastructure config—enable the best-effort second-instance detector:

```ts
import { Engine } from '@lostgradient/weft';
import { NeonStorage } from '@lostgradient/weft/storage/neon';

await using storage = new NeonStorage({ url: process.env['NEON_DATABASE_URL']! });
await using engine = new Engine({ storage, detectSecondInstance: true });
void engine;
```

When enabled, each engine writes a periodic heartbeat to the store and warns (via `process.emitWarning`) if it sees another instance's heartbeat advancing while it is also running. That is precisely the autoscaling-to-two or overlapping-deploy case. The emitted warning's `name` is `WeftSecondInstanceWarning`, so you can filter on `warning.name` rather than scraping the message text. Make sure something is actually listening: `process.emitWarning` output goes to `stderr` by default, but a custom logger that swallows the process `warning` event—or a runtime that discards it—will hide the alarm. Subscribe to `process.on('warning', …)` (or run with `--trace-warnings`) so it reaches the logs you watch.

> [!WARNING]
> This is a smoke alarm, not a safety mechanism. It is **liveness detection, not fenced ownership**: it never blocks boot, gates recovery, or prevents duplicate execution. Infrastructure-level enforcement is still the real control. The detector only tells you—after the fact—that two instances are running.

A few properties worth knowing. It warns only when a foreign heartbeat advances across two of its own intervals, so a clean `Recreate` deploy (no overlap) and a brief drain overlap both stay quiet—only sustained overlap warns. Advance is measured by a monotonic per-instance sequence, _not_ wall-clock time, so the warning is immune to clock skew between hosts—a peer's sequence can't climb across two of your ticks unless it is genuinely running. The default heartbeat interval is `15s`; tune it with `secondInstanceHeartbeatInterval`, and keep it comfortably above your deploy drain window so a normal handoff doesn't sustain two ticks of overlap. (Clocks only enter the picture for the once-on-boot sweep that garbage-collects long-dead heartbeat keys, and that threshold is deliberately many intervals wide—not a tuning knob for warnings.) Because it writes to the store on every interval, it has an ongoing cost—leave it off unless you want the backstop. It is off by default.

## Optional: lease-based ownership for a clean deploy handoff

The infrastructure controls above make a deploy correct by forcing _downtime_: a `Recreate` rollout stops the old pod before the new one starts. If you want a rolling deploy to be a clean **handoff** instead of a downtime window, opt into a storage ownership lease:

```ts
import { Engine } from '@lostgradient/weft';
import { NeonStorage } from '@lostgradient/weft/storage/neon';

await using storage = new NeonStorage({ url: process.env['NEON_DATABASE_URL']! });
await using engine = await Engine.create({ storage, ownership: 'lease' });
void engine;
```

With `ownership: 'lease'`, the engine acquires a lease key in the store **before** it recovers, renews it on a heartbeat while it runs, and releases it on dispose. During a rolling deploy the incoming instance parks at boot until the outgoing instance releases the lease (or its lease expires), then recovers—preventing the ordinary rolling-deploy case where the incoming instance recovers while the outgoing one is still draining. Beyond the clean handoff, every engine-owned workflow-lifecycle write—checkpoints, starts, suspend/resume, completion and failure, forks, update responses, fired-timer cleanup, schedule state, purge commits, bulk retry reactivation, activity-reconciliation transitions, async-activity token/registration writes, and completed-review persistence—is **fenced** on the lease epoch: if a stalled outgoing instance wakes after its lease has expired and a successor has taken over, its write loses a compare-and-swap against the newer epoch instead of corrupting the successor's state, and the deposed engine tears itself down. So `ownership: 'lease'` is a genuine single-writer correctness backstop, not only a deploy-ergonomics aid. External caller mutations such as signal delivery, search-attribute edits, and tag edits are deliberately _not_ fenced, since they legitimately run against the store from outside the current engine owner.

Prompt lease handoff requires an awaited release. Disposing through `await using`, `await engine.shutdown()`, or `await engine[Symbol.asyncDispose]()` releases the lease cleanly, so wire your `SIGTERM` handler to await one of those before the process exits and set the termination grace period above your drain time plus the lease-release round trip. Synchronous `using` / `[Symbol.dispose]()` can only start release in the background while the engine currently holds the lease; if the process exits before that finishes, the next instance waits until `leaseTtl`, bounded by `leaseWaitTimeout`. Weft emits `WeftEngineLeaseSynchronousDisposeWarning` when a lease-holding engine is synchronously disposed so you can catch this shutdown path in logs.

Tuning (all optional, durations like `'30s'`): `leaseTtl` (default `30s`) is how long the lease stays valid without a renewal; `leaseRenewInterval` (default `5s`) is the heartbeat cadence—keep it well below the TTL; `leaseWaitTimeout` (default `60s`) is how long a booting instance waits for the lease before throwing `EngineLeaseAcquisitionTimeoutError`. Size `leaseWaitTimeout` above both your outgoing instance's drain time and the lease TTL, so a graceful handoff and a crash (no clean release—the lease expires after the TTL) both resolve. Lease ownership requires a storage backend with the `conditionalBatch` capability; every durable recovery backend provides it, and boot fails fast with a clear diagnostic otherwise.

Transient lease-renewal storage failures warn only after the holder's previously written lease has expired. A short storage blip while the lease is still valid does not depose the engine by itself; if a successor actually steals the lease, the next fenced write detects the newer epoch and halts the old owner.

> [!NOTE] What happens when a deposed instance tries to write
> If a stalled _outgoing_ instance—say one in a GC pause longer than the lease TTL—wakes after a successor has taken over, the very next engine-owned durable write it attempts is fenced on the lease epoch: its compare-and-swap fails against the successor's newer epoch, the write does not land, and the deposed engine tears itself down. It emits a `process.emitWarning` whose `name` is `WeftEngineLeaseLostWarning`—subscribe to `process.on('warning', …)` so deposition reaches your logs and your supervisor can restart the process. Epoch fencing makes single-writer ownership enforceable in software, but it complements rather than replaces infrastructure-level enforcement: keep `replicas: 1` + `Recreate` (or a single unit) as your first line of defense, since fencing only activates at the moment a deposed instance attempts a write.

## Future: per-workflow ownership (`workflow-lease`)

> [!NOTE] Accepted contract, not yet available
> `ownership: 'workflow-lease'` is specified in [ADR 0002—Fenced Per-Workflow Ownership (MultiEngine)](../contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md) as an accepted contract. The option's type and its two tuning fields, `workflowClaimTtl` and `workflowClaimRenewInterval`, already exist and validate at construction (see the [configuration reference](../reference/configuration.md#engineoptions)), but the claim registry that would actually enforce a per-workflow claim is not wired in yet. Selecting the mode today does not give you working fencing—it makes every workflow-scoped write fail closed with `EngineDeposedError` the moment the engine tries to commit one, because no engine ever holds a claim for any workflow. Do not select it for a production deployment yet. The rest of this section describes the deployment shape it will have once it ships, so you can plan for it.

### When to choose `workflow-lease` over `lease`

Choose `ownership: 'lease'` when a single, clean global handoff is what you want: exactly one engine owns the entire store at a time, and a rolling deploy hands that ownership from the outgoing instance to the incoming one. Choose `ownership: 'workflow-lease'` when you need more than that—distinct workflows genuinely progressing on distinct engines, sharing one store, so you can scale workflow execution across processes instead of serializing every workflow behind a single writer. The two are mutually exclusive by construction, since `ownership` is one discriminated field rather than a boolean layered on top, and the store-wide ownership-mode marker (below) stops a `'lease'`-mode engine from silently sharing a store with `'workflow-lease'`-mode engines, or the reverse.

### Storage requirement

`workflow-lease` requires a storage backend with the `conditionalBatch` capability—the same capability `ownership: 'lease'` already requires. `SQLiteStorage`, `LMDBStorage`, and `NeonStorage` all provide it. Once its construction gate is wired in, boot will fail fast with a clear diagnostic if the configured backend lacks it, the same way `ownership: 'lease'` already fails today. A second, new gate goes further: every engine sharing the store must agree on one fencing mode. The first fencing-mode engine to construct against a fresh store stamps a store-wide `ownership-mode-marker` key recording that mode, and every later fencing-mode engine compares its own configured mode against that marker at construction, failing closed with `OwnershipModeMismatchError` on a mismatch. `ownership: 'none'` engines never touch the marker, so mixing `'none'` with a fencing mode remains an undetected operator responsibility—not a new gap this mode introduces, and deliberately out of scope for it.

### Ownership signals and alerting

`workflow-lease` is specified to expose these bounded-cardinality signals once the claim registry lands:

| Signal                                        | Kind                                                                                  | What it means                                                                                           | Alert on                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weft_workflow_claim_attempts_total{outcome}` | counter                                                                               | Claim attempts by outcome: `acquired`, `takeover`, `lost_race`, `deposed`, `backoff_skipped`.           | A sustained rate of `lost_race` or `deposed` outcomes—legitimate owners being contested or knocked off their claims is not expected in steady state.    |
| `weft_workflow_claims_active`                 | gauge                                                                                 | Count of workflows this engine process currently durably holds a claim for.                             | A sudden drop with no corresponding deploy—unexpected mass deposition.                                                                                  |
| `weft_workflow_claim_renewal_failures_total`  | counter                                                                               | Renewal compare-and-swap failures for this engine process.                                              | Any sustained increase—renewal loss is the leading indicator of an event-loop stall or storage contention that will eventually produce a takeover.      |
| `WeftWorkflowClaimLostWarning`                | `process.emitWarning` event, per occurrence, `workflowId` field                       | This engine's renewal lost its compare-and-swap for one workflow and self-deposed.                      | Any occurrence outside a planned deploy or crash—subscribe to `process.on('warning', …)`, the same way you already do for `WeftEngineLeaseLostWarning`. |
| `WeftWorkflowWakeDiscardedWarning`            | `process.emitWarning` event, per occurrence, `workflowId` and `wakeKind` fields       | A stale in-memory resolver from a prior claim generation was discarded instead of driving the workflow. | A burst correlated with claim-lost warnings—a sign the same stall that lost the claim also queued stale wakes.                                          |
| Per-workflow ownership status                 | on-demand diagnostic, folded into the existing per-workflow REST/JSON-RPC status read | Current holder, epoch, and expiry for one workflow id.                                                  | Not an alerting signal on its own—use it to investigate a specific workflow during an incident.                                                         |

Workflow ids never become metric labels: the two `workflowId` occurrences above are warning-event fields and a request-scoped diagnostic parameter, not label dimensions on an exported series, matching the repository's bounded-cardinality rule for workflow, operation, worker, and queue identifiers.

### Rolling deploys, crash takeover, and rollback

Ordinary park will not release a workflow's claim—a workflow parked on `ctx.sleep()` or `ctx.waitForSignal()` stays pinned to the engine that claimed it, kept alive by that engine's renewal heartbeat, rather than becoming reacquirable by another engine in the steady state. Self-balancing across engines happens at the point a workflow is first claimed—start, a delayed-start fire, or recovery of a workflow whose prior owner has genuinely crashed—not through cheap reacquisition during park. A rolling deploy therefore looks different from the `'lease'` handoff above: instead of one clean lease transfer, new work (new starts, new delayed-start fires) lands on whichever engines are up, while workflows already claimed by an outgoing engine stay there until that engine drains, crashes, or is explicitly suspended or terminated.

Crash takeover is bounded, not instant. A claim becomes eligible for takeover only after a grace-adjusted expiry judgment—`expiresAt` plus `WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER` (`2`) times `workflowClaimRenewInterval`—has passed by the successor's own clock, and a successor only attempts takeover on its recurring reclaim scan or the next `recoverAll()` sweep. That judgment carries no weight for write safety—the epoch compare-and-swap is what is safe—but it does carry weight for execution exclusivity: a wrong judgment opens a real, bounded window in which the deposed engine's already-dispatched, non-abort-checking activities can complete before its next write loses its epoch. Activities must be idempotent or side-effect-safe regardless of ownership configuration; `workflow-lease` does not introduce that obligation, it inherits it from Weft's existing at-least-once activity model.

Rolling back the engine _binary_ itself—not the `ownership` mode, the running code—is unsafe while more than one engine remains pointed at the shared store. An old binary has no claim-checking code and no ownership-mode-marker check, so it executes workflows unconditionally and is not blocked by the marker gate, which only new-code engines enforce against each other. Scale down to a single engine process, or stop every engine, before rolling back binaries.

### Downgrading is a stop-all transition, never rolling

> [!WARNING] A rolling downgrade reopens the exact hazard this mode exists to close
> Returning a store from `ownership: 'workflow-lease'` to `'none'` or `'lease'` is safe only as a stop-all transition. Neither target mode reads or conditions writes on the `wf-owner-*` keys, and an `ownership: 'none'` engine deliberately never even checks the ownership-mode marker. If an incoming `'none'` or `'lease'` engine overlaps even briefly with a still-running `workflow-lease` owner, it recovers and executes the same workflows with no claim check at all—precisely the duplicate-execution hazard `workflow-lease` exists to prevent. The supported sequence is: stop every `workflow-lease` engine, confirm none remain, then start the replacement—a single engine for `'none'`, or the global single-writer topology for `'lease'`.

Once no `workflow-lease` engine is running, the leftover keys are inert. `wf-owner-holder:<id>` keys are garbage-collected by the extended purge/retention delete batch; `wf-owner-epoch:<id>` keys are deliberately never deleted and remain as harmless orphans, bounded in count by the total distinct workflow ids the store has ever seen. The `ownership-mode-marker` key is also left in place—it records what the store _was_ configured as—and an operator reusing the store under a different fencing mode with zero engines active may delete it as an explicit administrative action.

## Related

- [Recovery and deploys](recovery-and-deploys.md) — the recovery model and the one-engine-per-store constraint.
- [Storage](storage.md) — choosing a durable backend and the consistency contracts.
- [Server](server.md) — network exposure and authentication.
- [Configuration](../reference/configuration.md) — engine options and environment variables.
- [Observability](observability.md) — monitoring and tracing a running engine.
