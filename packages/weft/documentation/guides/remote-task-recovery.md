# Remote task recovery and result adoption

A remote worker can finish an activity while the server is restarting. It can also return an old result after the same task has been reassigned. Weft keeps one durable task record so each transition can prove which state and attempt it is changing.

The **task ledger** is that authoritative record. Queue entries, worker capacity, and deadline indexes help the server find work; they are rebuilt from the ledger after restart. This guide covers the server side of [remote workers](remote-workers.md), including readiness, retries, result adoption, and the limits of recovery.

## Starting the server

Use durable storage and await the server's readiness promise before advertising the task plane as healthy. The server needs atomic `conditionalBatch` storage operations to fence task transitions.

```typescript
import { BunSQLiteStorage, Engine, serve } from '@lostgradient/weft';

await using storage = new BunSQLiteStorage('./remote-tasks.db');
await using engine = await Engine.create({ storage, workflows: {} });
await using server = serve({
  engine,
  hostname: '127.0.0.1',
  port: 7233,
  auth: { apiKeys: [crypto.randomUUID()] },
  trustedHosts: ['127.0.0.1'],
});

await server.ready;
console.log(`Remote task recovery finished at ${server.url}`);
```

This local readiness example generates an ephemeral authentication key and binds only to loopback. A deployed host should supply its configured credentials and public origin or trusted hosts; workers need the corresponding authenticated connection described in the [wire protocol](../reference/remote-worker-protocol.md#authentication).

Dispatch, worker registration, and long-poll claim and result handling also wait for recovery internally. Listening on a port does not mean the recovery scan has finished. A storage iterator failure rejects readiness; inspect storage availability before restarting admission.

Malformed records and individual recovery failures are logged and skipped so the scan can inspect other records. Read those errors even if readiness resolves: readiness does not certify that every stored record was valid or recoverable.

## The state model

| Durable state  | Meaning                                                        | Restart behavior                                                                                      |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `queued`       | Waiting for a worker, possibly until `availableAt`             | Reconstruct delayed or immediately eligible dispatch                                                  |
| `leased`       | One worker attempt owns the task until its deadline            | Restore ownership and deadline tracking; expired attempts enter normal requeue or exhaustion handling |
| `completing`   | A result digest has been accepted but completion is unfinished | Restore ownership so redelivery can finish the transition                                             |
| `cancelling`   | Cancellation intent has been recorded for a leased attempt     | Restore ownership; the record alone does not prove the worker stopped                                 |
| `terminal`     | Resolved, cancelled, or retries exhausted                      | Retain the outcome until explicit adoption and retention policy permit removal                        |
| `deadLettered` | Completion could not be durably finished                       | Preserve the failure for inspection                                                                   |

Delayed work is a queued record with an `availableAt` timestamp, not a separate state and not merely a process-local timeout. Losing the timer does not erase its eligibility time. Priority, retry policy, headers, queue, workflow identity, and execution requirements travel with the durable record through reassignment.

Every conditional transition checks the prior record and attempt identity. Reservation also accounts for worker capacity so two asynchronous dispatches cannot both consume the same available slot. A rejected transition means another actor changed the authoritative state; it is not permission to overwrite the record.

## Attempts and worker identity

An `operationId` identifies the task. An `attemptToken` identifies one assignment of that task. Reassigning to the same `workerId` still produces a different attempt, so checking only the worker identifier would accept stale results.

Workers must echo the assigned token on results. The server rejects stale or missing ownership credentials. Keep the optional dispatched `workflowRevision` distinct from an execution requirement: the former identifies the originating workflow run, while the latter constrains which worker may execute the task. The [wire protocol](../reference/remote-worker-protocol.md) specifies the different revision-echo rules for WebSocket and long-poll results.

Worker readiness also has an identity boundary. A socket opening is followed by manifest validation and `registerAck`. The manifest separates protocol and SDK versions, runtime identity, deployment name, build, artifact digest, and workflow contracts. Reusing a deployment name and build identifier with a different artifact digest is a registration conflict. A declared capability never grants authorization.

For production artifact identity, construct a manifest from registered workflows with `buildWorkerManifestFromRegistry()` and supply a digest of the executable artifact. The default `declared-shape:` digest describes declared names; it does not prove which executable bytes the worker loaded. The [worker API reference](../reference/api-workers.md#canonical-worker-manifest) covers parsing, canonical hashing, execution identity, and manifest construction. Apply `workerAdmissionPolicy` when the host needs additional admission restrictions after authentication and manifest validation.

## Reading a result

`server.getTaskResult(operationId)` returns a public projection of the ledger. It deliberately excludes worker session and attempt credentials.

```typescript
import { serve } from '@lostgradient/weft';

declare const server: ReturnType<typeof serve>;

const result = await server.getTaskResult('invoice-42');

if (result === null) {
  console.log('No retained task record');
} else if (result.status === 'pending') {
  console.log(`Task is ${result.state}`);
} else if (result.status === 'terminal') {
  console.log(result.disposition, result.adopted);
} else {
  console.error(result.persistenceFailureReason);
}
```

A resolved result exposes `resultStatus` and `resultDigest`, plus an error when present. It does not contain the activity's result payload. The ledger proves which attempt won; it is not a durable payload mailbox. In particular, recovery of `completing` needs the worker to redeliver the matching result because only its digest was persisted there.

`null` can mean either that the task never existed or that its adopted terminal record was already reaped. Do not interpret it as proof of successful completion.

## Adoption and retention

**Adoption** is the caller's durable assertion that it has incorporated the terminal outcome. Persist your application result or workflow checkpoint first, then call `adoptTaskResult()` with the observed terminal key. A process-local read is insufficient: after a crash, the application must still know the outcome it adopted.

Resolved outcomes use `resultDigest`; cancellation and retry exhaustion use a token-safe `adoptionToken`. After your application has durably incorporated the outcome, the adoption call is:

```typescript
import { serve } from '@lostgradient/weft';

declare const server: ReturnType<typeof serve>;

const result = await server.getTaskResult('invoice-42');

if (result?.status === 'terminal') {
  const adoptionKey =
    result.disposition === 'resolved' ? result.resultDigest : result.adoptionToken;
  const adopted = await server.adoptTaskResult('invoice-42', adoptionKey);
  if (!adopted) {
    throw new Error('Task outcome changed before adoption');
  }
}
```

The application must match the observed resolved digest to the payload it incorporated. Copying the latest digest into an adoption call does not establish that relationship by itself. The engine does not automatically infer adoption from an unrelated checkpoint.

By default, terminal records are retained indefinitely. `serve({ taskRetentionWindowMs })` enables time-based reaping, but only for adopted terminal records. Unadopted outcomes remain retained regardless of age. Start with a retention window that preserves the diagnostic history your operators need; inspect adoption progress before assuming retention will bound storage growth.

## Disconnects, retries, and shutdown

A disconnect does not immediately prove that an activity failed. The server's reconnect grace window defaults to 2,000 milliseconds and temporarily excludes the disconnected worker from new routing. When a lease expires, requeue and exhaustion use the same conditional transition rules as ordinary recovery. A late completion cannot take ownership back from its successor.

Await `server.stop()` or asynchronous disposal for graceful shutdown. The server sends shutdown messages and lets connected workers drain results before closing, up to `workerShutdownTimeoutMs` (30,000 milliseconds by default). Then dispose the engine and storage. Stopping the socket first can discard the very completion messages the drain is waiting for.

The ledger does not make external activity side effects exactly-once. If an activity charged a card before its result was durably incorporated, retrying can repeat that effect. Use an idempotency key understood by the external service or a write fence in the receiving database.

## Troubleshooting

| Symptom                                    | First check                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Port is open but worker registration waits | `server.ready` and recovery scan errors                                                  |
| Task remains queued after restart          | `availableAt`, available worker capacity, queue, and accepted execution requirements     |
| Result rejected as stale                   | Assigned `attemptToken`, worker identity, and revision echo                              |
| Task stays `completing`                    | Whether the worker can redeliver the matching result payload                             |
| Terminal records keep growing              | Adoption calls and `taskRetentionWindowMs`; unadopted records are intentionally retained |
| Deployment registration conflicts          | A reused build identifier with different artifact bytes                                  |

The [result projection](../../src/server/runtime/task-result-view.ts), [recovery path](../../src/server/runtime/task-ledger-recovery.ts), and [server options](../../src/server/index.ts) define the current behavior. Verify changes with:

```bash
bun test packages/weft/src/core/task-ledger/task-ledger-transitions.test.ts packages/weft/src/server/runtime/task-ledger-recovery.test.ts packages/weft/src/server/runtime/task-result-view.test.ts
```
