# RemoteWorker Wire Protocol

This document describes the versioned worker transports Weft uses to dispatch activity tasks to remote workers. The built-in TypeScript `RemoteWorker` speaks the WebSocket protocol, and `LongPollWorker` speaks the HTTP long-poll fallback. Non-TypeScript SDKs can validate the WebSocket protocol against the exported JSON Schemas instead of reverse-engineering the source.

## At a glance

- **Protocol version**: v8. `register.protocolVersion` is required and must be exactly `8`.
- **Transport**: WebSocket text frames containing JSON objects.
- **Endpoint**: `/api/v1/tasks/:queue/stream` on the Weft server. Connect to one queue per WebSocket.
- **Direction**: bidirectional. Workers send `register`, `heartbeat`, `activityHeartbeat`, `taskResult`. Server sends `task`, `cancel`, `shutdown`, `registerAck`, `registerError`, `protocolError`, `taskResultAck`.
- **Heartbeat**: workers send a session `heartbeat` every 10 seconds after registration is acknowledged, plus one `activityHeartbeat` per in-flight long-running attempt automatically, on an interval derived from that attempt's `visibilityTimeout` (COR-226, v8), and on demand whenever the activity calls `context.heartbeat(details)`. The two are independent clocks (COR-230, v5) — see [`heartbeat`](#heartbeat) and [`activityHeartbeat`](#activityheartbeat) below.
- **Authentication**: not part of the protocol envelope. Auth happens at the WebSocket transport layer.
- **Frame limit**: every server WebSocket endpoint is capped at a fixed 4 MiB raw frame size before JSON parsing. This transport ceiling is separate from `payloadSize.maxBytes`, which applies to codec-encoded workflow values at admission time.
- **Fatal close codes**: unsupported or invalid registration receives `registerError`, then WebSocket close code `1008`. A malformed protocol frame receives `protocolError`, then WebSocket close code `1002`. A permanently-rejected `taskResult` also receives `protocolError` (with correlating `operationId`/`attemptToken`, protocol v7) but does NOT close the socket — the connection itself remains usable, only that one submission is unappliable.

The public schema contract is exported from `@lostgradient/weft`:

```ts
import {
  REMOTE_WORKER_PROTOCOL_JSON_SCHEMA,
  REMOTE_WORKER_MESSAGE_SCHEMAS,
  REMOTE_WORKER_PROTOCOL_VERSION,
} from '@lostgradient/weft';
```

## Connecting

The server exposes one WebSocket endpoint per task queue:

```text
ws://server.example.com/api/v1/tasks/:queue/stream
wss://server.example.com/api/v1/tasks/:queue/stream
```

`:queue` must consist only of word characters and hyphens (`[\w-]+`). The default queue is `default`. A worker connects to exactly one queue per WebSocket connection. To serve multiple queues, open one connection per queue.

The TypeScript `RemoteWorker` accepts the full URL via its `serverUrl` option:

```ts partial
import { RemoteWorker } from '@lostgradient/weft';

using worker = new RemoteWorker({
  serverUrl: 'ws://localhost:7233/api/v1/tasks/default/stream',
  workflows: { notifications: { name: 'notifications', activities: { sendEmail } } },
  concurrency: 5,
  queue: 'default',
  deploymentName: 'notifications',
  buildId: '2026.08.19-1',
});
await worker.connect();
```

`connect()` resolves only after the server sends `registerAck`. It rejects if the server sends `registerError` or if the socket closes before acknowledgement.

### Authentication

Authentication is not specified inside protocol messages. The built-in Weft server authenticator accepts credentials on the WebSocket HTTP upgrade request:

- `Authorization: Bearer <token>` for JWTs or API keys.
- `X-API-Key: <key>` for API keys in a dedicated header.

Production deployments should use TLS (`wss://`) and pass credentials through headers or a trusted reverse proxy.

## Lifecycle

```text
Worker                              Server
  |                                   |
  |--- WebSocket open ------------->  |
  |--- register ------------------>   |
  |   <-------- registerAck -------   |   accepted, capacity is effective
  |                                   |
  |   <---------------- task ------   |
  |--- taskResult ----------------->  |
  |   <-------- taskResultAck -----   |
  |                                   |
  |--- heartbeat ------------------>  |   extends visibility for in-flight tasks
  |                                   |
  |   <---- cancel (operationId) --   |
  |--- taskResult ----------------->  |
  |   <-------- taskResultAck -----   |
  |                                   |
  |   <---- shutdown -------------    |
  |--- WebSocket close ------------>  |
```

Registration can fail before the worker is accepted:

```text
Worker                              Server
  |--- WebSocket open ------------->  |
  |--- register ------------------>   |
  |   <-------- registerError -----   |
  |   <-------- close 1008 --------   |
```

Malformed JSON, malformed message shapes, worker-to-server message types not defined by v5, and `heartbeat` or `taskResult` before registration are fatal protocol errors:

```text
Worker                              Server
  |--- malformed frame ----------->   |
  |   <-------- protocolError -----   |
  |   <-------- close 1002 --------   |
```

