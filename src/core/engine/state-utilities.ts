import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { isRecord, safeDebugStringify, sanitizeDebugValueForDisplay } from '../debug-output.ts';
import type {
  ListFilter,
  PaginatedResult,
  ScheduleFilter,
  ScheduleState,
  ScheduleSummary,
  TimeRange,
  WorkflowState,
  WorkflowSummary,
} from '../types.ts';
import { matchesWorkflowTagFilter } from '../workflow-tags.ts';
import { isPlainObjectRecord, isSanitizedSearchAttributeValue } from './validation.ts';

const PERSISTED_WORKFLOW_START_HEADER_NAMES = new Set(['traceparent', 'tracestate']);

const PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX = 'terminal-cleanup:preserve-output:';

const FULL_TERMINAL_CLEANUP_TIMER_PREFIX = 'terminal-cleanup:full:';

type PaginationFilter = {
  limit?: number;
  offset?: number;
};

/**
 * Build the unified `#workflowFeedListeners` map key. Uses `\0` as
 * the separator: workflow ID validation (`assertValidWorkflowId`)
 * rejects control characters, so no legal workflow ID can contain
 * NUL, and the selector is a fixed two-member union, so no legal
 * input can collide.
 */
export function workflowFeedListenerKey(workflowId: string, selector: 'events' | 'tokens'): string {
  return `${workflowId}\0${selector}`;
}

/**
 * Safely cast a `Function` stored on a ContextOperationRequest
 * to a callable signature.  We trust the Context layer to populate
 * `fn` with the correct reference—the Engine merely invokes it.
 */
export function callActivityFunction(fn: Function, input: unknown, context?: unknown): unknown {
  return (fn as (value: unknown, context?: unknown) => unknown)(input, context);
}

export function callMemoFunction(fn: Function): unknown {
  return (fn as () => unknown)();
}

export function summarizeTimelineValue(value: unknown): string {
  return safeDebugStringify(value);
}

const KEY_LABELED_OPERATIONS = new Set<ContextOperationRequest['type']>([
  'memo',
  'offload',
  'archive',
  'stream',
  'state-read',
  'state-commit',
]);

export function getTimelineOperationLabel(operation: ContextOperationRequest): string {
  if (KEY_LABELED_OPERATIONS.has(operation.type)) {
    return (operation as Extract<ContextOperationRequest, { key: string }>).key;
  }
  switch (operation.type) {
    case 'activity':
      return operation.activityName;
    case 'wait-signal':
      return operation.signalName;
    case 'wait-update':
      return operation.updateName;
    case 'child-workflow':
      return operation.workflowType;
    case 'load':
      return operation.reference.key;
    default:
      return operation.type;
  }
}

export function getTimelineReviewArtifactType(artifact: unknown): unknown {
  if (typeof artifact !== 'object' || artifact === null || !('type' in artifact)) {
    return undefined;
  }

  return (artifact as Record<string, unknown>)['type'];
}

const KEY_ONLY_INPUT_OPERATIONS = new Set<ContextOperationRequest['type']>([
  'memo',
  'offload',
  'stream',
]);

function summarizeStorageOperationInput(operation: ContextOperationRequest): string | undefined {
  if (KEY_ONLY_INPUT_OPERATIONS.has(operation.type)) {
    return summarizeTimelineValue({
      key: (operation as Extract<ContextOperationRequest, { key: string }>).key,
    });
  }
  switch (operation.type) {
    case 'load':
      return summarizeTimelineValue({ key: operation.reference.key });
    case 'archive':
      return summarizeTimelineValue({ key: operation.key, data: operation.data });
    case 'state-read':
      return summarizeTimelineValue({ key: operation.key, scope: operation.scope });
    case 'state-commit':
      return summarizeTimelineValue({
        key: operation.key,
        mode: operation.mode,
        scope: operation.scope,
      });
    default:
      return undefined;
  }
}

export function getTimelineBasicInputSummary(operation: ContextOperationRequest): string {
  const storageSummary = summarizeStorageOperationInput(operation);
  if (storageSummary !== undefined) {
    return storageSummary;
  }
  switch (operation.type) {
    case 'sleep':
      return summarizeTimelineValue({ duration: operation.duration });
    case 'wait-signal':
      return summarizeTimelineValue({ signalName: operation.signalName });
    case 'wait-update':
      return summarizeTimelineValue({ updateName: operation.updateName });
    case 'parallel':
    case 'race':
      return summarizeTimelineValue({ operationCount: operation.operations.length });
    case 'speculate':
      return summarizeTimelineValue({ branch: 'speculative' });
    default:
      return summarizeTimelineValue(undefined);
  }
}

