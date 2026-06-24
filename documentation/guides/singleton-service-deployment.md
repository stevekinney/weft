# Running Weft as a Singleton Service

Weft's supported production topology is a **singleton**: one engine process driving one durable store. This guide is the operator's checklist for running that topology safely—how to enforce a single instance at the infrastructure layer, which boot checks to wire in, how to back up and restore your store, and how to confirm recovery after a deploy.

> [!NOTE]
> "Singleton" here is a deployment shape, not a code pattern. It means exactly one engine process owns a given durable store at a time. It is the only supported model until fenced multi-process ownership (`MultiEngine`) lands—see [One engine per durable store](recovery-and-deploys.md#one-engine-per-durable-store).

## Why one instance

Recovery runs on boot by default: a fresh engine sweeps the store for in-flight workflows and resumes them. With one owner, that sweep is safe. Point two engines at the same store and recovery is uncoordinated—both can resume the same workflow and both can execute its next step, firing the next activity twice. There is no lock, lease, or fence preventing this today, so the constraint lives in your deployment configuration, not in the engine.

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

With `ownership: 'lease'`, the engine acquires a lease key in the store **before** it recovers, renews it on a heartbeat while it runs, and releases it on dispose. During a rolling deploy the incoming instance parks at boot until the outgoing instance releases the lease (or its lease expires), then recovers—preventing the ordinary rolling-deploy case where the incoming instance recovers while the outgoing one is still draining. Beyond the clean handoff, every engine-owned workflow-lifecycle write—checkpoints, starts, suspend/resume, completion and failure, forks, update responses, fired-timer cleanup, schedule state, purge commits, bulk retry reactivation, activity-reconciliation transitions, async-activity token/registration writes, and completed-review persistence—is **fenced** on the lease epoch: if a stalled outgoing instance wakes after its lease has expired and a successor has taken over, its write loses a compare-and-swap against the newer epoch instead of corrupting the successor's state, and the deposed engine tears itself down. So `ownership: 'lease'` is a genuine single-writer correctness backstop, not only a deploy-ergonomics aid. External caller mutations such as signal delivery, search-attribute edits, and tag edits are deliberately _not_ fenced, since they legitimately run against the store from outside the current engine owner. Disposing through `await using` (or `await engine[Symbol.asyncDispose]()`) is what releases the lease cleanly, so wire your `SIGTERM` handler to dispose the engine—await `engine[Symbol.asyncDispose]()` before the process exits, and set the termination grace period above your drain time plus the lease-release round-trip.

Tuning (all optional, durations like `'30s'`): `leaseTtl` (default `30s`) is how long the lease stays valid without a renewal; `leaseRenewInterval` (default `5s`) is the heartbeat cadence—keep it well below the TTL; `leaseWaitTimeout` (default `60s`) is how long a booting instance waits for the lease before throwing `EngineLeaseAcquisitionTimeoutError`. Size `leaseWaitTimeout` above both your outgoing instance's drain time and the lease TTL, so a graceful handoff and a crash (no clean release—the lease expires after the TTL) both resolve. Lease ownership requires a storage backend with the `conditionalBatch` capability; every durable recovery backend provides it, and boot fails fast with a clear diagnostic otherwise.

Transient lease-renewal storage failures warn only after the holder's previously written lease has expired. A short storage blip while the lease is still valid does not depose the engine by itself; if a successor actually steals the lease, the next fenced write detects the newer epoch and halts the old owner.

> [!NOTE] What happens when a deposed instance tries to write
> If a stalled _outgoing_ instance—say one in a GC pause longer than the lease TTL—wakes after a successor has taken over, the very next engine-owned durable write it attempts is fenced on the lease epoch: its compare-and-swap fails against the successor's newer epoch, the write does not land, and the deposed engine tears itself down. It emits a `process.emitWarning` whose `name` is `WeftEngineLeaseLostWarning`—subscribe to `process.on('warning', …)` so deposition reaches your logs and your supervisor can restart the process. Epoch fencing makes single-writer ownership enforceable in software, but it complements rather than replaces infrastructure-level enforcement: keep `replicas: 1` + `Recreate` (or a single unit) as your first line of defense, since fencing only activates at the moment a deposed instance attempts a write.

## Related

- [Recovery and deploys](recovery-and-deploys.md) — the recovery model and the one-engine-per-store constraint.
- [Storage](storage.md) — choosing a durable backend and the consistency contracts.
- [Server](server.md) — network exposure and authentication.
- [Configuration](../reference/configuration.md) — engine options and environment variables.
- [Observability](observability.md) — monitoring and tracing a running engine.
