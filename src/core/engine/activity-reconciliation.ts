import {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  type Storage,
} from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import type { ActivityVerificationContext, ActivityVerificationResult } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import type { EngineInternals } from './internals.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

export type ActivityReconciliationMetadata = {
  verify?: (
    result: unknown,
    context?: ActivityVerificationContext,
  ) => Promise<ActivityVerificationResult> | ActivityVerificationResult;
  idempotencyKey?: (input: unknown) => string;
};

export type ActivityReconciliationRecord =
  | {
      version: 1;
      status: 'started';
      workflowId: string;
      operationId: string;
      activityName: string;
      idempotencyKeyDigest: string;
      attempt: number;
      ownerId: string;
      createdAt: number;
      updatedAt: number;
    }
  | {
      version: 1;
      status: 'completed';
      workflowId: string;
      operationId: string;
      activityName: string;
      idempotencyKeyDigest: string;
      attempt: number;
      ownerId: string;
      result: unknown;
      createdAt: number;
      updatedAt: number;
    };

export type ActivityReconciliationReference = {
  key: string;
  idempotencyKeyDigest: string;
};

/**
 * Thrown before dispatching a keyed activity when the configured storage
 * adapter cannot claim the reconciliation marker atomically. Use a storage
 * adapter with `conditionalBatch` support before relying on Tier-0 activity
 * result reconciliation.
 *
 * @example
 * ```ts
 * import { ActivityReconciliationCapabilityError } from '@lostgradient/weft';
 *
 * function needsConditionalBatchStorage(error: unknown): boolean {
 *   return error instanceof ActivityReconciliationCapabilityError;
 * }
 * ```
 */
export class ActivityReconciliationCapabilityError extends WeftError<'ActivityReconciliationCapabilityError'> {
  constructor() {
    super(
      'ActivityReconciliationCapabilityError',
      'Activity result reconciliation requires storage capability "conditionalBatch".',
    );
  }
}

/**
 * Thrown when another engine turn changes the keyed activity reconciliation
 * marker between the read and the compare-and-set transition. Retry the
 * workflow turn so it can re-read the current marker state.
 *
 * @example
 * ```ts
 * import { ActivityReconciliationConflictError } from '@lostgradient/weft';
 *
 * function shouldRetryWorkflowTurn(error: unknown): boolean {
 *   return error instanceof ActivityReconciliationConflictError;
 * }
 * ```
 */
export class ActivityReconciliationConflictError extends WeftError<'ActivityReconciliationConflictError'> {
  constructor(message: string) {
    super('ActivityReconciliationConflictError', message);
  }
}

/**
 * Thrown when a keyed activity has a prior dispatch marker but the engine
 * cannot prove whether the external work completed with a reusable result.
 * This is a fail-closed state: resolve the external side effect manually, then
 * resume with a verifier that returns a definitive reconciliation state.
 *
 * @example
 * ```ts
 * import { ActivityReconciliationIndeterminateError } from '@lostgradient/weft';
 *
 * function needsOperatorReconciliation(error: unknown): boolean {
 *   return error instanceof ActivityReconciliationIndeterminateError;
 * }
 * ```
 */
export class ActivityReconciliationIndeterminateError extends WeftError<'ActivityReconciliationIndeterminateError'> {
  constructor(message: string) {
    super('ActivityReconciliationIndeterminateError', message);
  }
}

export async function buildActivityReconciliationReference(
  workflowId: string,
  activityName: string,
  idempotencyKey: string,
): Promise<ActivityReconciliationReference> {
  const idempotencyKeyDigest = await digestIdempotencyKey(idempotencyKey);
  return {
    idempotencyKeyDigest,
    key: KEYS.activityReconciliation(workflowId, activityName, idempotencyKeyDigest),
  };
}

export function resolveActivityIdempotencyKey(
  activity: ActivityReconciliationMetadata | undefined,
  operation: ActivityOperation,
): string | undefined {
  const definitionKey = activity?.idempotencyKey?.(operation.input);
  if (definitionKey !== undefined) return definitionKey;
  const optionKey = operation.options?.['idempotencyKey'];
  return typeof optionKey === 'string' ? optionKey : undefined;
}

