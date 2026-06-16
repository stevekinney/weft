import { decode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import { normalizeFailureCategory } from '../failure-categories.ts';
import { coerceStartWorkflowId, parseStartWorkflowDuration } from '../start-workflow-validation.ts';
import type {
  HistoryPolicy,
  NormalizedHistoryPolicy,
  NormalizedPayloadSizePolicy,
  NormalizedRetentionPolicy,
  PayloadSizePolicy,
  RetentionPolicy,
  WorkflowState,
  WorkflowStatus,
  WorkflowTimelineEntry,
  WorkflowTimelineStatus,
} from '../types.ts';
import { DEFAULT_WORKFLOW_VERSION } from '../versioning.ts';
import { isWorkflowTagArray } from '../workflow-tags.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';

const WORKFLOW_TIMELINE_STATUSES = new Set<WorkflowTimelineStatus>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

type CompleteWorkflowStateFieldNames<FieldNames extends readonly (keyof WorkflowState)[]> =
  Exclude<keyof WorkflowState, FieldNames[number]> extends never
    ? FieldNames
    : FieldNames & {
        readonly __missingWorkflowStateFields: Exclude<keyof WorkflowState, FieldNames[number]>;
      };

function defineCompleteWorkflowStateFieldNames<
  const FieldNames extends readonly (keyof WorkflowState)[],
>(fieldNames: CompleteWorkflowStateFieldNames<FieldNames>): FieldNames {
  return fieldNames;
}

const WORKFLOW_STATE_FIELD_NAMES = new Set<string>(
  defineCompleteWorkflowStateFieldNames([
    'id',
    'type',
    'status',
    'tags',
    'input',
    'result',
    'error',
    'errorStack',
    'failureCategory',
    'terminationReason',
    'versionTuple',
    'executionStateOwnerId',
    'createdAt',
    'startedAt',
    'updatedAt',
    'terminalCleanupToken',
    'executionDeadline',
    'forkedFrom',
  ]),
);

export function isSanitizedSearchAttributeValue(
  value: unknown,
): value is import('../types.ts').SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isWorkflowVersionTuple(value: unknown): value is WorkflowVersionTuple {
  if (!isRecord(value) || typeof value['workflowVersion'] !== 'string') {
    return false;
  }

  if (value['agentVersion'] !== undefined && typeof value['agentVersion'] !== 'string') {
    return false;
  }

  return (
    value['toolVersions'] === undefined ||
    (Array.isArray(value['toolVersions']) &&
      value['toolVersions'].every((entry) => typeof entry === 'string'))
  );
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isTimelineStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

type TimelineEntryFieldCheck = (entry: Record<string, unknown>) => boolean;

const TIMELINE_ENTRY_FIELD_CHECKS: readonly TimelineEntryFieldCheck[] = [
  (entry) => isTimelineStep(entry['step']),
  (entry) => typeof entry['operationType'] === 'string',
  (entry) => typeof entry['operationLabel'] === 'string',
  (entry) => typeof entry['inputSummary'] === 'string',
  (entry) => isFiniteNumber(entry['timestamp']),
  (entry) => WORKFLOW_TIMELINE_STATUSES.has(entry['status'] as WorkflowTimelineStatus),
  (entry) => entry['outputSummary'] === undefined || typeof entry['outputSummary'] === 'string',
  (entry) => entry['duration'] === undefined || isFiniteNumber(entry['duration']),
  (entry) => entry['versionTuple'] === undefined || isWorkflowVersionTuple(entry['versionTuple']),
];

export function isWorkflowTimelineEntry(value: unknown): value is WorkflowTimelineEntry {
  if (!isRecord(value)) {
    return false;
  }
  return TIMELINE_ENTRY_FIELD_CHECKS.every((check) => check(value));
}

export function normalizeBulkFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`filter.${fieldName} must be a non-negative number when provided`);
  }

  return Math.floor(value);
}

export function isValidDecodedTags(value: unknown): value is string[] | undefined {
  return value === undefined || isWorkflowTagArray(value);
}