export function getTimelineInputSummary(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'activity':
      return summarizeTimelineValue(operation.input);
    case 'child-workflow':
      return summarizeTimelineValue({
        workflowType: operation.workflowType,
        input: operation.input,
      });
    case 'run-all':
      return summarizeTimelineValue({ branches: Object.keys(operation.branches) });
    case 'wait-review':
      return summarizeTimelineValue({
        reviewers: operation.reviewOptions.reviewers,
        artifactType: getTimelineReviewArtifactType(operation.reviewOptions.artifact),
      });
    default:
      return getTimelineBasicInputSummary(operation);
  }
}

export function sanitizeCheckpointLocals(locals: unknown): Record<string, unknown> {
  const sanitized = sanitizeDebugValueForDisplay(locals);
  return isRecord(sanitized) ? sanitized : {};
}

export function sanitizeCheckpointSearchAttributes(
  searchAttributes: unknown,
): Record<string, import('../types.ts').SearchAttributeValue> {
  const sanitized = sanitizeDebugValueForDisplay(searchAttributes);
  if (!isRecord(sanitized)) {
    return {};
  }

  const result: Record<string, import('../types.ts').SearchAttributeValue> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (isSanitizedSearchAttributeValue(value)) {
      result[key] = value;
    }
  }

  return result;
}

export function sanitizeCheckpointState(
  checkpoint: import('../types.ts').CheckpointState,
): import('../types.ts').CheckpointState {
  return {
    step: checkpoint.step,
    locals: sanitizeCheckpointLocals(checkpoint.locals),
    searchAttributes: sanitizeCheckpointSearchAttributes(checkpoint.searchAttributes),
    version: checkpoint.version,
    createdAt: checkpoint.createdAt,
  };
}

export function sanitizeWorkflowEventPayload(payload: unknown): Record<string, unknown> {
  const sanitized = sanitizeDebugValueForDisplay(payload);
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

export function sanitizeTimelineSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }

  try {
    return summarizeTimelineValue(JSON.parse(summary) as unknown);
  } catch {
    return summary;
  }
}

export function normalizeForkStep(fromStep: number): number {
  if (!Number.isSafeInteger(fromStep) || fromStep < 0) {
    throw new Error('options.fromStep must be a non-negative safe integer');
  }

  return fromStep;
}

export function encodeWorkflowStartHeaders(headers: Map<string, string>): Uint8Array {
  return encode([...headers.entries()]);
}

export function decodeWorkflowStartHeaders(bytes: Uint8Array): Map<string, string> {
  const entries = decode(bytes) as Array<[string, string]>;
  return new Map(entries);
}

export function selectPersistedWorkflowStartHeaders(
  headers: Map<string, string> | undefined,
): Map<string, string> | undefined {
  if (!headers || headers.size === 0) {
    return undefined;
  }

  const persistedHeaders = new Map<string, string>();

  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (!PERSISTED_WORKFLOW_START_HEADER_NAMES.has(normalizedName)) {
      continue;
    }
    persistedHeaders.set(normalizedName, value);
  }

  return persistedHeaders.size > 0 ? persistedHeaders : undefined;
}

export function intersectIdentifierSets(idSets: Set<string>[]): Set<string> | null {
  const [firstSet, ...remainingSets] = idSets;
  if (!firstSet) {
    return null;
  }

  const intersected = new Set(firstSet);
  for (const nextSet of remainingSets) {
    for (const id of intersected) {
      if (!nextSet.has(id)) {
        intersected.delete(id);
      }
    }
  }

  return intersected;
}

function matchesListFilterStatus(state: WorkflowState, filter: ListFilter): boolean {
  if (filter.status === undefined) return true;
  const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
  return statuses.includes(state.status);
}

function matchesListFilterIdentity(state: WorkflowState, filter: ListFilter): boolean {
  return (
    matchesListFilterStatus(state, filter) &&
    (filter.type === undefined || state.type === filter.type) &&
    (filter.idPrefix === undefined || state.id.startsWith(filter.idPrefix))
  );
}

function matchesListFilterTimeRanges(state: WorkflowState, filter: ListFilter): boolean {
  if (filter.createdAt !== undefined && !timestampInRange(state.createdAt, filter.createdAt)) {
    return false;
  }
  if (filter.updatedAt !== undefined && !timestampInRange(state.updatedAt, filter.updatedAt)) {
    return false;
  }
  if (filter.executionDeadline === undefined) return true;
  return (
    state.executionDeadline !== undefined &&
    timestampInRange(state.executionDeadline, filter.executionDeadline)
  );
}

function matchesListFilterFailureCategory(state: WorkflowState, filter: ListFilter): boolean {
  if (filter.failureCategory === undefined) return true;
  const categories = Array.isArray(filter.failureCategory)
    ? filter.failureCategory
    : [filter.failureCategory];
  return (
    state.failureCategory !== undefined &&
    state.failureCategory !== null &&
    categories.includes(state.failureCategory)
  );
}

