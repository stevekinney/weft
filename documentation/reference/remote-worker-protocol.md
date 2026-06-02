# RemoteWorker Wire Protocol

This document describes the versioned WebSocket protocol Weft uses to dispatch activity tasks to remote workers. The built-in TypeScript `RemoteWorker` speaks this protocol, and non-TypeScript SDKs can validate against the exported JSON Schemas instead of reverse-engineering the source.

## At a glance

- **Protocol version**: v1. `register.protocolVersion` is required and must be exactly `1`.
- **Transport**: WebSocket text frames containing JSON objects.
- **Endpoint**: `/api/v1/tasks/:queue/stream` on the Weft server. Connect to one queue per WebSocket.
- **Direction**: bidirectional. Workers send `register`, `heartbeat`, `taskResult`. Server sends `task`, `cancel`, `shutdown`, `registerAck`, `registerError`, `protocolError`.
- **Heartbeat**: workers heartbeat every 10 seconds after registration is acknowledged.
- **Authentication**: not part of the protocol envelope. Auth happens at the WebSocket transport layer.
- **Fatal close codes**: unsupported or invalid registration receives `registerError`, then WebSocket close code `1008`. Malformed protocol frames receive `protocolError`, then WebSocket close code `1002`.

The public schema contract is exported from `@lostgradient/weft/worker-protocol`:

```ts
import {
  REMOTE_WORKER_PROTOCOL_JSON_SCHEMA,
  REMOTE_WORKER_MESSAGE_SCHEMAS,
  REMOTE_WORKER_PROTOCOL_VERSION,
} from '@lostgradient/weft/worker-protocol';
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
  |                                   |
  |--- heartbeat ------------------>  |   extends visibility for in-flight tasks
  |                                   |
  |   <---- cancel (operationId) --   |
  |--- taskResult ----------------->  |
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

Malformed JSON, malformed message shapes, worker-to-server message types not defined by v1, and `heartbeat` or `taskResult` before registration are fatal protocol errors:

```text
Worker                              Server
  |--- malformed frame ----------->   |
  |   <-------- protocolError -----   |
  |   <-------- close 1002 --------   |
```

The server tracks the worker by `workerId` in an in-memory registry. If a registered worker disconnects with tasks in flight, the server waits for the configured `ServeOptions.workerReconnectGracePeriodMs` before requeueing those tasks. A same-`workerId` `register` inside that grace window cancels the pending requeue and preserves the worker's in-flight assignments. If the window expires, the server reassigns the tasks to another available worker on the same queue or moves them through the fallback queue path according to the dispatch machinery.

## Message catalog

All messages are JSON objects with a `type` discriminator. Message schemas are available in `REMOTE_WORKER_MESSAGE_SCHEMAS`, and the full schema document is available in `REMOTE_WORKER_PROTOCOL_JSON_SCHEMA`.

Workers may ignore unknown server-to-worker message types for forward compatibility. Servers reject unknown worker-to-server message types with `protocolError` because worker messages cross the trust boundary.

### Worker -> Server

#### `register`

Sent immediately after the WebSocket opens.

```json
{
  "type": "register",
  "protocolVersion": 1,
  "workerId": "<string>",
  "activities": ["<activity-name>"],
  "concurrency": 10,
  "queue": "default",
  "deploymentName": "payments",
  "buildId": "2026-05-12.1",
  "runtimeVersion": "bun-1.3.13",
  "gitSha": "abc1234",
  "startedAt": 1778608949187,
  "capabilities": {
    "region": "us-west"
  }
}
```

| Field             | Type                         | Required | Description                                                                                     |
| ----------------- | ---------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `type`            | `"register"`                 | Yes      | Message discriminator.                                                                          |
| `protocolVersion` | `1`                          | Yes      | Required v1 protocol version. Missing or unsupported versions receive `registerError`.          |
| `workerId`        | string                       | Yes      | Stable identifier for this worker. Must be non-empty.                                           |
| `activities`      | string[]                     | Yes      | Names of activities this worker can execute. Entries must be non-empty strings.                 |
| `concurrency`     | number                       | No       | Maximum concurrent tasks. Server clamps finite numbers to `[1, 1000]`. Defaults to `10`.        |
| `queue`           | string                       | No       | Informational queue name. The server uses the queue derived from the worker-stream URL instead. |
| `deploymentName`  | string                       | No       | Operator-defined deployment group. Drain operations can target all workers with this name.      |
| `buildId`         | string                       | No       | Build or release identifier shown in fleet summaries.                                           |
| `runtimeVersion`  | string                       | No       | Runtime or SDK version reported by the worker.                                                  |
| `gitSha`          | string                       | No       | Source revision reported by the worker.                                                         |
| `startedAt`       | number                       | No       | Worker process start time in epoch milliseconds. Defaults to registration time when omitted.    |
| `capabilities`    | `Record<string, JSON value>` | No       | JSON object of capability metadata such as region, hardware class, or feature flags.            |

The server processes `register` only on worker-stream paths (`/api/v1/tasks/:queue/stream`). On other WebSocket endpoints, worker protocol messages are ignored or handled by that endpoint's own protocol.

#### `heartbeat`

Sent every 10 seconds after `registerAck`. It tells the server the worker is alive and extends the visibility timeout on in-flight tasks assigned to this connection.

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

#### `taskResult`

Sent when an in-flight task completes, fails, or is cancelled.

**Success:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "status": "completed",
  "value": null
}
```