export function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  const decoded = decode(bytes);
  const decodedRecord = isRecord(decoded) ? decoded : undefined;
  // A persisted record may carry the version metadata as three flat fields
  // (`version`, `agentVersion`, `toolVersions`) rather than a nested
  // `versionTuple`. Normalize it into the current shape on the raw decoded
  // record (before the `WorkflowState` cast) and drop the flat keys so the rest
  // of the engine sees one representation. Read-only normalization: the engine
  // only ever writes the nested `versionTuple`.
  if (decodedRecord !== undefined) {
    liftFlatVersionTuple(decodedRecord);
  }
  // bytes were written by encode(WorkflowState) — shape is guaranteed by our own storage
  const state = decoded as WorkflowState;
  if (!isValidDecodedTags(state.tags)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has invalid tags; ` +
        'dropping the malformed tag list from the decoded state.',
    );
    delete state.tags;
  }
  if (state.failureCategory !== undefined && state.failureCategory !== null) {
    const normalizedFailureCategory = normalizeFailureCategory(state.failureCategory);
    if (normalizedFailureCategory === undefined) {
      delete state.failureCategory;
    } else {
      state.failureCategory = normalizedFailureCategory;
    }
  }
  if (state.executionStateOwnerId !== undefined) {
    try {
      coerceStartWorkflowId(state.executionStateOwnerId, 'executionStateOwnerId');
    } catch {
      console.warn(
        `[weft] Decoded workflow state for "${String(state.id)}" has an invalid ` +
          'executionStateOwnerId field; falling back to the workflow id as the execution owner. ' +
          'This usually indicates corruption or tampering of the storage record.',
      );
      delete state.executionStateOwnerId;
    }
  }
  return decodedRecord === undefined
    ? state
    : stripUnknownWorkflowStateFields(state, decodedRecord);
}

function stripUnknownWorkflowStateFields(
  state: WorkflowState,
  stateFields: Record<string, unknown>,
): WorkflowState {
  for (const fieldName of Object.keys(stateFields)) {
    if (!WORKFLOW_STATE_FIELD_NAMES.has(fieldName)) {
      delete stateFields[fieldName];
    }
  }
  return state;
}

/**
 * Normalize flat version fields (`version`, `agentVersion`, `toolVersions`)
 * into the current nested {@link WorkflowState.versionTuple}. No-op when the
 * record already carries a `versionTuple`. Read-only normalization — the engine
 * only ever writes the nested shape back.
 */
function liftFlatVersionTuple(record: Record<string, unknown>): void {
  const flatVersion = record['version'];
  const hasFlatVersion = typeof flatVersion === 'string';
  // A record with a usable nested tuple needs no lift; just drop any stray flat
  // keys that may have been written alongside it by an intermediate build.
  if (isWorkflowVersionTuple(record['versionTuple'])) {
    delete record['version'];
    delete record['agentVersion'];
    delete record['toolVersions'];
    return;
  }
  const flatAgentVersion = record['agentVersion'];
  const flatToolVersions = record['toolVersions'];
  const versionTuple: WorkflowVersionTuple = {
    // `version` was always present on persisted records; fall back to the
    // default only if a corrupt record is missing it entirely.
    workflowVersion: hasFlatVersion ? flatVersion : DEFAULT_WORKFLOW_VERSION,
    ...(typeof flatAgentVersion === 'string' && { agentVersion: flatAgentVersion }),
    ...(Array.isArray(flatToolVersions) &&
      flatToolVersions.every((entry) => typeof entry === 'string') && {
        toolVersions: flatToolVersions,
      }),
  };
  record['versionTuple'] = versionTuple;
  delete record['version'];
  delete record['agentVersion'];
  delete record['toolVersions'];
}

export function normalizeRetentionDuration(
  value: import('../types.ts').Duration | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const milliseconds = parseStartWorkflowDuration(value, fieldName);
  return Math.ceil(milliseconds);
}

/**
 * Validate and normalise a {@link HistoryPolicy} into a
 * {@link NormalizedHistoryPolicy}. Mirrors {@link normalizeRetentionPolicy}'s
 * throw-on-bad-input contract.
 *
 * Both `maxEvents` and `retentionWindow` share the same validation mechanics
 * (they differ in semantics — see {@link HistoryPolicy}):
 * - omitted policy, or omitted/`undefined` field → `null` (disabled).
 * - `0` → `null` (disabled; mirrors `checkpointHistory: 0` meaning "off").
 * - any other value that is not a positive safe integer (negatives, non-integers,
 *   non-finite values, unsafe integers, wrong types) → throws.
 */
export function normalizeHistoryPolicy(
  policy: HistoryPolicy | undefined,
  context: string,
): NormalizedHistoryPolicy {
  return {
    maxEvents: normalizePositiveCountOrDisabled(policy?.maxEvents, `${context}.maxEvents`),
    retentionWindow: normalizePositiveCountOrDisabled(
      policy?.retentionWindow,
      `${context}.retentionWindow`,
    ),
  };
}

/**
 * Normalize a "positive count, or 0/undefined to disable" history-policy field
 * into `number | null`. Shared by `maxEvents` and `retentionWindow`.
 */
function normalizePositiveCountOrDisabled(value: number | undefined, field: string): number | null {
  // `undefined` and `0` both mean "disabled" and short-circuit before the guard,
  // so the guard below only ever rejects genuinely invalid positive-intent input.
  if (value === undefined || value === 0) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `${field} must be a positive safe integer (or 0/undefined to disable); received ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validate and normalise a {@link PayloadSizePolicy} into a
 * {@link NormalizedPayloadSizePolicy}. Mirrors {@link normalizeHistoryPolicy}'s
 * throw-on-bad-input contract.
 *
 * Contract for `maxBytes`:
 * - omitted policy, or omitted/`undefined`/`null` field → `{ maxBytes: null }` (disabled).
 * - `0` → `{ maxBytes: null }` (disabled).
 * - any other value that is not a positive safe integer (negatives, non-integers,
 *   non-finite values, unsafe integers, wrong types) → throws.
 */
export function normalizePayloadSizePolicy(
  policy: PayloadSizePolicy | undefined,
  context: string,
): NormalizedPayloadSizePolicy {
  const maxBytes = policy?.maxBytes;
  if (maxBytes === undefined || maxBytes === null || maxBytes === 0) {
    return { maxBytes: null };
  }
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError(
      `${context}.maxBytes must be a positive safe integer (or 0/null/undefined to disable); received ${String(
        maxBytes,
      )}`,
    );
  }
  return { maxBytes };
}

