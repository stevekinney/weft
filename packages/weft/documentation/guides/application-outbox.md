# Durable Application Delivery Outbox

Some work has to leave the process. An agent posts a notification. A service calls a webhook. A resource hands a request to a peer over a transport it does not control. Each of those has the same awkward shape: the intent to send is application state, the send itself is an external side effect, and the two can fail independently. A process can crash after the request left and before it wrote down that it did. It can write down "sent" and then discover the wire never delivered. It can retry a request that already landed and duplicate an effect.

`ApplicationOutbox` is the primitive for that case. It makes the _intent_ durable before any attempt begins, records what the transport reported as evidence rather than as truth, and settles each delivery only through the durable disposition the outbox commits on that evidence. It is the outbound sibling of the [application mailbox](application-mailbox.md), built on the same fencing, cancellation, and recovery machinery.

> [!NOTE] What this is not
> Not a connector and not a broker. Weft ships no HTTP, email, Slack, or A2A transport; the caller supplies an adapter. There are no topics, no consumer groups, no cross-owner ordering, and no replication. And it does not make external effects exactly-once — see [What It Does Not Promise](#what-it-does-not-promise).

## The Shape of It

An outbox is scoped by an opaque `(namespace, ownerId)` pair, and delivers through an adapter you provide.

```ts
import { ApplicationOutbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using outbox = new ApplicationOutbox({
  storage,
  namespace: 'bureau',
  ownerId: 'agent-7',
  adapter: {
    async send(request) {
      void request;
      return { status: 'acknowledged', evidence: { messageId: 'm-1' } };
    },
  },
});

const admission = await outbox.enqueue({
  destinationRef: 'webhook:orders',
  kind: 'order.shipped',
  payload: { form: 'inline', value: { orderId: 42 } },
  idempotencyKey: 'order-42-shipped',
});
if (admission.status === 'enqueued') console.log(admission.receipt.deliveryId);

const delivered = await outbox.deliverNext();
if (delivered.status === 'settled') console.log(delivered.receipt.state); // 'acknowledged'
```

The outbox requires storage that reports `conditionalBatch` support and `scanConsistency: 'snapshot'`. Every transition is a compare-and-swap against the exact bytes the record was read as, and a claim is decided by reading the earliest entry of a sorted due index, which a best-effort scan could miss. `MemoryStorage`, `BunSQLiteStorage`, `LMDBStorage`, and the Postgres adapters qualify.

## Enqueue Returns a Receipt Before Anything Is Sent

`enqueue()` commits one durable delivery record — and nothing else happens. No adapter is called, no attempt is leased. The result is a discriminated value, and every case is ordinary control flow:

| Status      | Meaning                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `enqueued`  | A new delivery was persisted. `receipt.deliveryId` identifies it forever.            |
| `duplicate` | The idempotency key already names this exact delivery. The original receipt is back. |
| `conflict`  | The key names a delivery with a different destination, kind, or payload.             |
| `rejected`  | The backlog is full. Nothing was persisted.                                          |

Exceptions are reserved for caller mistakes (`ApplicationDeliveryValidationError`) and corrupt persisted state (`PersistedDataCorruptError`).

`idempotencyKey` binds to `(destinationRef, kind, payloadDigest)`. The credential reference is deliberately not part of that identity: rotating a credential must not turn a retry into a conflict, and the identity digest must never encode a secret locator. Payloads take the same inline-or-reference shape as the mailbox's, with the same canonical digest, so a retry that rebuilt the payload with its keys in a different order is still a duplicate.

## Secrets Stay Opaque

A delivery names its destination and, optionally, its credential by opaque references — `destinationRef` and `credentialRef`. The outbox never resolves either. The adapter receives `credentialRef` in its send request and looks the secret up itself.

`credentialRef` is persisted on the record because every attempt needs it, and it appears nowhere else: not on any receipt, not in any fleet event, not in any error message. Fleet events carry no destination reference either. Receipts do carry `destinationRef`, because an operator inspecting a dead-lettered delivery needs to know where it was going.

## The Attempt Is Durable Before the Send

This is the property everything else rests on. A delivery goes through two durable steps before the transport is touched:

```text
queued ──claim──▶ claimed ──begin──▶ attempting ──adapter.send()──▶ settle
```

`claimed` means an attempt holds the delivery and has not called the transport. `attempting` means the send durably began. The difference is what recovery is allowed to conclude when a lease lapses:

- A lease that lapses in `claimed` provably sent nothing. The delivery is rescheduled for another attempt, or dead-lettered when its attempt budget is spent.
- A lease that lapses in `attempting` may have sent. The request could have left the process a millisecond before the crash. Its outcome is **unknown**, and the delivery follows its unknown-outcome policy — never a blind retry.

Without the intermediate write those two cases are indistinguishable, and an outbox would have to choose between duplicating effects and abandoning deliveries. The extra compare-and-swap per delivery is the price of telling them apart.

`deliverNext()` performs both steps, calls the adapter, and settles. A host that drives the transport itself uses the same steps explicitly: `claim()`, `beginAttempt()`, then `settle()`.

## The Adapter Contract

An adapter is one function. It receives the delivery receipt, the digest-verified payload, the credential reference, the attempt token, and an `AbortSignal`; it returns what the transport reported.

```ts
import type { ApplicationDeliveryAdapter } from '@lostgradient/weft';

const adapter: ApplicationDeliveryAdapter = {
  async send({ delivery, payload, attemptToken, signal }) {
    void delivery;
    void payload;
    void signal;
    // Present attemptToken to the remote system as an idempotency key or
    // request id wherever it accepts one; it is unique per attempt.
    const accepted = attemptToken.length > 0;
    return accepted ? { status: 'acknowledged' } : { status: 'retryable', message: '503' };
  },
};
console.log(typeof adapter.send); // 'function'
```

| Outcome        | What it means                                               | What the outbox commits                                        |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `acknowledged` | The remote system confirmed the effect. `evidence` is kept. | `acknowledged`, terminal.                                      |
| `retryable`    | Nothing was confirmed and a retry is safe.                  | `retry-scheduled` with backoff, or `dead-lettered` when spent. |
| `rejected`     | The remote system refused permanently.                      | `rejected`, terminal.                                          |
| `unknown`      | The adapter cannot say whether the effect happened.         | The unknown-outcome policy.                                    |

Three things the runner does that an adapter never has to think about. A thrown error is treated as `unknown`, because the request may already have left. An attempt deadline that elapses while `send()` is still pending makes the runner stop waiting, treat the result as `unknown`, and abort the signal as it releases the attempt. And a malformed outcome — not an object, an unrecognised status, `NaN` for `retryAfterMs`, a `Map` as evidence — is mapped to `unknown` with a diagnostic message rather than thrown, since by then the send may have happened and the delivery must not be retried on the strength of nothing.

While `send()` is pending the runner renews the attempt's visibility at half the window it was granted, so a send that outlasts `visibilityTimeoutMs` but stays inside the attempt deadline is not reclaimed underneath the transport; a renewal refused because another process recovered the lease aborts the adapter's signal. A caller abort passed to `deliverNext({ signal })` or `drain({ signal })` is forwarded to that same signal, so an aborted drain reaches the adapter instead of waiting out the attempt.

Returning from `send()` **never** settles a delivery by itself. The outbox validates the outcome and commits the matching transition, fenced on the attempt token and the `attempting` bytes. Only that commit moves the record.

## Unknown Outcomes Are Policy, Not Guesswork

A transport result can be lost: a socket closes after the request is written, a process dies mid-call, an adapter throws from its own client library. The outbox never decides for you what a lost result means. `unknownOutcomePolicy`, set on the outbox and overridable per delivery, does:

| Policy                   | Disposition                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `park` (default)         | `unknown-outcome`, terminal, until an operator calls `retry()` or `deadLetter()`.                       |
| `dead-letter`            | `dead-lettered` at once, with reason `unknown-outcome`.                                                 |
| `retry-with-idempotency` | `retry-scheduled` while attempts remain. Accepted at enqueue **only** with an `externalIdempotencyKey`. |

The last row is the honest one. Retrying after an unknown outcome is safe only when the remote system can recognise the retry — an idempotency key it deduplicates on, a lookup the adapter performs first. The outbox cannot verify that; what it can do is refuse to persist a delivery that claims the policy without carrying the evidence, so recovery never has to decide what to do with a retry it cannot make safely.

```ts
import { ApplicationOutbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using outbox = new ApplicationOutbox({ storage, namespace: 'n', ownerId: 'o' });

const unsafe = await outbox
  .enqueue({
    destinationRef: 'd',
    kind: 'k',
    payload: { form: 'inline', value: 1 },
    unknownOutcomePolicy: 'retry-with-idempotency',
  })
  .catch((error: Error) => error.name);
console.log(unsafe); // 'ApplicationDeliveryValidationError'

const safe = await outbox.enqueue({
  destinationRef: 'd',
  kind: 'k',
  payload: { form: 'inline', value: 1 },
  unknownOutcomePolicy: 'retry-with-idempotency',
  externalIdempotencyKey: 'order-42-shipped',
});
console.log(safe.status); // 'enqueued'
```

A delivery whose cancellation was requested is never retried after an unknown outcome, whatever its policy: a retry would send work the caller asked to stop. It is parked instead, or dead-lettered under `dead-letter`.

## Claims, Heartbeat, and Two Kinds of Expiry

A claim leases one delivery to one attempt and hands back an **attempt token**. Every later mutation must present it. Two workers over one store can never both hold a valid claim on the same delivery, and a superseded attempt cannot begin, heartbeat, settle, or cancel a newer one — it gets `stale` back with the authoritative receipt.

Each attempt has two clocks:

- `visibilityExpiresAt` is the lease. `heartbeat()` extends it by `visibilityTimeoutMs` and records `lastActivityAt` plus an optional bounded `transportActivity` marker — bytes written, a request id — as liveness evidence that is distinct from acknowledgement and never used for fencing.
- `attemptDeadlineAt` is the ceiling, fixed at the claim as `claimedAt + attemptTimeoutMs`. Heartbeat clamps to it and can never move it. Past it, heartbeat and settlement both return `deadline-exceeded`, and maintenance recovers the delivery by the state it is in. The deadline arms no timer on the claim's signal: `deliverNext()` stops waiting for the adapter at the deadline and aborts the signal as it releases the attempt, while a host driving `claim()` itself learns the deadline has passed from those `deadline-exceeded` results.

A delivery has no deadline of its own; it has `maxAttempts`. That is the deliberate difference from the mailbox's absolute command deadline: a notification that could not be delivered today may well be deliverable tomorrow, and an operator retry can always grant one more attempt.

`deadline-exceeded` is reported separately from `stale` on purpose: `stale` means another attempt owns the delivery, `deadline-exceeded` means this attempt is over.

```ts
import { ApplicationOutbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using outbox = new ApplicationOutbox({ storage, namespace: 'n', ownerId: 'o' });
await outbox.enqueue({ destinationRef: 'd', kind: 'k', payload: { form: 'inline', value: 1 } });

const claimed = await outbox.claim();
if (claimed.status === 'claimed') {
  const { deliveryId } = claimed.claim.receipt;
  const { attemptToken } = claimed.claim;
  await outbox.beginAttempt({ deliveryId, attemptToken });
  await outbox.heartbeat({ deliveryId, attemptToken, transportActivity: { bytesWritten: 512 } });
  const settled = await outbox.settle({
    deliveryId,
    attemptToken,
    outcome: { status: 'acknowledged', evidence: { messageId: 'm-1' } },
  });
  console.log(settled.status); // 'settled'
}
```

Heartbeat emits no fleet event. It is liveness, not a disposition.

## Deliveries Are Not FIFO

The due index is keyed by the instant a delivery becomes claimable, not by enqueue order. Deliveries to different destinations are independent, so one in retry backoff must not hold back one that is due now. `claim()` and `deliverNext()` take the earliest due delivery; when the earliest entry is still in the future they report `held` with its `availableAt`. `list()` walks a separate sequence-ordered index, so listing is still in enqueue order.

This is the one place the outbox and the mailbox deliberately differ. A command queue for one resource wants strict order; an outbound queue wants throughput and isolation between destinations.

## Cancellation Has Two Channels

Cancellation is durable before it reaches anyone: `requestCancellation()` commits first and only then aborts the local attempt's signal.

- A queued, retry-scheduled, or merely claimed delivery is `cancelled` at once — nothing was sent. A claimant that was about to call `beginAttempt()` finds its compare-and-swap lost and re-reads a terminal record; the adapter is never called.
- An attempting delivery moves to `cancellation-requested`. The lease stays intact so only the current attempt can report what the transport did, and `cleanupPending` is `true`.
- A terminal delivery is reported `already-terminal`; an unknown id, `unknown`.

An acknowledgement always wins over a cancellation request. If the adapter reports `acknowledged` after cancellation was requested, the effect happened and the receipt says `acknowledged`, with `cancellationRequestedAt` retained as evidence. Any other outcome on a cancelling delivery honours the cancellation: `cancelled` when nothing was confirmed, the unknown-outcome policy when the result was lost.

An in-process attempt learns about cancellation through its signal — including through another `ApplicationOutbox` handle over the same `Storage` instance. A worker in another process learns from `heartbeat()`'s `cancellationRequested` flag. `cleanupState()` and the bounded `awaitCleanup()` report whether the attempt has settled; `pending` means the outbox stopped waiting, never that the transport stopped.

## Operator Transitions

Parked and failed deliveries are meant to be inspected and acted on. `list({ states: ['unknown-outcome'] })` finds them; two operator transitions move them.

`retry({ deliveryId })` returns an `unknown-outcome`, `dead-lettered`, or `rejected` delivery to the due index with exactly one more attempt to spend. Reopening is an admission, so it respects `maxBacklog` and reports `rejected` with the current capacity when the backlog is full — `maxAttempts` is raised to `attempt + 1` when the budget was spent, and the record's provenance (`attempt`, `retryCount`) is preserved. `deadLetter({ deliveryId, reason })` closes a parked delivery for good. Both are ordinary compare-and-swap transitions, and both emit a fleet event; a retry is labelled `outbox:delivery-retried` so a feed consumer can tell it from a first enqueue.

## Drain and Shutdown

`drain({ timeoutMs })` delivers everything that is due, runs a maintenance pass between rounds so lapsed leases are recovered, and waits — bounded — for held deliveries to come due. It reports counts only:

```ts
import { ApplicationOutbox, MemoryStorage } from '@lostgradient/weft';

await using storage = new MemoryStorage();
using outbox = new ApplicationOutbox({
  storage,
  namespace: 'n',
  ownerId: 'o',
  adapter: {
    async send() {
      return { status: 'acknowledged' };
    },
  },
});
await outbox.enqueue({ destinationRef: 'd', kind: 'k', payload: { form: 'inline', value: 1 } });

const report = await outbox.drain({ timeoutMs: 0 });
console.log(report.acknowledged, report.pending, report.drained); // 1 0 true
```

Dispositions the drain's own maintenance passes commit (a lease that lapsed after its send began, parked or dead-lettered) are counted too. `pending` is read from the durable header when the drain stops, so a drain cut short by its budget, a caller abort, or disposal reports what it committed and what remains — never that remaining work was acknowledged. `drained` is `true` only when nothing was left open.

`dispose()` releases every process-local resource: the maintenance timer if one is running, in-flight waits, and every attempt-scoped signal this handle holds. It never deletes durable work. A claim this process held stays leased until it lapses and a maintenance pass recovers it — by the state it lapsed in.

## Maintenance: Manual by Default

`runMaintenance()` drives every time-based recovery in one bounded pass: recovering lapsed leases and retiring terminal receipts past `terminalRetentionMs`. It pages through the whole keyspace with a cursor, so an outbox larger than one scan page still drains across successive calls. There is no release step: the due index is time-keyed, so a delivery becomes claimable by the clock alone.

`backgroundTasks` defaults to `'manual'`, which starts no timer at all. That is a deliberate divergence from `Engine`'s default of `'automatic'`: an outbox may be constructed one per owner, and a library should not impose one silent interval per instance. Under `'automatic'` a single self-rescheduling timer runs a maintenance pass every `maintenanceIntervalMs`, reports a failing pass to `onMaintenanceError` (default `console.error`), and is cleared by `dispose()`. Delivery is never driven by that timer; `deliverNext()` and `drain()` remain the host's call.

Retention deletes the record, its indexes, and its idempotency binding together, exactly as the mailbox does. After retention, a retry of that idempotency key enqueues a new delivery.

## Events

Pass a `FleetEventFeed` as `events` and every transition commits atomically with its fleet event. The feed must be built over the same `Storage` the outbox uses; the outbox verifies its first commit landed locally and fails loudly if it did not.

The event kinds are `outbox:delivery-queued`, `-claimed`, `-attempting`, `-retry-scheduled`, `-cancellation-requested`, `-acknowledged`, `-rejected`, `-cancelled`, `-unknown-outcome`, `-dead-lettered`, and `-retried`. Payloads are bounded: identity, state, attempt counters, and nothing else — no payload, no evidence, no failure details, and neither the destination nor the credential reference.

Observing the feed is non-consuming, and so is every read on the outbox: `receipt()`, `list()`, `capacity()`, and `cleanupState()` never claim, start, or advance work.

## Contention

Every mutation retries a bounded number of times against freshly read durable state, then throws `ApplicationOutboxContentionError`. The header is a per-outbox hot key — enqueue and every terminal transition touch it, which is what keeps `capacity()` exact — so a busy owner does see contention. Surfacing it beats spinning.

## State Machine

```text
(none) ──enqueue──▶ queued ──claim──▶ claimed ──begin──▶ attempting ──settle──▶ acknowledged
                      ▲                 │                    │  │                 rejected
                      │                 │                    │  ├──retryable──▶ retry-scheduled ──claim──▶ …
                      │                 │                    │  ├──spent──────▶ dead-lettered
                      │                 │                    │  └──unknown────▶ policy: unknown-outcome | dead-lettered | retry-scheduled
                      │                 │                    │
                      │                 └──cancel──▶ cancelled     └──cancel──▶ cancellation-requested ──settle──▶ acknowledged | cancelled | policy
                      │
                      └──operator retry── unknown-outcome | dead-lettered | rejected

lease lapses in claimed    ──▶ retry-scheduled | dead-lettered
lease lapses in attempting ──▶ policy (cleanupPending: true)
```

The five terminal states — `acknowledged`, `rejected`, `cancelled`, `unknown-outcome`, `dead-lettered` — never transition again except through an operator `retry()` or `deadLetter()`.

## What It Does Not Promise

The outbox makes delivery intent, attempts, transport evidence, and disposition durable. It does not make external effects exactly-once, and it does not prove that a remote system applied a request unless that system returns verifiable acknowledgement. Weft's README says the same of every external activity side effect: at-least-once unless the external system accepts an idempotency key, supports lookup, or provides write fencing. The attempt token is the outbox's contribution to that boundary — unique per attempt, handed to the adapter for exactly this purpose — and the unknown-outcome policy is where you decide, explicitly, what a lost result may cost.
