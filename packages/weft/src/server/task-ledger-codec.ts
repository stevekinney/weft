/**
 * Type guards and encode/decode for the durable remote task ledger (WFT-25).
 *
 * Every stored or wire-derived field is proven from `unknown` — the project
 * brief's Security section requires operation IDs, workflow IDs, names,
 * queues, header counts, header bytes, retry fields, and payload sizes to be
 * bounded before a storage write, and `input`/`headers` are treated as
 * hostile the same way `worker/manifest/parse.ts` treats manifest content.
 *
 * Guards here intentionally check only the fields that are load-bearing for
 * correctness and the fields the brief calls out for bounding — matching the
 * existing `isQueuedRecord`/`isInflightRecord` style in `task-state.ts`
 * rather than re-deriving every field's shape from the type system.
 *
 * @module server/task-ledger-codec
 */

import { decode, encode } from '../core/codec.ts';
import { isJSONValue } from '../core/json.ts';
import type { WorkerExecutionIdentity } from '../worker/manifest/types.ts';
import {
  MAX_TASK_HEADER_COUNT,
  MAX_TASK_HEADER_VALUE_BYTES,
  MAX_TASK_IDENTIFIER_BYTES,
  MAX_TASK_REASON_BYTES,
  MAX_TASK_RESULT_DIGEST_BYTES,
  utf8ByteLength,
} from './task-ledger-limits.ts';
import type {
  RemoteTaskBase,
  RemoteTaskCancelling,
  RemoteTaskCompleting,
  RemoteTaskDeadLettered,
  RemoteTaskLeased,
  RemoteTaskQueued,
  RemoteTaskRecord,
  RemoteTaskTerminal,
  RemoteTaskTerminalCancelled,
  RemoteTaskTerminalResolved,
  RemoteTaskTerminalRetryExhausted,
  WorkerExecutionRequirementInput,
} from './task-ledger-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(
  value: unknown,
  maxBytes = MAX_TASK_IDENTIFIER_BYTES,
): value is string {
  return typeof value === 'string' && value.length > 0 && utf8ByteLength(value) <= maxBytes;
}

function isBoundedOptionalIdentifier(
  value: unknown,
  maxBytes = MAX_TASK_IDENTIFIER_BYTES,
): boolean {
  return value === undefined || isBoundedIdentifier(value, maxBytes);
}

function isBoundedReason(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && utf8ByteLength(value) <= MAX_TASK_REASON_BYTES
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalBoundedReason(value: unknown): boolean {
  return value === undefined || isBoundedReason(value);
}

function isCompletedOrFailedStatus(value: unknown): value is 'completed' | 'failed' {
  return value === 'completed' || value === 'failed';
}

function isOptionalJSONValue(value: unknown): boolean {
  return value === undefined || isJSONValue(value);
}

function isDurationLike(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'string';
}

/** Bounded header map: at most {@link MAX_TASK_HEADER_COUNT} entries, each key/value at most {@link MAX_TASK_HEADER_VALUE_BYTES}. */
export function isValidTaskHeaders(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_TASK_HEADER_COUNT) return false;
  return entries.every(
    ([key, headerValue]) =>
      utf8ByteLength(key) <= MAX_TASK_HEADER_VALUE_BYTES &&
      typeof headerValue === 'string' &&
      utf8ByteLength(headerValue) <= MAX_TASK_HEADER_VALUE_BYTES,
  );
}

function isValidNonRetryableErrors(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function isValidRetryPolicy(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value['maxAttempts']) &&
    isDurationLike(value['initialBackoff']) &&
    isFiniteNumber(value['backoffMultiplier']) &&
    isDurationLike(value['maxBackoff']) &&
    isValidNonRetryableErrors(value['nonRetryableErrors'])
  );
}

function isValidExecutionRequirement(value: unknown): value is WorkerExecutionRequirementInput {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isBoundedOptionalIdentifier(value['deploymentName']) &&
    isBoundedOptionalIdentifier(value['buildId']) &&
    isBoundedOptionalIdentifier(value['artifactDigest']) &&
    isBoundedOptionalIdentifier(value['workflowRevision']) &&
    isBoundedOptionalIdentifier(value['activityContractHash'])
  );
}

const EXECUTION_IDENTITY_STRING_FIELDS = [
  'workerId',
  'manifestDigest',
  'sdkVersion',
  'runtimeName',
  'runtimeVersion',
  'deploymentName',
  'buildId',
  'artifactDigest',
  'workflowType',
  'workflowRevision',
  'activityName',
  'activityContractHash',
] as const satisfies readonly (keyof WorkerExecutionIdentity)[];

function isValidExecutionIdentity(value: unknown): value is WorkerExecutionIdentity {
  if (!isRecord(value)) return false;
  return (
    EXECUTION_IDENTITY_STRING_FIELDS.every((field) => isBoundedIdentifier(value[field])) &&
    isFiniteNumber(value['protocolVersion'])
  );
}