export function normalizeRetentionPolicy(
  policy: RetentionPolicy | undefined,
  context: string,
): NormalizedRetentionPolicy | null {
  if (!policy) {
    return null;
  }

  const normalized: NormalizedRetentionPolicy = {};
  const completed = normalizeRetentionDuration(policy.completed, `${context}.completed`);
  const failed = normalizeRetentionDuration(policy.failed, `${context}.failed`);
  const cancelled = normalizeRetentionDuration(policy.cancelled, `${context}.cancelled`);
  const timedOut = normalizeRetentionDuration(policy.timedOut, `${context}.timedOut`);

  if (completed !== undefined) {
    normalized.completed = completed;
  }
  if (failed !== undefined) {
    normalized.failed = failed;
  }
  if (cancelled !== undefined) {
    normalized.cancelled = cancelled;
  }
  if (timedOut !== undefined) {
    normalized.timedOut = timedOut;
  }

  const isEmpty =
    normalized.completed === undefined &&
    normalized.failed === undefined &&
    normalized.cancelled === undefined &&
    normalized.timedOut === undefined;

  return isEmpty ? null : normalized;
}

export function resolveRetentionForStatus(
  policy: NormalizedRetentionPolicy | null | undefined,
  status: WorkflowStatus,
): number | undefined {
  switch (status) {
    case 'completed':
      return policy?.completed;
    case 'failed':
      return policy?.failed;
    case 'cancelled':
      return policy?.cancelled;
    case 'timed-out':
      return policy?.timedOut;
    default:
      return undefined;
  }
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out'
  );
}

export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
