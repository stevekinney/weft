/**
 * Canonical RemoteWorker WebSocket protocol contract.
 *
 * This module owns the parser trust boundary: every guard below maps to one
 * documented schema field. Wire-shape types live in `./protocol-messages.ts`,
 * JSON Schema documents in `./protocol-schemas.ts`, the `taskResult` variant
 * parser in `./protocol-task-result.ts`, and internal helpers in
 * `./protocol-internals.ts`. All are re-exported so the public surface
 * `@lostgradient/weft/worker-protocol` stays a single import path.
 *
 * @module worker/protocol
 */

import type {
  FieldSpec,
  RemoteWorkerProtocolFailure,
  RemoteWorkerProtocolParseResult,
} from './protocol-internals.ts';
import {
  collectFields,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  isRemoteWorkerJsonValue,
  isStringArray,
  isStringRecord,
  protocolFailure,
} from './protocol-internals.ts';
import type {
  CancelMessage,
  CancelledTaskResultMessage,
  CompletedTaskResultMessage,
  FailedTaskResultMessage,
  HeartbeatMessage,
  ProtocolErrorMessage,
  RegisterAckMessage,
  RegisterErrorMessage,
  RegisterMessage,
  RemoteWorkerCapabilities,
  RemoteWorkerJsonValue,
  ShutdownMessage,
  TaskMessage,
} from './protocol-messages.ts';
import {
  REMOTE_WORKER_MESSAGE_SCHEMAS,
  REMOTE_WORKER_PROTOCOL_JSON_SCHEMA,
} from './protocol-schemas.ts';
import type { TaskResultMessage } from './protocol-task-result.ts';
import { parseTaskResultMessage } from './protocol-task-result.ts';
import type { RemoteWorkerProtocolVersion } from './protocol-version.ts';
import {
  REMOTE_WORKER_MAX_PROTOCOL_VERSION,
  REMOTE_WORKER_MIN_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol-version.ts';

export {
  REMOTE_WORKER_MAX_PROTOCOL_VERSION,
  REMOTE_WORKER_MESSAGE_SCHEMAS,
  REMOTE_WORKER_MIN_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTOCOL_JSON_SCHEMA,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  isRemoteWorkerJsonValue,
};
export type {
  CancelMessage,
  CancelledTaskResultMessage,
  CompletedTaskResultMessage,
  FailedTaskResultMessage,
  HeartbeatMessage,
  ProtocolErrorMessage,
  RegisterAckMessage,
  RegisterErrorMessage,
  RegisterMessage,
  RemoteWorkerCapabilities,
  RemoteWorkerJsonValue,
  RemoteWorkerProtocolFailure,
  RemoteWorkerProtocolParseResult,
  RemoteWorkerProtocolVersion,
  ShutdownMessage,
  TaskMessage,
  TaskResultMessage,
};

/**
 * Messages accepted from a worker stream client.
 *
 * @example
 * ```ts
 * import type { WorkerToServerMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: WorkerToServerMessage = { type: 'heartbeat', workerId: 'worker-1' };
 * ```
 */
export type WorkerToServerMessage = RegisterMessage | HeartbeatMessage | TaskResultMessage;

/**
 * Messages the server may send to a worker stream client.
 *
 * @example
 * ```ts
 * import type { ServerToWorkerMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: ServerToWorkerMessage = { type: 'shutdown' };
 * ```
 */
export type ServerToWorkerMessage =
  | RegisterAckMessage
  | RegisterErrorMessage
  | ProtocolErrorMessage
  | TaskMessage
  | CancelMessage
  | ShutdownMessage;

const WORKER_TO_SERVER_TYPES = new Set(['register', 'heartbeat', 'taskResult']);
const SERVER_TO_WORKER_TYPES = new Set([
  'registerAck',
  'registerError',
  'protocolError',
  'task',
  'cancel',
  'shutdown',
]);

// --- parseRegisterMessage ---------------------------------------------------

// `protocolVersion` carries `requestedProtocolVersion` on its failure path so
// it cannot be expressed by the generic FieldSpec helper.
function validateRegisterProtocolVersion(
  value: unknown,
): RemoteWorkerProtocolParseResult<RemoteWorkerProtocolVersion> {
  if (value === REMOTE_WORKER_PROTOCOL_VERSION) {
    return { ok: true, message: value };
  }
  const requestedProtocolVersion = isFiniteNumber(value) ? value : undefined;
  return protocolFailure(
    'unsupported_protocol_version',
    `Unsupported RemoteWorker protocol version: ${String(value)}`,
    requestedProtocolVersion,
  );
}

// Field specs mirror the documented schema fields one-to-one, in schema order.
// Reviewers can read this table top-to-bottom alongside the register schema.
// `manifest` is proven only as a JSON object here — deep manifest validation
// (parseWorkerManifest) runs where the manifest is accepted, not at this
// wire-shape trust boundary.
// prettier-ignore
const REGISTER_FIELD_SPECS: readonly FieldSpec[] = [
  ['workerId',    true,  isNonEmptyString, 'register.workerId must be a non-empty string'],
  ['manifest',    true,  isRecord,         'register.manifest must be a JSON object'],
  ['concurrency', false, isFiniteNumber,   'register.concurrency must be a finite number'],
  ['startedAt',   false, isFiniteNumber,   'register.startedAt must be a finite number when present'],
];

function parseRegisterMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<RegisterMessage> {
  const protocolVersion = validateRegisterProtocolVersion(record['protocolVersion']);
  if (!protocolVersion.ok) return protocolVersion;

  const fields = collectFields('invalid_registration', record, REGISTER_FIELD_SPECS);
  if (!fields.ok) return fields.error;

  // Each predicate narrows its value to the matching RegisterMessage field
  // type before collectFields stores it.
  return {
    ok: true,
    message: {
      type: 'register',
      protocolVersion: protocolVersion.message,
      ...fields.values,
    } as RegisterMessage,
  };
}

function parseHeartbeatMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<HeartbeatMessage> {
  const workerId = record['workerId'];
  if (!isNonEmptyString(workerId)) {
    return protocolFailure('invalid_message', 'heartbeat.workerId must be a non-empty string');
  }

  return { ok: true, message: { type: 'heartbeat', workerId } };
}

// --- parseTaskMessage -------------------------------------------------------

const TASK_FIELD_SPECS: readonly FieldSpec[] = [
  ['operationId', true, isNonEmptyString, 'task.operationId must be a non-empty string'],
  ['activityName', true, isNonEmptyString, 'task.activityName must be a non-empty string'],
  ['input', true, isRemoteWorkerJsonValue, 'task.input must be valid JSON'],
  ['attempt', false, isFiniteNumber, 'task.attempt must be a finite number'],
  ['headers', false, isStringRecord, 'task.headers must be a string map'],
  [
    'workflowExecutionToken',
    false,
    isNonEmptyString,
    'task.workflowExecutionToken must be a non-empty string',
  ],
  ['attemptToken', true, isNonEmptyString, 'task.attemptToken must be a non-empty string'],
];

function parseTaskMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<TaskMessage> {
  const fields = collectFields('invalid_message', record, TASK_FIELD_SPECS);
  if (!fields.ok) return fields.error;

  // Each predicate narrows its value to the matching TaskMessage field type
  // before collectFields stores it.
  return { ok: true, message: { type: 'task', ...fields.values } as TaskMessage };
}

function parseCancelMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<CancelMessage> {
  const operationId = record['operationId'];
  if (!isNonEmptyString(operationId)) {
    return protocolFailure('invalid_message', 'cancel.operationId must be a non-empty string');
  }

  return { ok: true, message: { type: 'cancel', operationId } };
}

function parseShutdownMessage(): RemoteWorkerProtocolParseResult<ShutdownMessage> {
  return { ok: true, message: { type: 'shutdown' } };
}

function parseRegisterAckMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<RegisterAckMessage> {
  const protocolVersion = record['protocolVersion'];
  if (protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    return protocolFailure(
      'invalid_message',
      `registerAck.protocolVersion must be ${String(REMOTE_WORKER_PROTOCOL_VERSION)}`,
    );
  }

  const workerId = record['workerId'];
  const queue = record['queue'];
  const concurrency = record['concurrency'];
  const acceptedManifestDigest = record['acceptedManifestDigest'];
  const serverCapabilities = record['serverCapabilities'];
  if (!isNonEmptyString(workerId)) {
    return protocolFailure('invalid_message', 'registerAck.workerId must be a non-empty string');
  }
  if (!isNonEmptyString(queue)) {
    return protocolFailure('invalid_message', 'registerAck.queue must be a non-empty string');
  }
  if (typeof concurrency !== 'number' || !Number.isFinite(concurrency)) {
    return protocolFailure('invalid_message', 'registerAck.concurrency must be a finite number');
  }
  if (!isNonEmptyString(acceptedManifestDigest)) {
    return protocolFailure(
      'invalid_message',
      'registerAck.acceptedManifestDigest must be a non-empty string',
    );
  }
  if (!isStringArray(serverCapabilities)) {
    return protocolFailure(
      'invalid_message',
      'registerAck.serverCapabilities must be an array of non-empty strings',
    );
  }

  return {
    ok: true,
    message: {
      type: 'registerAck',
      protocolVersion,
      workerId,
      queue,
      concurrency,
      acceptedManifestDigest,
      serverCapabilities,
    },
  };
}

function isRegisterErrorCode(value: unknown): value is RegisterErrorMessage['code'] {
  return (
    value === 'invalid_registration' ||
    value === 'unsupported_protocol_version' ||
    value === 'deployment_conflict' ||
    value === 'registration_rejected'
  );
}

function parseRegisterErrorMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<RegisterErrorMessage> {
  const code = record['code'];
  const message = record['message'];
  const supportedProtocolVersions = record['supportedProtocolVersions'];
  const requestedProtocolVersion = record['requestedProtocolVersion'];

  if (!isRegisterErrorCode(code)) {
    return protocolFailure('invalid_message', 'registerError.code is not recognized');
  }
  if (typeof message !== 'string') {
    return protocolFailure('invalid_message', 'registerError.message must be a string');
  }
  // supportedProtocolVersions describes the *other* peer's versions, not this
  // package's own — validated as any array of finite integers so a v3 client
  // can still parse a rejection from a v2 (or v17) server. Checking against
  // REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS here would make a mismatched
  // rejection unparseable, defeating the diagnostic the field exists for.
  if (
    !Array.isArray(supportedProtocolVersions) ||
    !supportedProtocolVersions.every((version) => isFiniteNumber(version))
  ) {
    return protocolFailure('invalid_message', 'registerError.supportedProtocolVersions is invalid');
  }
  if (requestedProtocolVersion !== undefined && !isFiniteNumber(requestedProtocolVersion)) {
    return protocolFailure(
      'invalid_message',
      'registerError.requestedProtocolVersion must be a finite number',
    );
  }

  const optional = requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {};
  return {
    ok: true,
    message: { type: 'registerError', code, message, supportedProtocolVersions, ...optional },
  };
}

function parseProtocolErrorMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<ProtocolErrorMessage> {
  const code = record['code'];
  const message = record['message'];
  if (
    code !== 'invalid_json' &&
    code !== 'invalid_message' &&
    code !== 'unknown_message_type' &&
    code !== 'registration_required'
  ) {
    return protocolFailure('invalid_message', 'protocolError.code is not recognized');
  }
  if (typeof message !== 'string') {
    return protocolFailure('invalid_message', 'protocolError.message must be a string');
  }

  return { ok: true, message: { type: 'protocolError', code, message } };
}

/**
 * Parse and validate a worker-to-server protocol message.
 * @example
 * ```ts
 * import { parseWorkerToServerMessage } from '@lostgradient/weft/worker-protocol';
 * const result = parseWorkerToServerMessage({ type: 'heartbeat', workerId: 'worker-1' });
 * ```
 */
export function parseWorkerToServerMessage(
  value: unknown,
): RemoteWorkerProtocolParseResult<WorkerToServerMessage> {
  if (!isRecord(value)) {
    return protocolFailure('invalid_message', 'Worker protocol message must be a JSON object');
  }

  const type = value['type'];
  if (typeof type !== 'string') {
    return protocolFailure('invalid_message', 'Worker protocol message.type must be a string');
  }
  if (!WORKER_TO_SERVER_TYPES.has(type)) {
    return protocolFailure('unknown_message_type', `Unknown worker message type: ${type}`);
  }

  switch (type) {
    case 'register':
      return parseRegisterMessage(value);
    case 'heartbeat':
      return parseHeartbeatMessage(value);
    case 'taskResult':
      return parseTaskResultMessage(value);
    default:
      return protocolFailure('unknown_message_type', `Unknown worker message type: ${type}`);
  }
}

/**
 * Parse and validate a server-to-worker protocol message.
 * @example
 * ```ts
 * import { parseServerToWorkerMessage } from '@lostgradient/weft/worker-protocol';
 * const result = parseServerToWorkerMessage({ type: 'shutdown' });
 * ```
 */
export function parseServerToWorkerMessage(
  value: unknown,
): RemoteWorkerProtocolParseResult<ServerToWorkerMessage> {
  if (!isRecord(value)) {
    return protocolFailure('invalid_message', 'Server protocol message must be a JSON object');
  }

  const type = value['type'];
  if (typeof type !== 'string') {
    return protocolFailure('invalid_message', 'Server protocol message.type must be a string');
  }
  if (!SERVER_TO_WORKER_TYPES.has(type)) {
    return protocolFailure('unknown_message_type', `Unknown server message type: ${type}`);
  }

  switch (type) {
    case 'registerAck':
      return parseRegisterAckMessage(value);
    case 'registerError':
      return parseRegisterErrorMessage(value);
    case 'protocolError':
      return parseProtocolErrorMessage(value);
    case 'task':
      return parseTaskMessage(value);
    case 'cancel':
      return parseCancelMessage(value);
    case 'shutdown':
      return parseShutdownMessage();
    default:
      return protocolFailure('unknown_message_type', `Unknown server message type: ${type}`);
  }
}