function isOptionalExecutionIdentity(value: unknown): boolean {
  return value === undefined || isValidExecutionIdentity(value);
}

/** Validates the identity-shaped subset of {@link RemoteTaskBase}. */
function isValidTaskIdentityFields(value: Record<string, unknown>): boolean {
  return (
    value['recordVersion'] === 1 &&
    isBoundedIdentifier(value['operationId']) &&
    isBoundedOptionalIdentifier(value['workflowId']) &&
    isBoundedIdentifier(value['workflowType']) &&
    isBoundedOptionalIdentifier(value['workflowExecutionToken']) &&
    isBoundedIdentifier(value['activityName']) &&
    isBoundedIdentifier(value['queue'])
  );
}

/** Validates the routing-shaped subset of {@link RemoteTaskBase}. */
function isValidTaskRoutingFields(value: Record<string, unknown>): boolean {
  return (
    isOptionalFiniteNumber(value['priority']) &&
    isBoundedOptionalIdentifier(value['fairShareKey']) &&
    isBoundedOptionalIdentifier(value['stickyWorkflowId']) &&
    isValidExecutionRequirement(value['executionRequirement'])
  );
}

/** Validates the payload/policy-shaped subset of {@link RemoteTaskBase}. */
function isValidTaskPayloadFields(value: Record<string, unknown>): boolean {
  return (
    isJSONValue(value['input']) &&
    isValidTaskHeaders(value['headers']) &&
    isValidTaskRoutingFields(value) &&
    isFiniteNumber(value['visibilityTimeoutMilliseconds']) &&
    isValidRetryPolicy(value['retryPolicy']) &&
    isOptionalFiniteNumber(value['scheduleToCloseDeadline']) &&
    isFiniteNumber(value['createdAt']) &&
    isFiniteNumber(value['generation'])
  );
}