The server tracks the worker by `workerId` in an in-memory registry. While a worker socket is live, another socket cannot claim the same `workerId`: the duplicate registration receives `registerError` with code `invalid_registration` and the server closes that socket. This blocks same-id task hijacking when authentication is disabled, but it also means a legitimate reconnect can be rejected until the old socket's close is observed.

If a registered worker disconnects with tasks in flight, the server waits for the configured `ServeOptions.workerReconnectGracePeriodMs` before requeueing those tasks. A same-`workerId` `register` inside that grace window is either a PROVEN or an UNPROVEN resume (protocol v6, COR-220):

- **Proven** — the reconnecting `register` echoes `resumeSessionGeneration` equal to the `sessionGeneration` the server handed back on the `registerAck` for the session that just disconnected. The pending requeue is cancelled, the session's generation is left unchanged, and every in-flight attempt — its attempt token, its heartbeat-renewable lease deadline, and its absolute attempt deadline — is preserved exactly as it was at disconnect. Nothing is reclaimed and no lease is reset.
- **Unproven** — `resumeSessionGeneration` is absent or does not match. The server treats this exactly as if the grace window had already lapsed: it forfeits the disconnected session's in-flight work immediately (the same requeue the grace timer would eventually have run) and then registers a brand new session, with `sessionGeneration` incremented, before acknowledging.

If the grace window expires with no reconnect at all, the server reassigns the in-flight tasks to another available worker on the same queue (or moves them through the fallback queue path) and rotates their attempt tokens before the next dispatch. A worker that reconnects with the same `workerId` afterward always registers a fresh, unproven session — it may be reselected by routing for the very task it used to hold, but any frame it sends for the OLD attempt token is rejected: the ledger's current attempt has already moved on. The grace window defaults to `2000` ms. Use `100` only for low-latency test or embedded scenarios, and use `5000` for cloud or load-balancer deployments where replacement workers commonly need several seconds to reconnect.

## Message catalog

All messages are JSON objects with a `type` discriminator. Message schemas are available in `REMOTE_WORKER_MESSAGE_SCHEMAS`, and the full schema document is available in `REMOTE_WORKER_PROTOCOL_JSON_SCHEMA`.

Workers may ignore unknown server-to-worker message types for forward compatibility. Servers reject unknown worker-to-server message types with `protocolError` because worker messages cross the trust boundary.

### Worker -> Server

### `register`

Sent immediately after the WebSocket opens.

```json
{
  "type": "register",
  "protocolVersion": 8,
  "workerId": "<string>",
  "manifest": {
    "manifestVersion": 1,
    "protocolVersion": 8,
    "sdkVersion": "0.18.0",
    "runtime": { "name": "bun", "version": "1.3.14" },
    "deployment": {
      "name": "payments",
      "buildId": "2026-05-12.1",
      "artifactDigest": "sha256:41d0e2"
    },
    "workflows": {
      "notifications": {
        "workflowVersion": "0.0.0",
        "workflowRevision": "declared-shape:9f1c2a7b3e4d5f60",
        "contractHash": "declared-shape:9f1c2a7b3e4d5f60",
        "activities": {
          "sendEmail": {
            "contractHash": "declared-shape:1a2b3c4d5e6f7081",
            "implementationRevision": "declared-shape:1a2b3c4d5e6f7081"
          }
        }
      }
    },
    "capabilities": { "region": "us-west" }
  },
  "concurrency": 10,
  "startedAt": 1778608949187,
  "resumeSessionGeneration": 2
}
```

