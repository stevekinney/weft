import { copyBytesToArrayBuffer } from './byte-arrays.ts';
import { encode, validateCloneable } from './codec.ts';
import type { ContextOperationRequest } from './context.ts';
import type { FailureCategory, OperationRequest, WorkerOutboundMessage } from './types.ts';
import {
  WORKER_REPLAY_SIGNATURE_FORMAT,
  type WorkerReplayOperationSignature,
} from './types/checkpoint.ts';

export {
  WORKER_REPLAY_SIGNATURE_FORMAT,
  type WorkerReplayOperationSignature,
} from './types/checkpoint.ts';

export const WORKER_PROTOCOL_VERSION = 1;
export const DEFAULT_WORKER_TURN_TIMEOUT_MS = 1_000;
export const DEFAULT_WORKER_PROTOCOL_MESSAGE_BYTES = 1_048_576;
export const MIN_WORKER_PROTOCOL_MESSAGE_BYTES = 4_096;

const BINARY_MARKER = '__weftBinaryBytes';
const DATE_MARKER = '__weftDate';
const ERROR_MARKER = '__weftError';
const MAP_MARKER = '__weftMap';
const SET_MARKER = '__weftSet';
const MAX_BOUNDED_ERROR_LENGTH = 512;
const WORKER_SIGNATURE_EXCLUDED_FIELDS = new Set([
  'attempt',
  'callerStack',
  'execute',
  'fn',
  'id',
  'operationId',
  'resumedCacheEntry',
  'scheduledFireAt',
  'scheduledAt',
  'workflowId',
]);
const WORKER_SIGNATURE_OPERATION_TYPES = new Set<string>([
  'activity',
  'archive',
  'child-workflow',
  'get-version',
  'load',
  'memo',
  'offload',
  'parallel',
  'race',
  'run-all',
  'signal-wait',
  'sleep',
  'speculate',
  'state-commit',
  'state-read',
  'stream',
  'timer',
  'wait-review',
  'wait-signal',
  'wait-update',
] satisfies Array<ContextOperationRequest['type'] | OperationRequest['kind']>);

export class WorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerProtocolError';
  }
}

export class WorkerProtocolMessageSizeError extends WorkerProtocolError {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`Worker protocol message is ${actualBytes} bytes, exceeding limit ${maxBytes}`);
  }
}

export function createBoundedWorkerFailureMessage(parameters: {
  workflowId: string;
  error: string;
  failureCategory: FailureCategory;
  turnId?: number;
}): WorkerOutboundMessage {
  return {
    type: 'failed',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    ...(parameters.turnId === undefined ? {} : { turnId: parameters.turnId }),
    workflowId: parameters.workflowId,
    error: truncateForProtocol(parameters.error),
    failureCategory: parameters.failureCategory,
  };
}

export function estimateWorkerProtocolMessageBytes(message: unknown): number {
  let binaryBytes = 0;
  const encodedEnvelope = encode(
    toEncodedEnvelope(message, [], (bytes) => {
      binaryBytes += bytes;
    }),
  );
  return encodedEnvelope.byteLength + binaryBytes;
}

export function assertWorkerProtocolMessageWithinLimit(
  message: unknown,
  maxBytes: number | undefined,
): number {
  const actualBytes = estimateWorkerProtocolMessageBytes(message);
  if (maxBytes !== undefined && actualBytes > maxBytes) {
    throw new WorkerProtocolMessageSizeError(actualBytes, maxBytes);
  }
  return actualBytes;
}

export function assertWorkerOutboundMessageShape(
  message: unknown,
): asserts message is WorkerOutboundMessage {
  const record = assertWorkerOutboundRecord(message);
  assertWorkerOutboundCommonFields(record);
  assertWorkerOutboundVariant(record);
}

function assertWorkerOutboundRecord(message: unknown): Record<string, unknown> {
  if (typeof message !== 'object' || message === null) {
    throw new WorkerProtocolError('Worker outbound message must be an object');
  }
  return message as Record<string, unknown>;
}

function assertWorkerOutboundCommonFields(record: Record<string, unknown>): void {
  if (typeof record['workflowId'] !== 'string') {
    throw new WorkerProtocolError('Worker outbound message must include workflowId');
  }
  assertOptionalIntegerField(record, 'protocolVersion');
  assertOptionalIntegerField(record, 'turnId');
}

function assertOptionalIntegerField(record: Record<string, unknown>, field: string): void {
  if (record[field] !== undefined && !Number.isSafeInteger(record[field])) {
    throw new WorkerProtocolError(`Worker outbound message ${field} must be an integer`);
  }
}

function assertWorkerOutboundVariant(record: Record<string, unknown>): void {
  switch (record['type']) {
    case 'checkpoint':
      assertWorkerCheckpointOutbound(record);
      return;
    case 'completed':
      return;
    case 'failed':
      assertWorkerFailedOutbound(record);
      return;
    default:
      throw new WorkerProtocolError('Worker outbound message has an unsupported type');
  }
}