/** Validate the fields common to every {@link RemoteTaskRecord} state. */
function isValidTaskBase(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RemoteTaskBase {
  return isValidTaskIdentityFields(value) && isValidTaskPayloadFields(value);
}

/** `RemoteTaskAttemptFields` — retry/requeue provenance shared by every non-terminal state. */
function isValidAttemptFields(value: Record<string, unknown>): boolean {
  return (
    isFiniteNumber(value['retryCount']) &&
    isFiniteNumber(value['requeueCount']) &&
    (value['lastRequeueReason'] === undefined || isBoundedReason(value['lastRequeueReason']))
  );
}

/** Fields shared by `leased`, `completing`, and `cancelling` — every state where a worker holds a lease. */
function isValidLeaseHolderShape(value: Record<string, unknown>): boolean {
  return (
    isValidAttemptFields(value) &&
    isBoundedIdentifier(value['attemptToken']) &&
    isBoundedIdentifier(value['workerSessionId']) &&
    isOptionalExecutionIdentity(value['executionIdentity']) &&
    isFiniteNumber(value['attempt']) &&
    isFiniteNumber(value['leaseDeadline']) &&
    isFiniteNumber(value['firstQueuedAt']) &&
    isFiniteNumber(value['lastQueuedAt']) &&
    isFiniteNumber(value['startedAt']) &&
    isFiniteNumber(value['lastHeartbeatAt'])
  );
}

function isValidQueuedTimingFields(value: Record<string, unknown>): boolean {
  return (
    isFiniteNumber(value['attempt']) &&
    isFiniteNumber(value['availableAt']) &&
    isFiniteNumber(value['firstQueuedAt']) &&
    isFiniteNumber(value['lastQueuedAt']) &&
    isOptionalFiniteNumber(value['lastDispatchedAt']) &&
    isOptionalFiniteNumber(value['startedAt'])
  );
}

export function isRemoteTaskQueued(value: unknown): value is RemoteTaskQueued {
  if (!isRecord(value) || value['state'] !== 'queued') return false;
  return isValidTaskBase(value) && isValidAttemptFields(value) && isValidQueuedTimingFields(value);
}

export function isRemoteTaskLeased(value: unknown): value is RemoteTaskLeased {
  if (!isRecord(value) || value['state'] !== 'leased' || !isValidTaskBase(value)) return false;
  return isValidLeaseHolderShape(value);
}

export function isRemoteTaskCompleting(value: unknown): value is RemoteTaskCompleting {
  if (!isRecord(value) || value['state'] !== 'completing') return false;
  return (
    isValidTaskBase(value) &&
    isValidLeaseHolderShape(value) &&
    isCompletedOrFailedStatus(value['pendingStatus']) &&
    isBoundedIdentifier(value['pendingResultDigest'])
  );
}

export function isRemoteTaskCancelling(value: unknown): value is RemoteTaskCancelling {
  if (!isRecord(value) || value['state'] !== 'cancelling' || !isValidTaskBase(value)) return false;
  return (
    isValidLeaseHolderShape(value) &&
    isBoundedReason(value['cancellationReason']) &&
    isFiniteNumber(value['cancellationRequestedAt'])
  );
}

function isValidTerminalCommon(value: Record<string, unknown>): boolean {
  return (
    isFiniteNumber(value['attempt']) &&
    isBoundedIdentifier(value['resultDigest'], MAX_TASK_RESULT_DIGEST_BYTES) &&
    isFiniteNumber(value['terminalAt']) &&
    typeof value['adopted'] === 'boolean' &&
    isOptionalFiniteNumber(value['adoptedAt']) &&
    isFiniteNumber(value['retentionGeneration'])
  );
}

function isTerminalDisposition(value: Record<string, unknown>, disposition: string): boolean {
  return value['state'] === 'terminal' && value['disposition'] === disposition;
}

export function isRemoteTaskTerminalResolved(value: unknown): value is RemoteTaskTerminalResolved {
  if (!isRecord(value) || !isTerminalDisposition(value, 'resolved')) return false;
  if (!isValidTaskBase(value) || !isValidTerminalCommon(value)) return false;
  return (
    isBoundedIdentifier(value['attemptToken']) &&
    isCompletedOrFailedStatus(value['status']) &&
    isOptionalBoundedReason(value['error'])
  );
}

export function isRemoteTaskTerminalCancelled(
  value: unknown,
): value is RemoteTaskTerminalCancelled {
  if (!isRecord(value) || !isTerminalDisposition(value, 'cancelled')) return false;
  if (!isValidTaskBase(value) || !isValidTerminalCommon(value)) return false;
  return (
    isBoundedOptionalIdentifier(value['attemptToken']) &&
    isBoundedReason(value['cancellationReason'])
  );
}

export function isRemoteTaskTerminalRetryExhausted(
  value: unknown,
): value is RemoteTaskTerminalRetryExhausted {
  if (!isRecord(value) || !isTerminalDisposition(value, 'retryExhausted')) return false;
  if (!isValidTaskBase(value) || !isValidTerminalCommon(value)) return false;
  return isBoundedIdentifier(value['attemptToken']) && isBoundedReason(value['error']);
}

export function isRemoteTaskTerminal(value: unknown): value is RemoteTaskTerminal {
  return (
    isRemoteTaskTerminalResolved(value) ||
    isRemoteTaskTerminalCancelled(value) ||
    isRemoteTaskTerminalRetryExhausted(value)
  );
}

function isValidDeadLetteredResultFields(value: Record<string, unknown>): boolean {
  return (
    isBoundedIdentifier(value['attemptToken']) &&
    isFiniteNumber(value['attempt']) &&
    isCompletedOrFailedStatus(value['pendingStatus']) &&
    isBoundedIdentifier(value['pendingResultDigest']) &&
    isOptionalJSONValue(value['value']) &&
    isOptionalBoundedReason(value['error'])
  );
}

export function isRemoteTaskDeadLettered(value: unknown): value is RemoteTaskDeadLettered {
  if (!isRecord(value) || value['state'] !== 'deadLettered') return false;
  return (
    isValidTaskBase(value) &&
    isValidAttemptFields(value) &&
    isValidDeadLetteredResultFields(value) &&
    isFiniteNumber(value['deadLetteredAt']) &&
    isBoundedReason(value['persistenceFailureReason'])
  );
}

/** Discriminate and validate a decoded value as any {@link RemoteTaskRecord} state. */
export function isRemoteTaskRecord(value: unknown): value is RemoteTaskRecord {
  if (!isRecord(value) || typeof value['state'] !== 'string') return false;
  switch (value['state']) {
    case 'queued':
      return isRemoteTaskQueued(value);
    case 'leased':
      return isRemoteTaskLeased(value);
    case 'completing':
      return isRemoteTaskCompleting(value);
    case 'cancelling':
      return isRemoteTaskCancelling(value);
    case 'terminal':
      return isRemoteTaskTerminal(value);
    case 'deadLettered':
      return isRemoteTaskDeadLettered(value);
    default:
      return false;
  }
}

/** Canonical encoding for a validated {@link RemoteTaskRecord}. */
export function encodeRemoteTaskRecord(record: RemoteTaskRecord): Uint8Array {
  return encode(record);
}

/**
 * Decode and validate a task ledger record. Returns `null` when the bytes are
 * absent or decode to a value that fails bounds validation. This does not
 * catch `decode()` throwing on bytes that are not valid MessagePack; storage
 * bytes are always ones this codebase wrote, so byte-level corruption is
 * treated as a storage integrity failure worth surfacing, not swallowing.
 */
export function decodeRemoteTaskRecord(bytes: Uint8Array | null): RemoteTaskRecord | null {
  if (bytes === null) return null;
  const decoded: unknown = decode(bytes);
  return isRemoteTaskRecord(decoded) ? decoded : null;
}