| Field                     | Type             | Required         | Description                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                    | `"register"`     | Yes              | Message discriminator.                                                                                                                                                                                                                                                                                                                              |
| `protocolVersion`         | `8`              | Yes              | Required v8 protocol version. Missing or unsupported versions receive `registerError`.                                                                                                                                                                                                                                                              |
| `workerId`                | string           | Yes              | Stable identifier for this worker. Must be non-empty.                                                                                                                                                                                                                                                                                               |
| `manifest`                | `WorkerManifest` | Yes              | Canonical worker manifest—deployment, runtime, workflows, activities, and capabilities. Deeply validated by `parseWorkerManifest()` server-side, not by this wire-shape layer; see [Canonical worker manifest](api-workers.md#canonical-worker-manifest). Routing `activities` are derived from `manifest.workflows`, not sent as a separate field. |
| `concurrency`             | number           | No               | Maximum concurrent tasks. Server clamps finite numbers to `[1, 1000]`. Defaults to `10`.                                                                                                                                                                                                                                                            |
| `startedAt`               | number           | No               | Worker process start time in epoch milliseconds. Defaults to registration time when omitted.                                                                                                                                                                                                                                                        |
| `resumeSessionGeneration` | number           | No (v6, COR-220) | Echo of the `sessionGeneration` the server returned on the `registerAck` for a prior session this connection is trying to resume. Present only on a reconnect; omitted on a fresh connect. A match while the reconnecting `workerId` still has a pending grace-period requeue is a PROVEN resume — see [Lifecycle](#lifecycle) above.               |

`queue`, `deploymentName`, `buildId`, `runtimeVersion`, `gitSha`, and `capabilities` are no longer top-level `register` fields as of protocol v3—deployment and runtime identity live inside `manifest`, `gitSha` was retired entirely, and the effective queue always comes from the worker-stream URL rather than a field a worker could disagree with.

The server processes `register` only on worker-stream paths (`/api/v1/tasks/:queue/stream`). On other WebSocket endpoints, worker protocol messages are ignored or handled by that endpoint's own protocol.

### `heartbeat`

Sent every 10 seconds after `registerAck`. It tells the server the worker's SESSION is alive — `WorkerRegistry.heartbeat()` updates `lastHeartbeat` — and nothing else.

```json
{
  "type": "heartbeat",
  "workerId": "<string>"
}
```

| Field      | Type          | Required | Description                               |
| ---------- | ------------- | -------- | ----------------------------------------- |
| `type`     | `"heartbeat"` | Yes      | Message discriminator.                    |
| `workerId` | string        | Yes      | The same `workerId` used at registration. |

The server validates the field for protocol shape, but it trusts the worker identity stored on the WebSocket connection, not the heartbeat payload. A heartbeat sent before successful registration receives `protocolError` and the socket is closed.

**Before v5**, a bare `heartbeat` also extended the visibility timeout of every in-flight task assigned to the connection. As of v5 (COR-230, "Session and Attempt Lease Model") it does not — visibility renewal is `activityHeartbeat`'s job, below. This is a documented change to public wire semantics, not an additive one: a v4 worker connecting to a v5 server would see its long-running attempts silently stop renewing, which is exactly why v5 is a clean protocol break rather than a negotiated one (see `REMOTE_WORKER_PROTOCOL_VERSION`'s doc comment in `worker/protocol-version.ts`).

### `activityHeartbeat`

Sent once per in-flight long-running attempt, for as long as that attempt has not yet reported a `taskResult`. `RemoteWorker` sends this AUTOMATICALLY (COR-226, protocol v8) for every in-flight attempt, on an interval derived from that dispatch's `visibilityTimeout` — roughly a third of it, floored at one second — and additionally on demand whenever the activity calls `context.heartbeat(details)`. It extends ONLY the named attempt's visibility deadline — the worker-session lease above is a completely independent clock.

```json
{
  "type": "activityHeartbeat",
  "workerId": "<string>",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "details": { "done": 3 }
}
```

| Field          | Type                  | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | `"activityHeartbeat"` | Yes      | Message discriminator.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `workerId`     | string                | Yes      | The same `workerId` used at registration.                                                                                                                                                                                                                                                                                                                                                                                  |
| `operationId`  | string                | Yes      | The opaque `operationId` from the corresponding `task` message.                                                                                                                                                                                                                                                                                                                                                            |
| `attemptToken` | string                | Yes      | Per-dispatch token from the matching `task` frame — the worker must echo it unchanged, exactly as it does on `taskResult`.                                                                                                                                                                                                                                                                                                 |
| `details`      | any JSON value        | No (v8)  | Progress details from the activity's own `context.heartbeat(details)` call — mirrors `ActivityContext.heartbeat()`'s inline-engine argument. Omitted entirely (never sent as `null`) when the automatic keepalive fires with no on-demand call to piggyback. Validated against the same `payloadSize.maxBytes` limit a `taskResult` value gets; an oversized value is rejected with `protocolError` rather than persisted. |

The server authorizes `activityHeartbeat` through the same identity check `taskResult` uses: the WebSocket connection must currently own `operationId`, and `attemptToken` must match the current dispatch exactly. A stale, superseded, or unrecognized attempt is rejected with `protocolError` rather than silently renewing (or resurrecting) a lease that no longer belongs to this attempt. Renewal is also capped by the attempt's absolute deadline — a fixed ceiling on total attempt lifetime that no heartbeat, of either kind, can extend — so a worker that only ever sends heartbeats cannot keep an attempt alive forever. When `details` is present, the server persists it as the durable attempt's `lastHeartbeatDetails`, echoed back on a later `task` frame if this attempt is ever redispatched — see `task`'s `lastHeartbeatDetails` field below.

### `taskResult`

Sent when an in-flight task completes, fails, or is cancelled.

**Success:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "status": "completed",
  "value": null
}
```

**Failure:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "status": "failed",
  "error": "<message>"
}
```

