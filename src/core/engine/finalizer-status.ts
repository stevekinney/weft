import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import type { WorkflowFinalizerStatus, WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { isTeardownClaim } from './state-utilities.ts';

export interface TeardownSucceededRecord {
  attempts: number;
  completedAt: number;
  workflowExecutionToken?: string;
}

export function buildTeardownSuccessOperations(
  workflowId: string,
  attempts: number,
  completedAt: number,
  workflowExecutionToken: string | undefined,
): BatchOperation[] {
  const outcome: TeardownSucceededRecord = {
    attempts,
    completedAt,
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
  };
  return [
    { type: 'delete', key: KEYS.teardownOwed(workflowId) },
    { type: 'delete', key: KEYS.finalizerState(workflowId) },
    { type: 'put', key: KEYS.teardownSucceeded(workflowId), value: encode(outcome) },
  ];
}

function decodeUnknown(bytes: Uint8Array): unknown {
  try {
    return decode(bytes);
  } catch {
    return null;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function recordBelongsToRun(record: Record<string, unknown>, state: WorkflowState | null): boolean {
  const recordToken = record['workflowExecutionToken'];
  if (recordToken !== undefined && typeof recordToken !== 'string') return false;
  if (state === null) return true;
  return recordToken === state.workflowExecutionToken;
}

export async function getFinalizerStatus(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState | null,
): Promise<WorkflowFinalizerStatus | null> {
  const claimBytes = await internals.storage.get(KEYS.teardownOwed(workflowId));
  const claimStatus = decodeClaimStatus(claimBytes);
  if (claimStatus !== null) return claimStatus;

  const deadLetterBytes = await internals.storage.get(KEYS.teardownDeadLetter(workflowId));
  const failedStatus = decodeFailedStatus(deadLetterBytes, state);
  if (failedStatus !== null) return failedStatus;

  const succeededBytes = await internals.storage.get(KEYS.teardownSucceeded(workflowId));
  return decodeSucceededStatus(succeededBytes, state);
}

function decodeClaimStatus(bytes: Uint8Array | null): WorkflowFinalizerStatus | null {
  if (bytes === null) return null;
  const claim = decodeUnknown(bytes);
  if (!isTeardownClaim(claim)) return null;
  if (claim.status === 'running' && claim.claimedAt !== undefined) {
    return { status: 'running', attempts: claim.attempts + 1, startedAt: claim.claimedAt };
  }
  return { status: 'pending', attempts: claim.attempts };
}

function decodeFailedStatus(
  bytes: Uint8Array | null,
  state: WorkflowState | null,
): WorkflowFinalizerStatus | null {
  if (bytes === null) return null;
  const record = decodeUnknown(bytes);
  if (
    !isRecord(record) ||
    !recordBelongsToRun(record, state) ||
    typeof record['lastError'] !== 'string' ||
    !isNonNegativeSafeInteger(record['attempts']) ||
    !isNonNegativeFiniteNumber(record['deadLetteredAt'])
  ) {
    return null;
  }
  return {
    status: 'failed',
    attempts: record['attempts'],
    failedAt: record['deadLetteredAt'],
    error: record['lastError'],
  };
}

function decodeSucceededStatus(
  bytes: Uint8Array | null,
  state: WorkflowState | null,
): WorkflowFinalizerStatus | null {
  if (bytes === null) return null;
  const record = decodeUnknown(bytes);
  if (
    !isRecord(record) ||
    !recordBelongsToRun(record, state) ||
    !isNonNegativeSafeInteger(record['attempts']) ||
    !isNonNegativeFiniteNumber(record['completedAt'])
  ) {
    return null;
  }
  return {
    status: 'succeeded',
    attempts: record['attempts'],
    completedAt: record['completedAt'],
  };
}
