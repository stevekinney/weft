# Durable Application Command Mailbox

Some work does not belong to a workflow. A user tells a long-running agent to change direction. An operator revokes a pending action. A peer service asks a resource to do something and needs to know, later and from a different process, whether that request was ever applied.

Weft's signals are the wrong tool for that. A signal is workflow control: it targets one run, it returns `Promise<void>`, and its accepted marker is `{ ok: true }` — no receipt to fetch afterward, no claim, no cancellation, no way to ask "did that ever land?" once the caller has gone away. `ApplicationMailbox` is the primitive for the other case: a durable, strictly ordered command queue that belongs to an application resource rather than to a workflow.

> [!NOTE] What this is not
> Not a message broker. There are no topics, no consumer groups, no cross-mailbox ordering, and no replication. Ordering is defined inside one mailbox and nowhere else.

## The Shape of It

A mailbox is scoped by an opaque `(namespace, resourceId)` pair. Weft never interprets either one — they are application identity, not workflow identity.

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using mailbox = new ApplicationMailbox({
  storage,
  namespace: 'bureau',
  resourceId: 'agent-7',
});

const admission = await mailbox.admit({
  caller: 'user:42',
  target: 'agent:7',
  kind: 'steer',
  payload: { form: 'inline', value: { text: 'stop and summarize' } },
  idempotencyKey: 'steer-1',
});

if (admission.status === 'admitted') {
  console.log(admission.receipt.commandId);
}
```

The mailbox requires storage that reports `conditionalBatch` support: every transition is a compare-and-swap against the exact bytes the record was read as, so an adapter without honest conditional batches cannot back one.

## Admission Returns a Receipt, Not a Void

`admit()` returns a discriminated result, and each case is ordinary control flow rather than an exception:

| Status      | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| `admitted`  | A new command was persisted. `receipt.commandId` identifies it forever.                |
| `duplicate` | The idempotency key already names this exact command. The original receipt comes back. |
| `conflict`  | The key names a command with a different caller, target, kind, or payload.             |
| `rejected`  | The backlog is full. Nothing was persisted.                                            |

Exceptions are reserved for caller mistakes (`ApplicationCommandValidationError`) and corrupt persisted state (`PersistedDataCorruptError`).

The command id is minted by the mailbox, never supplied by the caller. `idempotencyKey` is the caller's only retry handle, and it binds to the tuple `(caller, target, kind, payloadDigest)`. An exact retry returns the original receipt without creating a second command; reusing the key with anything else in that tuple changed returns a conflict and leaves the original untouched.

The payload digest is canonical, so a retry that rebuilt the same payload with its object keys in a different order is still a duplicate rather than a conflict:

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r' });

await mailbox.admit({
  caller: 'c',
  target: 't',
  kind: 'k',
  idempotencyKey: 'once',
  payload: { form: 'inline', value: { a: 1, b: 2 } },
});
const retry = await mailbox.admit({
  caller: 'c',
  target: 't',
  kind: 'k',
  idempotencyKey: 'once',
  payload: { form: 'inline', value: { b: 2, a: 1 } },
});
console.log(retry.status); // 'duplicate'
```

## Payloads

A payload is either carried inline or referenced.

An **inline** payload is stored in the durable record and encoded with Weft's structured-clone codec, so `Uint8Array`, `Map`, `Set`, and `Date` round-trip verbatim. An opaque multimodal or managed-asset value survives as whatever you put in — nothing is coerced to text. Its digest is recomputed at claim time and a mismatch fails closed.

A **reference** payload stores an opaque locator plus a caller-supplied SHA-256 digest. Weft never dereferences the locator, so it cannot verify that the remote content still matches; the claimant receives `verified: false` and the stored digest, and verification is the consumer's job. The digest is required for this form precisely because there is no other way to bind idempotency to payload identity.

```ts
import type { ApplicationCommandPayload } from '@lostgradient/weft';

const inline: ApplicationCommandPayload = {
  form: 'inline',
  value: { prompt: 'summarize', attachment: new Uint8Array([1, 2, 3]) },
};
const referenced: ApplicationCommandPayload = {
  form: 'reference',
  reference: 's3://assets/9f2c',
  digest: 'a'.repeat(64),
};
console.log(inline.form, referenced.form);
```