export function matchesListFilter(
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
): boolean {
  if (constrainedIds !== null && !constrainedIds.has(state.id)) return false;
  if (!matchesWorkflowTagFilter(state.tags, normalizedTagFilters)) return false;
  if (filter === undefined) return true;
  if (!matchesListFilterIdentity(state, filter)) return false;
  if (!matchesListFilterTimeRanges(state, filter)) return false;
  if (!matchesListFilterFailureCategory(state, filter)) return false;
  return true;
}

function timestampInRange(value: number, range: TimeRange): boolean {
  if (range.gte !== undefined && value < range.gte) return false;
  if (range.gt !== undefined && value <= range.gt) return false;
  if (range.lte !== undefined && value > range.lte) return false;
  if (range.lt !== undefined && value >= range.lt) return false;
  return true;
}

/**
 * Slice an in-memory list of {@link WorkflowSummary} into a {@link PaginatedResult}.
 *
 * Important note on `total` semantics: the returned `total` reflects the number
 * of workflows that matched the supplied {@link ListFilter} (status, type, and
 * search attribute filters). It is **not** the absolute count of workflows in
 * storage. A UI computing "page 1 of N" from `total` will see the page count
 * for the active filter; the unfiltered population is intentionally not
 * surfaced through this response, since recovering it would require a separate
 * full scan that defeats the purpose of the filter fast path.
 */
export function paginateWorkflowSummaries(
  items: WorkflowSummary[],
  filter?: ListFilter,
): PaginatedResult<WorkflowSummary> {
  return paginateItems(items, filter);
}

export function paginateItems<T>(
  items: T[],
  filter: PaginationFilter | undefined,
): PaginatedResult<T> {
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? items.length;
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}

export function normalizeValueForEncodedComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValueForEncodedComparison(entry));
  }

  if (!isPlainObjectRecord(value)) {
    return value;
  }

  const normalizedRecord: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    normalizedRecord[key] = normalizeValueForEncodedComparison(value[key]);
  }

  return normalizedRecord;
}

export function encodedValuesEqual(left: unknown, right: unknown): boolean {
  const leftEncoded = encode(normalizeValueForEncodedComparison(left));
  const rightEncoded = encode(normalizeValueForEncodedComparison(right));

  if (leftEncoded.byteLength !== rightEncoded.byteLength) {
    return false;
  }

  for (let index = 0; index < leftEncoded.byteLength; index++) {
    if (leftEncoded[index] !== rightEncoded[index]) {
      return false;
    }
  }

  return true;
}

export function matchesScheduleFilter(
  state: ScheduleState,
  filter: ScheduleFilter | undefined,
): boolean {
  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(state.status)) return false;
  }
  return filter?.workflowType === undefined || state.workflowType === filter.workflowType;
}

export function paginateScheduleSummaries(
  items: ScheduleSummary[],
  filter?: ScheduleFilter,
): PaginatedResult<ScheduleSummary> {
  const sortedItems = items.toSorted((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }

    return left.id.localeCompare(right.id);
  });

  return paginateItems(sortedItems, filter);
}

export function createScheduleTimerId(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

export function createTerminalCleanupTimerId(
  includeOutputArtifacts: boolean,
  terminalCleanupToken: string,
): string {
  return includeOutputArtifacts
    ? `${FULL_TERMINAL_CLEANUP_TIMER_PREFIX}${terminalCleanupToken}`
    : `${PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX}${terminalCleanupToken}`;
}

export function parseTerminalCleanupTimerId(
  timerId: string,
): { includeOutputArtifacts: boolean; terminalCleanupToken: string } | null {
  const parseTerminalCleanupToken = (prefix: string): string | null => {
    const token = timerId.slice(prefix.length);
    return token.length === 0 ? null : token;
  };

  if (timerId.startsWith(FULL_TERMINAL_CLEANUP_TIMER_PREFIX)) {
    const terminalCleanupToken = parseTerminalCleanupToken(FULL_TERMINAL_CLEANUP_TIMER_PREFIX);
    return terminalCleanupToken === null
      ? null
      : { includeOutputArtifacts: true, terminalCleanupToken };
  }

  if (timerId.startsWith(PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX)) {
    const terminalCleanupToken = parseTerminalCleanupToken(
      PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX,
    );
    return terminalCleanupToken === null
      ? null
      : { includeOutputArtifacts: false, terminalCleanupToken };
  }

  return null;
}

export function clearScheduleCurrentWorkflow(state: ScheduleState): ScheduleState {
  const { currentWorkflowId: _currentWorkflowId, ...rest } = state;
  return rest;
}