**Failure:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "status": "failed",
  "error": "<message>"
}
```

**Cancellation:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "status": "cancelled",
  "cancelled": true,
  "error": "Task cancelled"
}
```

| Field         | Type                                     | Required                    | Description                                                           |
| ------------- | ---------------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `type`        | `"taskResult"`                           | Yes                         | Message discriminator.                                                |
| `operationId` | string                                   | Yes                         | The opaque `operationId` from the corresponding `task` message.       |
| `status`      | `"completed" \| "failed" \| "cancelled"` | Yes                         | Terminal outcome.                                                     |
| `value`       | any JSON value                           | Yes if `completed`          | Activity result. Use `null` when the activity has no value.           |
| `error`       | string                                   | Yes if `failed`/`cancelled` | Human-readable error message.                                         |
| `cancelled`   | `true`                                   | No                          | Optional marker for cancelled results. If present, it must be `true`. |

The server stores `completed` as a completed task and treats `failed` and `cancelled` as failed terminal resolutions. Missing `operationId`, missing `value` on completed results, unknown statuses, and non-string errors on failed or cancelled results are malformed messages. The server sends `protocolError` and closes the socket with `1002`.

For a well-formed result, the server also verifies that the WebSocket connection still owns the `operationId`. A stale completion from a displaced worker receives `protocolError` and is ignored instead of mutating engine state. In v1 this guard is keyed by `(operationId, workerId)`, so it protects different-worker takeovers; defending same-`workerId` stale completions requires a future protocol revision with an attempt token on the wire.

### Server -> Worker

#### `task`

Dispatched when the server has work for this worker.

```json
{
  "type": "task",
  "operationId": "<string>",
  "activityName": "<string>",
  "input": null,
  "attempt": 1,
  "headers": { "<key>": "<value>" }
}
```

| Field          | Type                     | Required | Description                                                                 |
| -------------- | ------------------------ | -------- | --------------------------------------------------------------------------- |
| `type`         | `"task"`                 | Yes      | Message discriminator.                                                      |
| `operationId`  | string                   | Yes      | Unique task identifier the worker echoes back in `taskResult`.              |
| `activityName` | string                   | Yes      | Name of the activity to execute. Must be in the worker's `activities` list. |
| `input`        | any JSON value           | Yes      | Activity input. `null` is used when the dispatch input is undefined.        |
| `attempt`      | number                   | No       | Retry counter. Present on retries.                                          |
| `headers`      | `Record<string, string>` | No       | Interceptor-propagated headers from the dispatch path.                      |

If the worker does not recognize `activityName`, it should send `taskResult` with `status: "failed"` and an explanatory `error`.