function assertWorkerCheckpointOutbound(record: Record<string, unknown>): void {
  if (!(record['checkpoint'] instanceof ArrayBuffer)) {
    throw new WorkerProtocolError('Worker checkpoint message must include checkpoint bytes');
  }
  if (typeof record['operationRequest'] !== 'object' || record['operationRequest'] === null) {
    throw new WorkerProtocolError('Worker checkpoint message must include operationRequest');
  }
}

function assertWorkerFailedOutbound(record: Record<string, unknown>): void {
  if (typeof record['error'] !== 'string') {
    throw new WorkerProtocolError('Worker failed message must include an error string');
  }
}

export async function createWorkerReplayOperationSignature(
  operation: OperationRequest | ContextOperationRequest,
  maxStableFieldsBytes: number,
): Promise<WorkerReplayOperationSignature> {
  const operationType = workerOperationType(operation);
  const stableFields = stableWorkerOperationFields(operation, operationType);
  const encodedStableFields = encode(stableFields);
  if (encodedStableFields.byteLength > maxStableFieldsBytes) {
    throw new WorkerProtocolError(
      `Worker replay signature input is ${encodedStableFields.byteLength} bytes, exceeding limit ${maxStableFieldsBytes}`,
    );
  }

  const digestBytes = await crypto.subtle.digest(
    'SHA-256',
    copyBytesToArrayBuffer(encodedStableFields),
  );
  return {
    format: WORKER_REPLAY_SIGNATURE_FORMAT,
    operationType,
    stableFieldsDigest: bytesToHex(new Uint8Array(digestBytes)),
    stableFieldsByteLength: encodedStableFields.byteLength,
  };
}

export function workerReplayOperationSignaturesEqual(
  left: WorkerReplayOperationSignature,
  right: WorkerReplayOperationSignature,
): boolean {
  return (
    left.format === right.format &&
    left.operationType === right.operationType &&
    left.stableFieldsDigest === right.stableFieldsDigest &&
    left.stableFieldsByteLength === right.stableFieldsByteLength
  );
}

function truncateForProtocol(value: string): string {
  if (value.length <= MAX_BOUNDED_ERROR_LENGTH) return value;
  return `${value.slice(0, MAX_BOUNDED_ERROR_LENGTH)}...`;
}

function workerOperationType(operation: OperationRequest | ContextOperationRequest): string {
  const record = operation as Record<string, unknown>;
  const type = record['type'];
  if (typeof type === 'string') return type;
  const kind = record['kind'];
  if (typeof kind === 'string') return kind;
  throw new WorkerProtocolError('Worker operation has no type or kind');
}

function stableWorkerOperationFields(
  operation: OperationRequest | ContextOperationRequest,
  operationType: string,
): Record<string, unknown> {
  if (!isSupportedWorkerOperationType(operationType)) {
    throw new WorkerProtocolError(`Unsupported Worker replay operation type: ${operationType}`);
  }

  return toSortedStableRecord(operation as Record<string, unknown>);
}

function isSupportedWorkerOperationType(operationType: string): boolean {
  return WORKER_SIGNATURE_OPERATION_TYPES.has(operationType);
}

function toSortedStableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    if (WORKER_SIGNATURE_EXCLUDED_FIELDS.has(key)) continue;
    if (record['type'] === 'run-all' && key === 'branches') {
      stable[key] = toStableRunAllBranches(record[key], []);
      continue;
    }
    stable[key] = toSignatureValue(record[key], []);
  }
  return stable;
}

function toStableRunAllBranches(value: unknown, stack: object[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return toSignatureValue(value, stack);
  }
  if (stack.includes(value)) {
    throw new WorkerProtocolError('Worker replay signature cannot include cyclic values');
  }

  stack.push(value);
  try {
    const stableBranches: Record<string, unknown> = {};
    const branches = value as Record<string, unknown>;
    for (const branchName of Object.keys(branches).toSorted()) {
      stableBranches[branchName] = toStableRunAllBranch(branches[branchName], stack);
    }
    return stableBranches;
  } finally {
    stack.pop();
  }
}

function toStableRunAllBranch(branch: unknown, stack: object[]): unknown {
  if (!Array.isArray(branch)) {
    return toSignatureValue(branch, stack);
  }

  const stableBranch: Record<string, unknown> = {
    arity: branch.length,
  };
  if (branch.length > 1) {
    stableBranch['input'] = toSignatureValue(branch[1], stack);
  }
  return stableBranch;
}

function toSignatureValue(value: unknown, stack: object[]): unknown {
  const specialValue = toSignatureSpecialValue(value, stack);
  if (specialValue.handled) return specialValue.value;
  if (stack.includes(value as object)) {
    throw new WorkerProtocolError('Worker replay signature cannot include cyclic values');
  }

  stack.push(value as object);
  try {
    return toSortedStableRecord(value as Record<string, unknown>);
  } finally {
    stack.pop();
  }
}

function toSignatureSpecialValue(
  value: unknown,
  stack: object[],
): { handled: true; value: unknown } | { handled: false } {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new WorkerProtocolError('Worker replay signature cannot include functions or symbols');
  }
  const binaryValue = toSignatureBinaryValue(value);
  if (binaryValue.handled) return binaryValue;
  const objectValue = toSignatureKnownObjectValue(value, stack);
  if (objectValue.handled) return objectValue;
  if (Array.isArray(value)) {
    return { handled: true, value: value.map((entry) => toSignatureValue(entry, stack)) };
  }
  if (typeof value !== 'object' || value === null) {
    return { handled: true, value };
  }
  return { handled: false };
}