**Cancellation:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "status": "cancelled",
  "cancelled": true,
  "error": "Task cancelled"
}
```

| Field              | Type                                     | Required                    | Description                                                                           |
| ------------------ | ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `type`             | `"taskResult"`                           | Yes                         | Message discriminator.                                                                |
| `operationId`      | string                                   | Yes                         | The opaque `operationId` from the corresponding `task` message.                       |
| `status`           | `"completed" \| "failed" \| "cancelled"` | Yes                         | Terminal outcome.                                                                     |
| `value`            | any JSON value                           | Yes if `completed`          | Activity result. Use `null` when the activity has no value.                           |
| `error`            | string                                   | Yes if `failed`/`cancelled` | Human-readable error message.                                                         |
| `cancelled`        | `true`                                   | No                          | Optional marker for cancelled results. If present, it must be `true`.                 |
| `attemptToken`     | non-empty string                         | Yes                         | Per-dispatch token from the matching `task` frame. The worker must echo it unchanged. |
| `workflowRevision` | non-empty string                         | No (WFT-20)                 | Echo of `task.workflowRevision`, when the dispatch carried one. See below.            |

The server stores `completed` as a completed task and treats `failed` and `cancelled` as failed terminal resolutions. Missing `operationId`, missing `value` on completed results, unknown statuses, non-string errors on failed or cancelled results, and non-string or empty `attemptToken` values are malformed messages. The server sends `protocolError` and closes the socket with `1002`.

For a well-formed result, the server verifies that the WebSocket connection still owns the `operationId`, and then requires the echoed `attemptToken` to match the current dispatch exactly. Missing or mismatched tokens are rejected with `protocolError` before task state changes.

**Revision staleness (WFT-20).** When the dispatch carried a `workflowRevision` (see `task` below), the in-flight entry remembers it. The WebSocket transport's authorization is ADDITIVE: a `taskResult` with no `workflowRevision` echo is tolerated whenever the in-flight entry itself carries none (an older worker SDK that has never heard of the field, or a dispatch that never opted in); a `taskResult` that echoes a DIFFERENT revision than the in-flight entry's is always rejected with `protocolError`, regardless of SDK age. This is deliberately more lenient than the HTTP long-poll transport below, which has no live in-flight registry entry to fall back on and is therefore strict.

Workers must echo the token from every `task` frame:

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "status": "completed",
  "value": null
}
```

