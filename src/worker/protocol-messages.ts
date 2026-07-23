/**
 * TypeScript wire-shape declarations for the RemoteWorker WebSocket protocol.
 *
 * These types mirror the JSON Schema documents in `./protocol-schemas.ts`
 * field-for-field. The runtime parser guards in `./protocol.ts` enforce the
 * shapes described here at the trust boundary. They are re-exported from
 * `@lostgradient/weft/worker-protocol` (via `./protocol.ts`) so the public surface remains
 * a single import path.
 *
 * @module worker/protocol-messages
 */

import type { RemoteWorkerProtocolVersion } from './protocol-version.ts';

/**
 * JSON value carried over the worker protocol.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerJsonValue } from '@lostgradient/weft/worker-protocol';
 *
 * const payload: RemoteWorkerJsonValue = { amount: 42, memo: null };
 * ```
 */
export type RemoteWorkerJsonValue =
  | null
  | boolean
  | number
  | string
  | RemoteWorkerJsonValue[]
  | { [key: string]: RemoteWorkerJsonValue };

/**
 * Optional capabilities advertised by a RemoteWorker at registration time.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerCapabilities } from '@lostgradient/weft/worker-protocol';
 *
 * const capabilities: RemoteWorkerCapabilities = { region: 'us-west', gpu: false };
 * ```
 */
export type RemoteWorkerCapabilities = Readonly<Record<string, RemoteWorkerJsonValue>>;

/**
 * Worker registration message sent immediately after opening a worker stream.
 *
 * Each entry of `activities` is a qualified `${workflowType}.${activityName}`
 * name; bare activity names were retired in protocol v2.
 *
 * @example
 * ```ts
 * import type { RegisterMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: RegisterMessage = {
 *   type: 'register',
 *   protocolVersion: 2,
 *   workerId: 'worker-1',
 *   activities: ['welcome.sendEmail'],
 * };
 * ```
 */
export type RegisterMessage = {
  readonly type: 'register';
  readonly protocolVersion: RemoteWorkerProtocolVersion;
  readonly workerId: string;
  readonly activities: readonly string[];
  readonly concurrency?: number;
  readonly queue?: string;
  readonly deploymentName?: string;
  readonly buildId?: string;
  readonly runtimeVersion?: string;
  readonly gitSha?: string;
  readonly startedAt?: number;
  readonly capabilities?: RemoteWorkerCapabilities;
};

/**
 * Worker heartbeat message.
 *
 * @example
 * ```ts
 * import type { HeartbeatMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: HeartbeatMessage = { type: 'heartbeat', workerId: 'worker-1' };
 * ```
 */
export type HeartbeatMessage = {
  readonly type: 'heartbeat';
  readonly workerId: string;
};

/**
 * Successful activity result message.
 *
 * @example
 * ```ts
 * import type { CompletedTaskResultMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: CompletedTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'completed',
 *   value: null,
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type CompletedTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'completed';
  readonly value: RemoteWorkerJsonValue;
  /** Required per-dispatch token echoed from the {@link TaskMessage}. */
  readonly attemptToken: string;
};

/**
 * Failed activity result message.
 *
 * @example
 * ```ts
 * import type { FailedTaskResultMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: FailedTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'failed',
 *   error: 'SMTP rejected the message',
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type FailedTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'failed';
  readonly error: string;
  /** Required per-dispatch token echoed from the {@link TaskMessage}. */
  readonly attemptToken: string;
};

/**
 * Cancelled activity result message.
 *
 * @example
 * ```ts
 * import type { CancelledTaskResultMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: CancelledTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'cancelled',
 *   error: 'Task cancelled',
 *   cancelled: true,
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type CancelledTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'cancelled';
  readonly error: string;
  readonly cancelled?: true;
  /** Required per-dispatch token echoed from the {@link TaskMessage}. */
  readonly attemptToken: string;
};

/**
 * Registration acknowledgement sent after a worker is accepted.
 *
 * @example
 * ```ts
 * import type { RegisterAckMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: RegisterAckMessage = {
 *   type: 'registerAck',
 *   protocolVersion: 2,
 *   workerId: 'worker-1',
 *   queue: 'default',
 *   activities: ['welcome.sendEmail'],
 *   concurrency: 10,
 * };
 * ```
 */
export type RegisterAckMessage = {
  readonly type: 'registerAck';
  readonly protocolVersion: RemoteWorkerProtocolVersion;
  readonly workerId: string;
  readonly queue: string;
  readonly activities: readonly string[];
  readonly concurrency: number;
};

/**
 * Registration rejection sent before closing an unsupported worker stream.
 *
 * @example
 * ```ts
 * import type { RegisterErrorMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: RegisterErrorMessage = {
 *   type: 'registerError',
 *   code: 'unsupported_protocol_version',
 *   message: 'Unsupported RemoteWorker protocol version: 1',
 *   supportedProtocolVersions: [2],
 *   requestedProtocolVersion: 1,
 * };
 * ```
 */
export type RegisterErrorMessage = {
  readonly type: 'registerError';
  readonly code: 'invalid_registration' | 'unsupported_protocol_version';
  readonly message: string;
  readonly supportedProtocolVersions: readonly RemoteWorkerProtocolVersion[];
  readonly requestedProtocolVersion?: number;
};

/**
 * Protocol-level error sent before closing a malformed worker stream.
 *
 * @example
 * ```ts
 * import type { ProtocolErrorMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: ProtocolErrorMessage = {
 *   type: 'protocolError',
 *   code: 'invalid_message',
 *   message: 'taskResult.operationId must be a non-empty string',
 * };
 * ```
 */
export type ProtocolErrorMessage = {
  readonly type: 'protocolError';
  readonly code:
    | 'invalid_json'
    | 'invalid_message'
    | 'unknown_message_type'
    | 'registration_required';
  readonly message: string;
};

/**
 * Activity task dispatched by the server.
 *
 * @example
 * ```ts
 * import type { TaskMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: TaskMessage = {
 *   type: 'task',
 *   operationId: 'op-1',
 *   activityName: 'sendEmail',
 *   input: { to: 'user@example.com' },
 *   attemptToken: '550e8400-e29b-41d4-a716-446655440000',
 * };
 * ```
 */
export type TaskMessage = {
  readonly type: 'task';
  readonly operationId: string;
  readonly activityName: string;
  readonly input: RemoteWorkerJsonValue;
  readonly attempt?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Durable token for the workflow run that launched this activity, when known. */
  readonly workflowExecutionToken?: string;
  /** Unique, unguessable token identifying this dispatch attempt. */
  readonly attemptToken: string;
};

/**
 * Activity cancellation request sent by the server.
 *
 * @example
 * ```ts
 * import type { CancelMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: CancelMessage = { type: 'cancel', operationId: 'op-1' };
 * ```
 */
export type CancelMessage = {
  readonly type: 'cancel';
  readonly operationId: string;
};

/**
 * Graceful worker shutdown request sent by the server.
 *
 * @example
 * ```ts
 * import type { ShutdownMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: ShutdownMessage = { type: 'shutdown' };
 * ```
 */
export type ShutdownMessage = {
  readonly type: 'shutdown';
};
