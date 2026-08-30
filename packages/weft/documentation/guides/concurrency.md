# Durable Concurrency: Mutex and Semaphore

Sometimes two workflows must not run the same step at the same time. Only one workflow may charge a customer's card. At most three may call a rate-limited vendor API concurrently. A nightly reconciliation must not overlap with itself if a previous run is still going.

A plain in-memory lock does not survive a crash, and a database row lock does not survive the days a durable workflow might sleep. Weft solves this with [`ctx.state`](state.md), which gives you a compare-and-swap (CAS) state slot that is durable, replay-safe, and recovered automatically. `DurableMutex` and `DurableSemaphore` package the locking algorithm on top of that slot so you do not have to hand-roll FIFO fairness and crash recovery yourself.

> [!NOTE] When you do _not_ need this
> If the work is already inside a single workflow, you do not need a lock — a workflow is single-threaded by construction. Reach for these primitives only when _separate_ workflow executions contend for a shared resource.

## Workflow Definition Limits

Use a workflow definition `concurrency` policy when the limit is about how many
runs of a workflow type may be non-terminal at once. The engine enforces this at
`engine.start()` time. Excess starts are rejected immediately with
`WorkflowConcurrencyLimitExceededError`; they are not queued for later admission.

```typescript
import { Engine, workflow, WorkflowConcurrencyLimitExceededError } from '@lostgradient/weft';

type ImportInput = { customerId: string; importId: string };

const importCustomerData = workflow({
  name: 'import-customer-data',
  concurrency: {
    max: 2,
    key: (input: ImportInput) => input.customerId,
  },
}).execute(async function* (_ctx, input: ImportInput) {
  return { imported: input.importId };
});

const engine = await Engine.create({
  workflows: { 'import-customer-data': importCustomerData },
});

try {
  await engine.start('import-customer-data', {
    customerId: 'customer-123',
    importId: 'import-456',
  });
} catch (error) {
  if (error instanceof WorkflowConcurrencyLimitExceededError) {
    console.error(error.workflowType, error.partitionKey, error.limit);
  }
}

void importCustomerData;
```

When `key` is omitted, the limit applies to the workflow type as a whole:

```typescript
import { workflow } from '@lostgradient/weft';

const nightlyReconciliation = workflow({
  name: 'nightly-reconciliation',
  concurrency: { max: 1 },
}).execute(async function* () {
  return 'done';
});

void nightlyReconciliation;
```

Definition-level concurrency is for start admission only. A started workflow
holds its slot until it reaches a terminal state (`completed`, `failed`,
`cancelled`, or `timed-out`), including after a process crash and recovery. If
you need a critical section inside a workflow body, use `DurableMutex` or
`DurableSemaphore` directly.

## Debounce and Batch Patterns

Debounce and batch-trigger behavior are workflow patterns rather than
definition-level primitives in v1.

For debounce, create or update a schedule with overlap policy
`cancel-running`, or model the debounce window inside one workflow with
`ctx.sleep()` and restart that run when a new event should supersede the old
one. The important property is that each new event cancels the current pending
run before it performs the expensive work.

For batching, use a collector workflow: accept signals or updates into one
workflow, accumulate events in workflow or execution state, and flush when the
batch reaches a size or time threshold. That keeps batch membership durable and
auditable without adding a separate queued-start scheduler.

## The Mental Model

A `DurableSemaphore` stores one `LockRecord` in a single CAS state slot:

```typescript
import type { LockRecord } from '@lostgradient/weft';

const record: LockRecord = {
  holders: [{ holderId: 'workflow-a', leaseExpiresAt: 1717000030000 }],
  waiters: ['workflow-b', 'workflow-c'],
};
void record;
```

`holders` are the executions currently holding a permit — never more than the configured permit count. `waiters` is the FIFO queue. Every `acquire`/`release` is one CAS transaction over that record, so each mutation is durable and ordered.

Two ideas make it safe:

- **FIFO fairness.** A contender enqueues itself and only acquires once it reaches the head of the queue _and_ a permit is free. No barging, no starvation.
- **Leases.** Each granted permit carries a `leaseExpiresAt` timestamp. A contender may reclaim a permit whose lease has expired. This is what prevents a holder that _crashes without releasing_ from deadlocking the lock forever.

The primitive never reads the wall clock itself. You pass a deterministic `now` — captured durably, the same way you would capture any non-deterministic value in a workflow: through an activity. That keeps the lease arithmetic replay-safe.

## Choosing the Slot Scope

The lock lives in whatever CAS slot you point it at, and the contenders must address the _same_ slot. That constraint decides your scope:

- **Same workflow type:** use `ctx.state.workflow(key)`. Every run of that workflow type shares the slot. This is the common case — a `charge-card` workflow serializing against other `charge-card` runs.
- **Same execution tree:** use `ctx.state.execution(key)` when a parent and its durable children contend for a resource scoped to that one execution.
- **Across different workflow types:** route the contenders through one shared lock workflow type, or have them all acquire against a single agreed `ctx.state.workflow` slot defined on a dedicated locking workflow. Two _different_ workflow types calling `ctx.state.workflow('lock')` get _different_ slots — they will not see each other.

## A Durable Mutex

Here is a workflow that serializes a critical section. It polls `tryAcquire`, sleeping between attempts so the wait is durable — a queued workflow costs nothing while it waits, even for days.

```typescript
import { DurableMutex, initialLockRecord, workflow } from '@lostgradient/weft';
import type { LockRecord, WorkflowContext } from '@lostgradient/weft';

// Capture wall-clock time through an activity so the value is recorded in the
// effect log and replays identically. In tests, point this at your virtual clock.
const readClock = async () => Date.now();

const transfer = workflow({ name: 'transfer' }).execute(async function* (ctx: WorkflowContext) {
  const mutex = new DurableMutex({ leaseMs: 60_000 });
  const slot = ctx.state.workflow<LockRecord>('account-42:lock', {
    initial: initialLockRecord(),
  });

  // Poll until we hold the lock, waiting durably between attempts.
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const now = yield* ctx.run(readClock);
    const result = yield* mutex.tryAcquire(slot, { holderId: ctx.workflowId, now });
    if (result.acquired) break;
    yield* ctx.sleep('5 seconds');
  }

  try {
    // ...critical section: at most one transfer runs this at a time...
  } finally {
    const now = yield* ctx.run(readClock);
    yield* mutex.release(slot, { holderId: ctx.workflowId, now });
  }
});
void transfer;
```

`tryAcquire` performs a single CAS transaction and returns `{ acquired, position }`. On a failed attempt it leaves you registered in the FIFO queue, so the next poll preserves your place in line. Always release in a `finally` block so a thrown error still frees the lock.

## A Counting Semaphore

A `DurableSemaphore` with `permits: N` admits at most `N` concurrent holders. The acquire loop is identical — only the constructor changes.

```typescript
import { DurableSemaphore, initialLockRecord, workflow } from '@lostgradient/weft';
import type { LockRecord, WorkflowContext } from '@lostgradient/weft';

const readClock = async () => Date.now();

const callVendor = workflow({ name: 'call-vendor' }).execute(async function* (
  ctx: WorkflowContext,
) {
  // At most three call-vendor workflows hit the rate-limited API at once.
  const semaphore = new DurableSemaphore({ permits: 3, leaseMs: 30_000 });
  const slot = ctx.state.workflow<LockRecord>('vendor-api:lock', {
    initial: initialLockRecord(),
  });

  for (let attempt = 0; attempt < 1_000; attempt++) {
    const now = yield* ctx.run(readClock);
    const result = yield* semaphore.tryAcquire(slot, { holderId: ctx.workflowId, now });
    if (result.acquired) break;
    yield* ctx.sleep('1 second');
  }

  try {
    yield* ctx.run('callRateLimitedApi');
  } finally {
    const now = yield* ctx.run(readClock);
    yield* semaphore.release(slot, { holderId: ctx.workflowId, now });
  }
});
void callVendor;
```