export async function readActivityReconciliationRecord(
  storage: Storage,
  key: string,
): Promise<ActivityReconciliationRecord | null> {
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  return parseActivityReconciliationRecord(decode(bytes));
}

export function validateActivityResultForReconciliation(
  result: unknown,
  maxPayloadBytes: number | null,
): Uint8Array {
  assertPayloadWithinLimit(result, maxPayloadBytes, 'activity result');
  return encode(result);
}

export async function claimActivityReconciliationStart(
  storage: Storage,
  reference: ActivityReconciliationReference,
  record: ActivityReconciliationRecord,
): Promise<boolean> {
  if (!storage.capabilities().conditionalBatch) {
    throw new ActivityReconciliationCapabilityError();
  }
  requireStorageCapability(storage, 'conditionalBatch', 'activity result reconciliation');
  return storageConditionalBatch(
    storage,
    [{ key: reference.key, expectedValue: null }],
    [{ type: 'put', key: reference.key, value: encode(record) }],
  );
}

export function createCompletedActivityReconciliationRecord(
  startedRecord: ActivityReconciliationRecord,
  result: unknown,
  now: number,
): ActivityReconciliationRecord {
  return {
    ...startedRecord,
    status: 'completed',
    result,
    updatedAt: now,
  };
}

export async function resolveStartedActivityReconciliationRecord(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  reference: ActivityReconciliationReference,
  activity: ActivityReconciliationMetadata | undefined,
  idempotencyKey: string,
  attempt: number,
): Promise<ActivityReconciliationRecord | { completedResult: unknown }> {
  let record = await readActivityReconciliationRecord(internals.storage, reference.key);
  if (record === null) {
    const claimed = await claimStartedRecord(internals, workflowId, operation, reference, attempt);
    if (claimed.didClaim) return claimed.record;
    record = claimed.record;
  }
  if (record.status === 'completed') return { completedResult: record.result };
  if (!activity?.verify) {
    throw new ActivityReconciliationIndeterminateError(
      `Activity "${operation.activityName}" has a prior dispatch marker but no Tier-0 verifier.`,
    );
  }
  const normalized = normalizePreDispatchVerificationResult(
    await runPreDispatchVerification(activity, workflowId, operation, idempotencyKey, record),
  );
  if (normalized === 'not-completed') {
    const nextRecord = {
      ...record,
      attempt: record.attempt + 1,
      ownerId: crypto.randomUUID(),
      updatedAt: internals.options.getNow(),
    };
    await writeActivityReconciliationTransition(internals.storage, reference, record, nextRecord);
    return nextRecord;
  }
  if (normalized === 'completed-result-unavailable') {
    throw new ActivityReconciliationIndeterminateError(
      `Activity "${operation.activityName}" completed externally but its result is unavailable.`,
    );
  }
  if (normalized === 'indeterminate') {
    throw new ActivityReconciliationIndeterminateError(
      `Activity "${operation.activityName}" reconciliation is indeterminate.`,
    );
  }
  validateActivityResultForReconciliation(
    normalized.result,
    internals.options.payloadSizePolicy.maxBytes,
  );
  const completedRecord = createCompletedActivityReconciliationRecord(
    record,
    normalized.result,
    internals.options.getNow(),
  );
  await writeActivityReconciliationTransition(
    internals.storage,
    reference,
    record,
    completedRecord,
  );
  return { completedResult: normalized.result };
}

export async function writeActivityReconciliationTransition(
  storage: Storage,
  reference: ActivityReconciliationReference,
  expectedRecord: ActivityReconciliationRecord,
  nextRecord: ActivityReconciliationRecord,
): Promise<void> {
  const committed = await storageConditionalBatch(
    storage,
    [{ key: reference.key, expectedValue: encode(expectedRecord) }],
    [{ type: 'put', key: reference.key, value: encode(nextRecord) }],
  );
  if (!committed) {
    throw new ActivityReconciliationConflictError(
      'Activity reconciliation completion lost compare-and-set ownership.',
    );
  }
}