## Ordering Is Strict FIFO

Commands are delivered in the order they were admitted, and the delivery index is keyed by each command's original admission sequence. That has two consequences worth stating plainly.

A redelivered command re-enters at its _original_ position, not at the back of the queue. If sequence 0's lease expires while 5 is waiting, the next claim gets 0.

And the head of the queue blocks. When the head is not due yet — because it was admitted with a delay, or because it is in retry backoff — `claim()` returns `held` rather than skipping to a later command. Head-of-line blocking is the intended semantic for a per-resource command queue: a command that must be applied before the next one should not be overtaken by it.

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r' });

const result = await mailbox.claim();
if (result.status === 'held') {
  console.log(`nothing claimable until ${result.availableAt}`);
} else if (result.status === 'claimed') {
  console.log(result.claim.attemptToken);
}
```

## Claims Are Attempt-Fenced

A claim leases one command to one attempt and hands back an **attempt token**. Every later mutation from that claimant must present it. Two consumers sharing one durable store can never both hold a valid claim, and a superseded attempt cannot acknowledge, reject, cancel, extend, or heartbeat a newer one — it gets `stale` back, carrying the authoritative receipt.

The token is a fencing credential, so it appears only on `ApplicationCommandClaim`. It is deliberately absent from `ApplicationCommandReceipt`, which any observer can read: publishing it there would let a bystander settle work it never claimed.

Settle a claim with `acknowledge()` or `reject()`:

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r' });
await mailbox.admit({
  caller: 'c',
  target: 't',
  kind: 'k',
  payload: { form: 'inline', value: 1 },
});

const claimed = await mailbox.claim();
if (claimed.status === 'claimed') {
  const { commandId } = claimed.claim.receipt;
  const { attemptToken } = claimed.claim;
  const settled = await mailbox.acknowledge({ commandId, attemptToken, outcome: { ok: true } });
  console.log(settled.status); // 'settled'
}
```

`reject({ retry: true })` returns the command to its original FIFO position with an exponential backoff. Once its attempts are spent it is dead-lettered with `attempts-exhausted` instead.

## Liveness: Renewal, Activity, and the Deadline

`renew()` extends the lease and records liveness. Three things about it matter.

It is attempt-fenced, like every other mutation. It records `lastActivityAt` — transport-level evidence that the claimant is alive — separately from `progress`, a bounded caller-supplied marker of semantic progress that is never used for fencing. And it cannot move `absoluteDeadlineAt`, the ceiling admission set for the whole command across every attempt. Renewal clamps to that ceiling; past it, renewal and settlement both return `deadline-exceeded` and maintenance dead-letters the record.

`deadline-exceeded` is reported separately from `stale` on purpose. `stale` means another attempt owns the command and this one should stop. `deadline-exceeded` means the command itself is over and no attempt will settle it.

Renewal emits no fleet event. It is liveness evidence, not a state transition — the record's disposition is unchanged, so publishing an event per heartbeat would flood the feed without telling a consumer anything a receipt read does not already say.

## Cancellation Has Two Channels

Cancellation is durable before it reaches anyone. `requestCancellation()` commits the request first and only then aborts the local claimant, so a crash between the two cannot leave a claimant aborted with nothing persisted.

The four outcomes are distinct because they mean different things:

- `cancelled`: the command was not claimed, so it is terminal immediately with nothing to clean up.
- `requested`: an attempt holds it. The lease stays intact so only that attempt can finish cleanup, and `cleanupPending` is `true`.
- `already-terminal`: it had already settled. Nothing is rewritten.
- `unknown`: no such command.

An **in-process** claimant learns about cancellation through the attempt-scoped `AbortSignal` on its claim. A claimant in **another process** never sees that signal — it learns from `renew()`'s `cancellationRequested` flag, which is the cross-process channel.

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r' });
declare const commandId: string;
declare const attemptToken: string;