A `DurableMutex` is exactly a `DurableSemaphore` with one permit — `new DurableMutex(options)` is shorthand for `new DurableSemaphore({ ...options, permits: 1 })`.

## Leases and Deadlock Avoidance

The lease is the safety net for a holder that never releases — a crash, a `kill -9`, a workflow that fails between acquiring and reaching its `finally`. Set `leaseMs` to comfortably exceed how long a healthy holder keeps the lock. When the lease expires, the next contender reclaims the permit on its next `tryAcquire`.

Two consequences to design around:

- **Hold longer than the lease and you can lose it.** If your critical section may run longer than `leaseMs`, renew the lease periodically so a contender does not reclaim a still-active permit. Yield `mutex.renew(slot, { holderId: ctx.workflowId, now })` on an interval well inside `leaseMs`; it returns `true` while you still hold the permit and `false` if your lease already lapsed and someone else took the lock — at which point you should re-acquire or bail out.
- **Pick a lease longer than your poll interval.** A waiter polling every five seconds against a one-second lease would thrash. Keep `leaseMs` well above the poll interval.

Leases prevent permanent deadlock from a crashed _holder_: the next contender reclaims the expired permit on its next `tryAcquire`, and `recoverAll()` after a restart replays cleanly because the lock record is ordinary CAS state with nothing process-bound in it.

> [!NOTE] Stale waiters
> A waiter that crashes _before_ it acquires (after `tryAcquire` enqueued it but before it reaches the head of the queue) leaves a permanent entry in `waiters`. Unlike holders, waiters have no expiry. If the entry is at the head of the queue and a permit is free, it blocks all subsequent waiters indefinitely. Use the admin-side `release` (see below) with the stale waiter's `holderId` to remove it from the queue: `release` strips the id from both `holders` and `waiters`.

## Releasing from Outside a Workflow

The same primitive works against an admin [`AtomicState`](state.md#admin-access) handle, whose methods return promises instead of workflow operations. This is useful for operational tooling — for example, an operator force-releasing a stuck lock:

```typescript
import { AtomicState, DurableMutex, initialLockRecord } from '@lostgradient/weft';
import type { LockRecord } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage/memory';

const storage = new MemoryStorage();
const slot = new AtomicState<LockRecord>(storage, 'state:workflow-scope:default:account-42:lock', {
  initial: initialLockRecord(),
});
const mutex = new DurableMutex();

// Inspect who holds the lock, then force-release a stuck holder.
const record = await mutex.inspect(slot);
const stuck = record?.holders[0]?.holderId;
if (stuck) {
  await mutex.release(slot, { holderId: stuck, now: Date.now() });
}
```

`tryAcquire`, `release`, `renew`, and `inspect` all return a promise when handed an `AtomicState` and a workflow operation when handed a `ctx.state.*` handle — the same method drives both.

## API Reference

`new DurableSemaphore(options?)` / `new DurableMutex(options?)`:

- `permits` (semaphore only): positive integer, default `1`. Maximum concurrent holders.
- `leaseMs`: positive number, default `30_000`. Lifetime of a granted lease before a contender may reclaim it.

Methods (each takes a CAS slot plus options):

- `tryAcquire(slot, { holderId, now, leaseMs? })` → `{ acquired, position }`. One CAS attempt. `position` is the zero-based FIFO position when not acquired (`0` means next in line), `-1` when acquired.
- `release(slot, { holderId, now })`. Idempotent — releasing a permit you do not hold simply clears any stale waiter entry.
- `renew(slot, { holderId, now, leaseMs? })` → `boolean`. Extends a held lease; `false` if you are not currently a holder.
- `inspect(slot)` → `LockRecord | undefined`. Reads the record without mutating it.

Use `initialLockRecord()` as the slot's `initial` value so the first reader sees an empty lock rather than `undefined`.

## Related Guides

- [State](state.md) — the CAS state slots these primitives are built on.
- [Durable Timers](durable-timers.md) — `ctx.sleep`, which drives the wait between acquire attempts.
- [Resource Management](resource-management.md) — broader patterns for sharing limited resources across workflows.