**Outbox and acknowledgement (COR-240, v4).** `RemoteWorker` buffers every `taskResult` it produces in an outbox keyed by `(operationId, attemptToken)` before attempting to send it, and `WebSocket.send()` returning does not remove that entry — a frame can be sent but never reach the server, or the server's `taskResultAck` can be sent but never reach the worker. Only a matching `taskResultAck` (see below), or a correlated `protocolError` naming that same `(operationId, attemptToken)` (protocol v7), removes the entry. A reconnect resends every still-buffered result, in insertion order, over the fresh socket; the server's ledger makes a resend idempotent (see `taskResultAck`'s `duplicate` disposition) rather than re-executing the activity a second time. Before v7, a `taskResult` the server would never apply — an unknown operation, a stale or foreign attempt, a workflow-revision mismatch, or conflicting content resubmitted under one attempt token — had no way to clear the outbox at all, so it was resent on every reconnect forever, eventually tripping `MAX_BUFFERED_TASK_RESULTS` and wedging the worker's intake.

### Server -> Worker

### `task`

Dispatched when the server has work for this worker.

```json
{
  "type": "task",
  "operationId": "<string>",
  "activityName": "<string>",
  "input": null,
  "attempt": 1,
  "workflowExecutionToken": "<string>",
  "workflowRevision": "<string>",
  "attemptToken": "<string>",
  "headers": { "<key>": "<value>" },
  "visibilityTimeout": 30000,
  "lastHeartbeatDetails": { "done": 2 }
}
```

| Field                    | Type                     | Required    | Description                                                                                                                                                                                                                               |
| ------------------------ | ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                   | `"task"`                 | Yes         | Message discriminator.                                                                                                                                                                                                                    |
| `operationId`            | string                   | Yes         | Unique task identifier the worker echoes back in `taskResult`.                                                                                                                                                                            |
| `activityName`           | string                   | Yes         | Name of the activity to execute. Must be in the worker's `activities` list.                                                                                                                                                               |
| `input`                  | any JSON value           | Yes         | Activity input. `null` is used when the dispatch input is undefined.                                                                                                                                                                      |
| `attempt`                | number                   | No          | Retry counter. Present on retries.                                                                                                                                                                                                        |
| `workflowExecutionToken` | non-empty string         | No          | Durable per-run token exposed to the activity context for external write fencing.                                                                                                                                                         |
| `workflowRevision`       | non-empty string         | No (WFT-20) | The dispatching workflow run's persisted revision, populated by the `TaskDispatch` caller (via `server.dispatchTask()`). Echo it back unchanged on `taskResult`.                                                                          |
| `attemptToken`           | non-empty string         | Yes         | Per-dispatch token the worker must echo on `taskResult` for stale-attempt rejection.                                                                                                                                                      |
| `headers`                | `Record<string, string>` | No          | Interceptor-propagated headers from the dispatch path.                                                                                                                                                                                    |
| `visibilityTimeout`      | number                   | No (v8)     | The lease duration (ms) this dispatch was claimed with — the basis for `RemoteWorker`'s automatic per-attempt `activityHeartbeat` interval (COR-226). Present on every server-dispatched frame; absent only on a hand-built test message. |
| `lastHeartbeatDetails`   | any JSON value           | No (v8)     | The heartbeat details a PRIOR attempt of this operation recorded before being redispatched (COR-226) — surfaced to the activity as `context.lastHeartbeatDetails`. Absent when no prior attempt ever heartbeated with details.            |

If the worker does not recognize `activityName`, it should send `taskResult` with `status: "failed"` and an explanatory `error`.

### `cancel`

Server requests cancellation of an in-flight task.

```json
{
  "type": "cancel",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "reason": "operator requested"
}
```

| Field          | Type       | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`         | `"cancel"` | Yes      | Message discriminator.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `operationId`  | string     | Yes      | The in-flight task the worker should abort.                                                                                                                                                                                                                                                                                                                                                                                    |
| `attemptToken` | string     | Yes      | The attempt this cancellation targets (COR-230). The worker's `AbortController` lookup is keyed by `(operationId, attemptToken)`, not `operationId` alone, so a `cancel` for an attempt the worker has already superseded (e.g. it already reported a result and moved on to a redispatch of the same `operationId`) matches nothing and is safely ignored rather than aborting the wrong attempt.                             |
| `reason`       | string     | No (v8)  | The durably recorded `cancellationReason` the server committed before sending this control (COR-223). The worker sets this as the aborted `AbortSignal`'s `reason` and reports it on the resulting `taskResult`'s `error` field, in place of the generic literal `"Task cancelled"` every version before v8 always reported. Always present on a server-sent `cancel`; optional only so a hand-built test message may omit it. |

The server records durable cancellation intent (`RemoteTaskCancelling`, via `recordCancellationIntent`) BEFORE sending this control message — a crash between the two leaves a resumable intent, never a `cancel` the ledger has no record of. Workers should signal cancellation to the activity, usually by aborting the matching `AbortSignal`, and then report the terminal outcome with `taskResult` (`status: "cancelled"`). A worker that does not respond within the server's configured cancellation deadline has its attempt settled as cancelled anyway, with cancellation disposition `uncertain: true` recorded on the terminal record — the server does not know whether the activity actually stopped.

### `shutdown`

Server requests graceful shutdown of the worker.

```json
{
  "type": "shutdown"
}
```

The TypeScript implementation sets a `shuttingDown` flag, refuses new `task` messages, stops heartbeats, drains in-flight tasks up to `disconnectTimeoutMs`, aborts anything still running after the deadline, and closes the WebSocket.

### `registerAck`

Server acknowledgement that registration succeeded.

```json
{
  "type": "registerAck",
  "protocolVersion": 8,
  "workerId": "<string>",
  "queue": "default",
  "concurrency": 10,
  "acceptedManifestDigest": "sha256:41d0e2",
  "serverCapabilities": [],
  "sessionGeneration": 1
}
```

| Field                    | Type            | Required          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                   | `"registerAck"` | Yes               | Message discriminator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `protocolVersion`        | `8`             | Yes               | Effective protocol version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `workerId`               | string          | Yes               | Accepted worker identifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `queue`                  | string          | Yes               | Effective queue from the WebSocket URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `concurrency`            | number          | Yes               | Effective concurrency after server clamping to the supported capacity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `acceptedManifestDigest` | string          | Yes               | Digest of the canonical manifest the server stored, from `computeWorkerManifestDigest()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `serverCapabilities`     | string[]        | Yes               | Bounded list of server-side capability names. Currently always empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sessionGeneration`      | number          | Yes (v6, COR-220) | The generation of the session just registered. Increments on every fresh or unproven-reconnect registration for this `workerId` while a prior session is still tracked; unchanged on a proven resume. Once a session is fully removed (the grace window lapsed with no reconnect, or the worker was explicitly unregistered), the next registration for that `workerId` starts back at `1` — generation is not a lifetime counter, only a discriminator among sessions the server still remembers. A worker caches this value and echoes it back as `register.resumeSessionGeneration` if this connection is ever lost. |

`registerAck` no longer echoes `activities`—the worker already knows what it sent, and routing activities are derived server-side from the accepted manifest. Workers should not start heartbeats or report `connect()` success until this message arrives.

### `registerError`

Server rejection of registration. The server sends this message, then closes the WebSocket with close code `1008`.

```json
{
  "type": "registerError",
  "code": "unsupported_protocol_version",
  "message": "Unsupported RemoteWorker protocol version: 1",
  "supportedProtocolVersions": [8],
  "requestedProtocolVersion": 1
}
```

| Field                       | Type                                                                                                           | Required | Description                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                      | `"registerError"`                                                                                              | Yes      | Message discriminator.                                                                                                                                                                                                                                         |
| `code`                      | `"invalid_registration" \| "unsupported_protocol_version" \| "deployment_conflict" \| "registration_rejected"` | Yes      | Machine-readable registration failure. `deployment_conflict` means the manifest's `(deploymentName, buildId)` was already registered with a different `artifactDigest`; `registration_rejected` means a configured `WorkerAdmissionPolicy` refused the worker. |
| `message`                   | string                                                                                                         | Yes      | Human-readable diagnostic.                                                                                                                                                                                                                                     |
| `supportedProtocolVersions` | number[]                                                                                                       | Yes      | The _server's_ supported protocol versions—not narrowed to the requesting worker's own, so a mismatched value can still be parsed and diagnosed.                                                                                                               |
| `requestedProtocolVersion`  | number                                                                                                         | No       | Version sent by the worker when it was a finite number.                                                                                                                                                                                                        |

### `protocolError`

Server rejection of a malformed worker-to-server frame after the WebSocket is open. The server sends this message, then closes the WebSocket with close code `1002` — except for a rejected `taskResult`, below, which does NOT close the socket, since the connection itself remains perfectly usable.

For a rejected `taskResult` the server will never apply no matter how many times it is resent — unknown operation, stale or foreign attempt, a workflow-revision mismatch, or conflicting content resubmitted under one attempt token — `operationId` and `attemptToken` (protocol v7) echo back the rejected submission's identity, so the worker can correlate the rejection against its `TaskResultOutbox` and drop the entry instead of resending it forever:

```json
{
  "type": "protocolError",
  "code": "invalid_message",
  "message": "taskResult for operation \"op-1\" rejected — stale attempt token",
  "operationId": "op-1",
  "attemptToken": "attempt-token"
}
```

**The identity-authorization rejection message text is machine-distinguishable by class (COR-237)**, not just human prose, when the authorization gate itself rejects the submission (before it ever reaches the durable ledger): `"...rejected — unknown operation"` means no ledger record has ever existed for this `operationId` at all; `"...rejected — stale attempt token"` means the attempt token did not match the current attempt; `"...rejected — task not assigned to worker \"<workerId>\""` covers both a foreign worker holding the current attempt and a record that exists but is not a live attempt right now (e.g. still `queued`) — both read the same from the worker's point of view ("someone else, or no one right now, holds this attempt"). A submission that instead PASSES that gate but is then rejected by the ledger itself — most notably conflicting content resubmitted under one attempt token — gets a `protocolError` whose `message` interpolates the ledger's own free-text reason (`"...rejected — conflicting content resubmitted for operation ... under attempt token ..."`) rather than one of the fixed phrasings above; long-poll's equivalent 403 carries this same ledger-level outcome as the structured `"reason": "conflicting-content"` instead (see the long-poll `/result` response table above).

Both fields are absent for a malformed frame with no operation to correlate against:

```json
{
  "type": "protocolError",
  "code": "invalid_message",
  "message": "taskResult.operationId must be a non-empty string"
}
```

| Field          | Type                                                                                       | Required | Description                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`         | `"protocolError"`                                                                          | Yes      | Message discriminator.                                                                                                                                 |
| `code`         | `"invalid_json" \| "invalid_message" \| "unknown_message_type" \| "registration_required"` | Yes      | Machine-readable protocol failure.                                                                                                                     |
| `message`      | string                                                                                     | Yes      | Human-readable diagnostic.                                                                                                                             |
| `operationId`  | non-empty string                                                                           | No (v7)  | Present only for a permanently-rejected `taskResult` — the `operationId` from the submission this rejects.                                             |
| `attemptToken` | non-empty string                                                                           | No (v7)  | Present only for a permanently-rejected `taskResult` — the `attemptToken` from the submission this rejects, matched against the worker's outbox entry. |

### `taskResultAck`

Server acknowledgement of a worker's `taskResult` (COR-240, v4). Sent after the durable task ledger has resolved the submission — after a hard rejection (unknown operation, stale attempt, conflicting content under one attempt token, or a queued/newer attempt already in progress, or a workflow-revision mismatch) the worker instead receives a correlated `protocolError` (protocol v7) naming the same `operationId`/`attemptToken`.

```json
{
  "type": "taskResultAck",
  "operationId": "<string>",
  "attemptToken": "<string>",
  "disposition": "applied"
}
```

| Field          | Type                                          | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | `"taskResultAck"`                             | Yes      | Message discriminator.                                                                                                                                                                                                                                                                                                                                                                                                |
| `operationId`  | non-empty string                              | Yes      | The `operationId` from the `taskResult` this acknowledges.                                                                                                                                                                                                                                                                                                                                                            |
| `attemptToken` | non-empty string                              | Yes      | The `attemptToken` from the `taskResult` this acknowledges — matched against the worker's outbox entry.                                                                                                                                                                                                                                                                                                               |
| `disposition`  | `"applied" \| "duplicate" \| "dead-lettered"` | Yes      | `applied`: the ledger recorded this attempt's result for the first time. `duplicate`: the ledger already held a terminal record for this exact `(operationId, attemptToken)` and content — a resend after an ambiguous send, or after a server restart, re-affirmed without a new write. `dead-lettered`: the result could not be durably applied (or already couldn't be) and was recorded as a dead letter instead. |