const renewal = await mailbox.renew({ commandId, attemptToken });
if (renewal.status === 'renewed' && renewal.cancellationRequested) {
  // Wind down and settle; the request is already durable.
}
```

A claimant that finished the work _before_ it observed the cancellation still records its `outcome` on the resulting `cancelled` receipt. That is deliberate: the effect really did happen, and discarding the result would lose evidence a reader needs to decide whether to compensate.

`awaitCleanup()` waits, bounded, for the claimant to settle. A `pending` result means the mailbox stopped waiting. It never claims the handler stopped — a distinction that matters when you are deciding whether it is safe to start replacement work.

## Backpressure

`waitForAvailable()` polls for work to become due. Its `timeoutMs` defaults to `0`, so calling it with no options checks once and returns immediately — pass a timeout to actually wait.

`maxBacklog` bounds the number of open (non-terminal) commands. Admission past it is rejected _before_ anything is persisted, so a rejected command leaves no trace. `capacity()` reports the accounting as counts only — deliberately low-cardinality, with no per-command detail.

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r', maxBacklog: 2 });
const capacity = await mailbox.capacity();
console.log(capacity.open, capacity.remaining, capacity.limit);
```

## Maintenance Is Explicit

Nothing in a mailbox runs on a hidden timer. `runMaintenance()` drives every time-based transition in one bounded pass: releasing delayed commands, reclaiming expired leases at their original FIFO position, dead-lettering commands past their absolute deadline, and retiring terminal receipts past `terminalRetentionMs`.

That makes a mailbox compatible with `backgroundTasks: 'manual'` by construction — a host that owns its own scheduling calls `runMaintenance()` and gets exactly one deterministic pass, with a report of what it did.

Retention deletes the command record, its terminal index entry, and its idempotency binding together. That last part is a real policy decision: **after retention, a retry of that idempotency key admits a new command** rather than resolving the original receipt. Retaining bindings forever is the only alternative, and it grows without bound.

## Events

Pass a `FleetEventFeed` as `events` and every state transition commits atomically with its fleet event in one conditional batch. No restart can expose the state transition without its event, or the other way round.

```ts
import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';
import { createFleetEventFeed } from '@lostgradient/weft/server/handler';

await using storage = new MemoryStorage();
const events = createFleetEventFeed(storage);
using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r', events });
console.log(mailbox.namespace);
events.dispose();
```

The event kinds are `mailbox:command-accepted`, `-available`, `-claimed`, `-retry-scheduled`, `-cancellation-requested`, `-applied`, `-rejected`, `-cancelled`, and `-dead-lettered`. Payloads are bounded: identity, state, attempt counters, and nothing else. No command payload, no failure details.

Observing the feed is non-consuming, and so is every read on the mailbox itself. `receipt()`, `list()`, and `capacity()` never claim, start, or advance work, so any number of observers can watch one mailbox without interfering with delivery or with each other.

## Contention

Every mutation retries a bounded number of times against freshly read durable state, then throws `ApplicationMailboxContentionError`. The mailbox header is deliberately a per-mailbox hot key — admission and every terminal transition both touch it, which is what makes backlog accounting exact — so a busy mailbox does see contention. Surfacing it beats spinning: it tells you contention is real, and lets you decide whether to back off or shard the resource.

## State Machine

```text
(none) ──admit──▶ accepted ──release──▶ available
                     │                     │
                     └──────claim──────────┴──▶ claimed ──acknowledge──▶ applied
                                                   │  │
                                                   │  ├──reject(final)──▶ rejected
                                                   │  ├──reject(retry)──▶ accepted (backoff)
                                                   │  └──attempts spent─▶ dead-lettered
                                                   │
                                                   └──cancel──▶ cancellation-requested ──settle──▶ cancelled

any non-terminal ──absolute deadline passed──▶ dead-lettered
```

`accepted` means admitted and durable but not yet released for delivery — an initial delay or a retry backoff. `available` means released and claimable. The four terminal states never transition again.

## What It Does Not Promise

The mailbox makes delivery intent, ordering, ownership, and disposition durable. It does not make external side effects exactly-once. A claimant that applies a command and crashes before acknowledging will see that command redelivered, exactly as Weft's activity guarantee works — see [the durability guarantee](../architecture/durability-guarantee.md). If applying a command has an external effect, that effect needs its own idempotency at the boundary that owns it.