function toSignatureBinaryValue(
  value: unknown,
): { handled: true; value: unknown } | { handled: false } {
  if (value instanceof ArrayBuffer) {
    return { handled: true, value: { [BINARY_MARKER]: bytesToHex(new Uint8Array(value)) } };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      handled: true,
      value: {
        [BINARY_MARKER]: bytesToHex(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      },
    };
  }
  return { handled: false };
}

function toSignatureKnownObjectValue(
  value: unknown,
  stack: object[],
): { handled: true; value: unknown } | { handled: false } {
  if (value instanceof Date) {
    return { handled: true, value: { [DATE_MARKER]: value.toISOString() } };
  }
  if (value instanceof Error) {
    return {
      handled: true,
      value: { [ERROR_MARKER]: { name: value.name, message: value.message } },
    };
  }
  if (value instanceof Map) {
    return {
      handled: true,
      value: {
        [MAP_MARKER]: [...value.entries()].map(([key, entryValue]) => [
          toSignatureValue(key, stack),
          toSignatureValue(entryValue, stack),
        ]),
      },
    };
  }
  if (value instanceof Set) {
    return {
      handled: true,
      value: { [SET_MARKER]: [...value.values()].map((entry) => toSignatureValue(entry, stack)) },
    };
  }
  return { handled: false };
}

function toEncodedEnvelope(
  value: unknown,
  stack: object[],
  recordBinaryBytes: (bytes: number) => void,
): unknown {
  const specialValue = toEncodedSpecialValue(value, stack, recordBinaryBytes);
  if (specialValue.handled) return specialValue.value;
  if (stack.includes(value as object)) {
    throw new WorkerProtocolError('Worker protocol message cannot include cyclic values');
  }

  const cloneable = validateCloneable(value);
  if (!cloneable.valid) {
    throw new WorkerProtocolError('Worker protocol message contains non-cloneable values');
  }

  return toEncodedObjectEnvelope(value as Record<string, unknown>, stack, recordBinaryBytes);
}

function toEncodedSpecialValue(
  value: unknown,
  stack: object[],
  recordBinaryBytes: (bytes: number) => void,
): { handled: true; value: unknown } | { handled: false } {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new WorkerProtocolError('Worker protocol message cannot include functions or symbols');
  }
  const binaryValue = toEncodedBinaryValue(value, recordBinaryBytes);
  if (binaryValue.handled) return binaryValue;
  const objectValue = toEncodedKnownObjectValue(value, stack, recordBinaryBytes);
  if (objectValue.handled) return objectValue;
  if (Array.isArray(value)) {
    return {
      handled: true,
      value: value.map((entry) => toEncodedEnvelope(entry, stack, recordBinaryBytes)),
    };
  }
  if (typeof value !== 'object' || value === null) {
    return { handled: true, value };
  }
  return { handled: false };
}

function toEncodedBinaryValue(
  value: unknown,
  recordBinaryBytes: (bytes: number) => void,
): { handled: true; value: unknown } | { handled: false } {
  if (value instanceof ArrayBuffer) {
    recordBinaryBytes(value.byteLength);
    return { handled: true, value: { [BINARY_MARKER]: value.byteLength } };
  }
  if (ArrayBuffer.isView(value)) {
    recordBinaryBytes(value.byteLength);
    return { handled: true, value: { [BINARY_MARKER]: value.byteLength } };
  }
  return { handled: false };
}

function toEncodedKnownObjectValue(
  value: unknown,
  stack: object[],
  recordBinaryBytes: (bytes: number) => void,
): { handled: true; value: unknown } | { handled: false } {
  if (value instanceof Date) {
    return { handled: true, value: { [DATE_MARKER]: value.toISOString() } };
  }
  if (value instanceof Error) {
    return {
      handled: true,
      value: { [ERROR_MARKER]: { name: value.name, message: value.message } },
    };
  }
  if (value instanceof Map) {
    return {
      handled: true,
      value: {
        [MAP_MARKER]: [...value.entries()].map(([key, entryValue]) => [
          toEncodedEnvelope(key, stack, recordBinaryBytes),
          toEncodedEnvelope(entryValue, stack, recordBinaryBytes),
        ]),
      },
    };
  }
  if (value instanceof Set) {
    return {
      handled: true,
      value: {
        [SET_MARKER]: [...value.values()].map((entry) =>
          toEncodedEnvelope(entry, stack, recordBinaryBytes),
        ),
      },
    };
  }
  return { handled: false };
}

function toEncodedObjectEnvelope(
  value: Record<string, unknown>,
  stack: object[],
  recordBinaryBytes: (bytes: number) => void,
): Record<string, unknown> {
  stack.push(value);
  try {
    const envelope: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      envelope[key] = toEncodedEnvelope(value[key], stack, recordBinaryBytes);
    }
    return envelope;
  } finally {
    stack.pop();
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