This message removes the matching entry from the worker's outbox once the ledger resolves the submission. A correlated `protocolError` (protocol v7, above) removes it too, but for the opposite reason — the ledger will never resolve that submission, so resending it forever would be strictly worse than dropping it. See the outbox note under `taskResult` above.

## Conformance

Use `weft conformance` to run the SDK-facing protocol checks against a candidate worker process:

```bash
weft conformance --timeout 15000 --json -- ./my-worker --flag value
```

The command starts a localhost Weft server and launches the worker command with these environment variables:

| Variable                       | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `WEFT_WORKER_URL`              | WebSocket URL for the temporary worker endpoint. |
| `WEFT_WORKER_QUEUE`            | Queue name the worker should register for.       |
| `WEFT_WORKER_ACTIVITIES`       | Comma-separated activity names to implement.     |
| `WEFT_WORKER_PROTOCOL_VERSION` | Current protocol version, `8`.                   |

The conformance runner verifies registration acknowledgement, echo task completion, heartbeat-preserved work, cancellation, in-flight reassignment after disconnect, graceful shutdown, and failure of a deliberately broken worker fixture. `--json` returns a stable machine-readable report. Without `--json`, each check prints as `PASS` or `FAIL`.

### Required activities

The worker command under test must implement exactly the activities named in `WEFT_WORKER_ACTIVITIES` (`conformance.echo`, `conformance.sleep`, `conformance.cancel`):