#### `cancel`

Server requests cancellation of an in-flight task.

```json
{
  "type": "cancel",
  "operationId": "<string>"
}
```

| Field         | Type       | Required | Description                                 |
| ------------- | ---------- | -------- | ------------------------------------------- |
| `type`        | `"cancel"` | Yes      | Message discriminator.                      |
| `operationId` | string     | Yes      | The in-flight task the worker should abort. |

Workers should signal cancellation to the activity, usually by aborting an `AbortSignal`, and then report the terminal outcome with `taskResult`.

#### `shutdown`

Server requests graceful shutdown of the worker.

```json
{
  "type": "shutdown"
}
```

The TypeScript implementation sets a `shuttingDown` flag, refuses new `task` messages, stops heartbeats, drains in-flight tasks up to `disconnectTimeoutMs`, aborts anything still running after the deadline, and closes the WebSocket.

#### `registerAck`

Server acknowledgement that registration succeeded.

```json
{
  "type": "registerAck",
  "protocolVersion": 1,
  "workerId": "<string>",
  "queue": "default",
  "activities": ["<activity-name>"],
  "concurrency": 10
}
```

| Field             | Type            | Required | Description                                                            |
| ----------------- | --------------- | -------- | ---------------------------------------------------------------------- |
| `type`            | `"registerAck"` | Yes      | Message discriminator.                                                 |
| `protocolVersion` | `1`             | Yes      | Effective protocol version.                                            |
| `workerId`        | string          | Yes      | Accepted worker identifier.                                            |
| `queue`           | string          | Yes      | Effective queue from the WebSocket URL.                                |
| `activities`      | string[]        | Yes      | Accepted activity names.                                               |
| `concurrency`     | number          | Yes      | Effective concurrency after server clamping to the supported capacity. |

Workers should not start heartbeats or report `connect()` success until this message arrives.

#### `registerError`

Server rejection of registration. The server sends this message, then closes the WebSocket with close code `1008`.

```json
{
  "type": "registerError",
  "code": "unsupported_protocol_version",
  "message": "Unsupported RemoteWorker protocol version: 2",
  "supportedProtocolVersions": [1],
  "requestedProtocolVersion": 2
}
```

| Field                       | Type                                                       | Required | Description                                                |
| --------------------------- | ---------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| `type`                      | `"registerError"`                                          | Yes      | Message discriminator.                                     |
| `code`                      | `"invalid_registration" \| "unsupported_protocol_version"` | Yes      | Machine-readable registration failure.                     |
| `message`                   | string                                                     | Yes      | Human-readable diagnostic.                                 |
| `supportedProtocolVersions` | number[]                                                   | Yes      | Supported protocol versions. For v1 this is exactly `[1]`. |
| `requestedProtocolVersion`  | number                                                     | No       | Version sent by the worker when it was a finite number.    |

#### `protocolError`

Server rejection of a malformed worker-to-server frame after the WebSocket is open. The server sends this message, then closes the WebSocket with close code `1002`.

```json
{
  "type": "protocolError",
  "code": "invalid_message",
  "message": "taskResult.operationId must be a non-empty string"
}
```

| Field     | Type                                                                                       | Required | Description                        |
| --------- | ------------------------------------------------------------------------------------------ | -------- | ---------------------------------- |
| `type`    | `"protocolError"`                                                                          | Yes      | Message discriminator.             |
| `code`    | `"invalid_json" \| "invalid_message" \| "unknown_message_type" \| "registration_required"` | Yes      | Machine-readable protocol failure. |
| `message` | string                                                                                     | Yes      | Human-readable diagnostic.         |

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
| `WEFT_WORKER_PROTOCOL_VERSION` | Current protocol version, `1`.                   |

The conformance runner verifies registration acknowledgement, echo task completion, heartbeat-preserved work, cancellation, in-flight reassignment after disconnect, graceful shutdown, and failure of a deliberately broken worker fixture. `--json` returns a stable machine-readable report. Without `--json`, each check prints as `PASS` or `FAIL`.