export function normalizePreDispatchVerificationResult(
  result: ActivityVerificationResult,
): 'not-completed' | 'completed-result-unavailable' | 'indeterminate' | { result: unknown } {
  if (result === 'not-completed') return 'not-completed';
  if (result === 'completed-result-unavailable') return 'completed-result-unavailable';
  if (result === 'indeterminate') return 'indeterminate';
  if (typeof result === 'object' && result !== null && 'status' in result) {
    const record = result as { status?: unknown; result?: unknown };
    if (record.status === 'completed-with-result') return { result: record.result };
  }
  throw new ActivityReconciliationIndeterminateError(
    'Activity verifier did not return a Tier-0 pre-dispatch reconciliation state.',
  );
}

export function buildActivityVerificationContext(
  phase: ActivityVerificationContext['phase'],
  workflowId: string,
  operationId: string,
  activityName: string,
  input: unknown,
  idempotencyKey: string | undefined,
  attempt: number,
): ActivityVerificationContext {
  return {
    phase,
    workflowId,
    operationId,
    activityName,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    attempt,
  };
}

function parseActivityReconciliationRecord(value: unknown): ActivityReconciliationRecord {
  if (typeof value !== 'object' || value === null) {
    throw new ActivityReconciliationIndeterminateError(
      'Activity reconciliation record is not an object.',
    );
  }
  const record = value as Record<string, unknown>;
  if (!isActivityReconciliationRecordBase(record)) {
    throw new ActivityReconciliationIndeterminateError(
      'Activity reconciliation record has an invalid shape.',
    );
  }
  if (record['status'] === 'started') return record as ActivityReconciliationRecord;
  if (record['status'] === 'completed' && 'result' in record) {
    return record as ActivityReconciliationRecord;
  }
  throw new ActivityReconciliationIndeterminateError(
    'Activity reconciliation record has an unsupported status.',
  );
}

async function digestIdempotencyKey(idempotencyKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(idempotencyKey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createStartedRecord(
  workflowId: string,
  operation: ActivityOperation,
  reference: ActivityReconciliationReference,
  attempt: number,
  now: number,
): ActivityReconciliationRecord {
  return {
    version: 1,
    status: 'started',
    workflowId,
    operationId: operation.operationId,
    activityName: operation.activityName,
    idempotencyKeyDigest: reference.idempotencyKeyDigest,
    attempt,
    ownerId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}

async function claimStartedRecord(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  reference: ActivityReconciliationReference,
  attempt: number,
): Promise<{ didClaim: boolean; record: ActivityReconciliationRecord }> {
  const startedRecord = createStartedRecord(
    workflowId,
    operation,
    reference,
    attempt,
    internals.options.getNow(),
  );
  const claimed = await claimActivityReconciliationStart(
    internals.storage,
    reference,
    startedRecord,
  );
  if (claimed) return { didClaim: true, record: startedRecord };
  const record = await readActivityReconciliationRecord(internals.storage, reference.key);
  if (record === null) {
    throw new ActivityReconciliationIndeterminateError(
      'Activity reconciliation claim conflicted but no record could be read.',
    );
  }
  return { didClaim: false, record };
}

async function runPreDispatchVerification(
  activity: ActivityReconciliationMetadata,
  workflowId: string,
  operation: ActivityOperation,
  idempotencyKey: string,
  record: ActivityReconciliationRecord,
): Promise<ActivityVerificationResult> {
  try {
    return await activity.verify!(
      undefined,
      buildActivityVerificationContext(
        'pre-dispatch-reconciliation',
        workflowId,
        operation.operationId,
        operation.activityName,
        operation.input,
        idempotencyKey,
        record.attempt,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ActivityReconciliationIndeterminateError(
      `Activity "${operation.activityName}" verifier threw during pre-dispatch reconciliation: ${message}`,
    );
  }
}

function isActivityReconciliationRecordBase(record: Record<string, unknown>): boolean {
  const stringFields = [
    'workflowId',
    'operationId',
    'activityName',
    'idempotencyKeyDigest',
    'ownerId',
  ];
  const numberFields = ['attempt', 'createdAt', 'updatedAt'];
  return (
    record['version'] === 1 &&
    stringFields.every((field) => typeof record[field] === 'string') &&
    numberFields.every((field) => typeof record[field] === 'number')
  );
}