- **`conformance.echo`** completes immediately: `status: "completed"`, `value` equal to the dispatched `input`.
- **`conformance.cancel`** completes `status: "failed"` after `input.milliseconds` unless a `cancel` control message for that same attempt arrives first, in which case it completes `status: "cancelled"` instead — proving the cooperative cancel path produced the result, not a coincidental timeout.
- **`conformance.sleep`** completes after `input.milliseconds` (default 25) with `status: "completed"`, `value` equal to `input` — except when `input.holdForReassignment` is `true` (COR-235), which only the reconnect check below sends. Then the worker must instead key its behavior on the `task` message's own `attempt` field: while `attempt` is `1` or absent, do not send a result at all, no matter how long the task sits — the harness kills this worker before it would ever get the chance, and a result sent anyway races the kill and can defeat the check it is trying to prove. Once a `conformance.sleep` task for the same operation arrives with `attempt` greater than `1`, complete it immediately.

### Reassignment after disconnect

The reconnect check dispatches one `conformance.sleep` task with `holdForReassignment: true`, confirms the worker accepted it, starts a second worker process, kills the first, and expects the server to hand the second worker the _same_ operation as a new attempt (`attempt` incremented) and to see it resolved. A worker that has no notion of `holdForReassignment` and completes the first attempt anyway — the pre-COR-235 behavior — now fails this check with a message naming the operation and "claimed past attempt 1": that is intentional, not a regression in the harness. It is exactly the production failure mode the check exists to catch — a worker with nowhere to buffer or hold an in-flight result loses it silently on reconnect the same way it would here.

## HTTP long-poll transport

`LongPollWorker` uses the same canonical worker manifest, queue identity, activity execution model, attempt fencing, and durable result acknowledgement as the WebSocket transport over plain HTTP. It does not use the WebSocket `register` frame. Instead, a worker explicitly registers a session, polls that accepted session for work, sends session heartbeats and activity heartbeats, posts results for durable acknowledgement, and unregisters the session on graceful stop. The opaque `sessionId` is a routing handle only; authentication still comes from the configured worker principal and must include `workers:write` when server authentication is enabled. Registration also returns a server-issued `sessionToken`; every continuation request must present it in the `Weft-Worker-Session-Token` header so leaking a session id alone cannot drive another worker's session.

### Register session

```text
POST /api/v1/worker-sessions
Content-Type: application/json
```

```json
{
  "manifest": { "manifestVersion": 1, "protocolVersion": 8, "workflows": {} },
  "queue": "gpu",
  "concurrency": 5,
  "startedAt": 1778608010000
}
```

The `manifest` body is the same strict worker manifest the WebSocket transport sends in its `register` frame. The server validates it before accepting the session, derives the advertised activity set from the manifest, records the queue from this registration as authoritative, and exposes the worker in worker and deployment summaries with `transport: "long-poll"`.

| Response | Meaning                                                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`    | Session accepted. Body includes `{ "ok": true, "sessionId": "...", "sessionToken": "...", "workerId": "...", "queue": "...", "acceptedManifestDigest": "...", "protocolVersion": 8 }`. |
| `400`    | Invalid JSON, malformed manifest, unsupported protocol version, invalid queue, or invalid concurrency.                                                                                 |
| `403`    | Authentication was present but did not include `workers:write`.                                                                                                                        |
| `409`    | The manifest conflicts with an existing deployment identity.                                                                                                                           |

Readiness is false until this registration succeeds. A worker that cannot register retries registration; it does not poll anonymously and a session id never replaces authentication. The session token is returned only in this registration response and is not exposed by diagnostics.

### Poll session

```text
GET /api/v1/worker-sessions/:sessionId/tasks?timeout=<milliseconds>
Weft-Worker-Session-Token: <sessionToken>
```

`timeout` is optional; it defaults to `30000` milliseconds and is clamped to a maximum of `60000` milliseconds. Activity matching comes from the accepted manifest, not from query parameters.

| Response | Meaning                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `200`    | A task was claimed and the response body is the task JSON.                                                                             |
| `204`    | No matching task became available before the timeout, or the client disconnected before a claim.                                       |
| `403`    | Authentication failed for `workers:write`, the session token did not match, or the authenticated principal no longer owns the session. |
| `404`    | The session is unknown or already unregistered.                                                                                        |
| `409`    | The session generation is stale, or the session is draining and cannot accept new tasks.                                               |
| `410`    | The session lease expired before the poll.                                                                                             |

Task response body:

```json
{
  "operationId": "activity-operation-id",
  "activityName": "order.chargeCard",
  "input": { "orderId": "order-42" },
  "attempt": 1,
  "headers": { "traceparent": "00-..." },
  "workerId": "session-id",
  "workflowExecutionToken": "workflow-run-token",
  "workflowRevision": "sha256:9f2c…",
  "attemptToken": "per-claim-token",
  "visibilityTimeout": 30000,
  "lastHeartbeatDetails": { "done": 2 }
}
```

`operationId`, `workerId`, `attemptToken`, and `workflowRevision` form the fenced completion identity. Echo them unchanged in result and activity-heartbeat requests. Unknown operations, queued operations, wrong-session completions, stale attempt tokens, and revision mismatches are explicit non-success dispositions instead of being coerced into activity failures.

### Result acknowledgement

```text
POST /api/v1/worker-sessions/:sessionId/results
Content-Type: application/json
Weft-Worker-Session-Token: <sessionToken>
```

```json
{
  "operationId": "activity-operation-id",
  "workerId": "session-id",
  "attemptToken": "per-claim-token",
  "status": "completed",
  "value": null
}
```

`status` is one of `"completed"`, `"failed"`, or `"cancelled"`. Completed results carry `value`; failed and cancelled results carry `error`; cancelled results may also carry `cancelled: true`. A successful HTTP send is not itself durable acknowledgement. The worker retains the result until the server returns an acknowledgement disposition.

| Response | Meaning                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`    | Result durably resolved. Body is `{ "ok": true, "disposition": "applied" \| "duplicate" \| "dead-lettered" }`.                                                                                                                              |
| `400`    | Invalid JSON, missing required fields, unsupported status, malformed attempt token, or malformed result payload.                                                                                                                            |
| `403`    | Session authorization failed, or a correlated permanent rejection such as `"unknown-operation"`, `"stale-attempt"`, `"worker-mismatch"`, `"attempt-token-mismatch"`, `"queue-mismatch"`, `"revision-mismatch"`, or `"conflicting-content"`. |
| `409`    | The session generation is stale.                                                                                                                                                                                                            |
| `410`    | The session lease expired before the result was accepted.                                                                                                                                                                                   |
| `413`    | The result body or serialized activity result exceeds `maxRequestBodyBytes` or `payloadSize.maxBytes`.                                                                                                                                      |

A result transport failure never turns a completed activity into a failed activity. `LongPollWorker` keeps the already-produced result in its `LongPollResultDelivery` buffer, retries it with the same `(operationId, attemptToken)` identity, and only drops it on an acknowledged disposition or a correlated permanent rejection.

### Heartbeat and control

Session heartbeat and activity heartbeat are separate from each other and from the activity's absolute deadline. Session heartbeat keeps the accepted worker registration live; activity heartbeat renews only one in-flight attempt's visibility lease; an absolute activity deadline still caps execution.

```text
POST /api/v1/worker-sessions/:sessionId/heartbeat
Content-Type: application/json
Weft-Worker-Session-Token: <sessionToken>
```

An empty body is a session heartbeat. A body with `operationId` and `attemptToken` is an activity heartbeat and may include `details`.

```json
{
  "operationId": "activity-operation-id",
  "workerId": "session-id",
  "attemptToken": "per-claim-token",
  "details": { "done": 3 }
}
```

| Response | Meaning                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `200`    | Heartbeat accepted. Activity heartbeat responses include `cancelled`, optional `reason`, and optional `leaseDeadline`. |
| `400`    | Invalid JSON or malformed heartbeat fields.                                                                            |
| `403`    | Session authorization failed or the attempt identity is fenced out.                                                    |
| `404`    | Session is unknown.                                                                                                    |
| `409`    | The session generation is stale.                                                                                       |
| `410`    | The session lease expired before the heartbeat.                                                                        |
| `413`    | `details` exceeds `payloadSize.maxBytes`.                                                                              |

Long-poll has no server-to-worker push channel, so cancellation is returned on the activity heartbeat response. `LongPollWorker` aborts the matching `AbortController`, keyed by `(operationId, attemptToken)`, and reports `status: "cancelled"` on the next result for that same attempt.

### Unregister session

```text
DELETE /api/v1/worker-sessions/:sessionId
Weft-Worker-Session-Token: <sessionToken>
```

A graceful `stop()` unregisters the session after aborting local work and suspending result retries. Unregister removes the worker from live routing so it accepts no new tasks; already-produced, unacknowledged results remain in the local delivery buffer and are retried on the next `start()` after a new registration.

Aborting a poll before a task is claimed returns `204` and leaves queued work available for another poller. After a `200` response, the task is in flight until the worker posts a result or the visibility timeout/reconciliation path makes it available for another attempt.
