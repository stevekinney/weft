import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { isRecord, safeDebugStringify, sanitizeDebugValueForDisplay } from '../debug-output.ts';
import { encodeAttributeValue } from '../search-attributes.ts';
import type {
  AttributeFilter,
  AttributeFilterScalarValue,
  ListFilter,
  PaginatedResult,
  ScheduleFilter,
  ScheduleState,
  ScheduleSummary,
  SearchAttributeValue,
  TimeRange,
  WorkflowState,
  WorkflowSummary,
} from '../types.ts';
import { searchAttributeName } from '../types.ts';
import { matchesWorkflowTagFilter } from '../workflow-tags.ts';
import { stripInternalCheckpointReplayPayload } from './checkpoint-replay.ts';
import { isPlainObjectRecord, isSanitizedSearchAttributeValue } from './validation.ts';

const PERSISTED_WORKFLOW_START_HEADER_NAMES = new Set(['traceparent', 'tracestate']);

const PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX = 'terminal-cleanup:preserve-output:';

const FULL_TERMINAL_CLEANUP_TIMER_PREFIX = 'terminal-cleanup:full:';

const TEARDOWN_TIMER_PREFIX = 'teardown:';

/**
 * Durable execution-claim record stored at {@link KEYS.teardownOwed} for a workflow
 * that owes an engine-driven finalizer run (issue #446 Phase 2). A holder fenced-CAS's
 * it from `'owed'` to `'running'` before invoking the finalizer, then back to `'owed'`
 * (with `attempts` bumped) on a retryable failure, or deletes it on success/dead-letter.
 *
 * Liveness is decided by TIME, not by an in-memory set or a lease epoch: a `'running'`
 * claim is reclaimable once `claimedAt` is older than the stale threshold (the
 * finalizer's per-attempt timeout plus a margin — see `teardownStaleThresholdMs`). This
 * makes crash recovery an ordinary stale-claim retry with no special re-hydration: a
 * fresh process simply re-fires the surviving timer and reclaims the stale `'running'`
 * marker. The cost is that a finalizer running past the threshold may be re-driven
 * concurrently, which is why workflow finalizers must be idempotent.
 *
 * - `status`: `'owed'` until claimed, `'running'` while a holder is executing it.
 * - `attempts`: count of finalizer attempts so far (`0` until the first claim).
 * - `token`: ties the marker to its `wf-teardown:` timer so a stale timer for a
 *   re-armed (different-token) claim cannot drive it.
 * - `claimedAt`: engine clock at the `owed → running` transition; `undefined` while
 *   `'owed'`. Drives the time-based reclaim of an abandoned `'running'` claim.
 */
export type TeardownClaim = {
  status: 'owed' | 'running';
  attempts: number;
  token: string;
  claimedAt?: number;
};

/** Build the durable teardown timer id from its claim token (parsed by {@link parseTeardownTimerId}). */
export function createTeardownTimerId(token: string): string {
  return `${TEARDOWN_TIMER_PREFIX}${token}`;
}

/** Recover the claim token from a teardown timer id, or `null` when the id is malformed. */
export function parseTeardownTimerId(timerId: string): string | null {
  if (!timerId.startsWith(TEARDOWN_TIMER_PREFIX)) {
    return null;
  }
  const token = timerId.slice(TEARDOWN_TIMER_PREFIX.length);
  return token.length === 0 ? null : token;
}

/**
 * Runtime type guard for a decoded {@link TeardownClaim} read back from storage.
 *
 * `attempts` must be a non-negative SAFE INTEGER and `claimedAt` (when present) a
 * finite non-negative number — not merely `typeof === 'number'`. A persisted `NaN`
 * or `Infinity` would otherwise drive the marker forever: `attempt >= MAX_TEARDOWN_ATTEMPTS`
 * is always false for `NaN` (never dead-letters) and `now - claimedAt >= threshold` never
 * holds for a non-finite `claimedAt` (never reclaims a stale running claim). Rejecting them
 * here routes a corrupt-but-claim-shaped marker through the clear path instead. `claimedAt`
 * is checked with `isFinite` rather than `isSafeInteger` because `getNow()` may return a
 * fractional timestamp.
 */
export function isTeardownClaim(value: unknown): value is TeardownClaim {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate['status'] === 'owed' || candidate['status'] === 'running') &&
    typeof candidate['token'] === 'string' &&
    isNonNegativeSafeInteger(candidate['attempts']) &&
    isAbsentOrFiniteNonNegative(candidate['claimedAt'])
  );
}

/** A non-negative safe integer — the valid shape for a teardown claim's `attempts`. */
function isNonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Absent, or a finite non-negative number — the valid shape for `claimedAt`. Finite
 * (not safe-integer) because `getNow()` may return a fractional timestamp.
 */
function isAbsentOrFiniteNonNegative(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

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
    case 'get-version':
      return operation.changeId;
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
    case 'get-version':
      return summarizeTimelineValue({
        changeId: operation.changeId,
        minSupported: operation.minSupported,
        maxSupported: operation.maxSupported,
        version: operation.version,
      });
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
  return isRecord(sanitized)
    ? stripInternalCheckpointReplayPayload(sanitized)
    : { value: sanitized };
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
    (filter.parentWorkflowId === undefined || state.parentWorkflowId === filter.parentWorkflowId) &&
    (filter.parentWorkflowExecutionToken === undefined ||
      state.parentWorkflowExecutionToken === filter.parentWorkflowExecutionToken) &&
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

export function listFilterHasAttributeFilters(filter: ListFilter | undefined): boolean {
  return (filter?.attributes?.length ?? 0) > 0;
}

function isSearchAttributeFilterValue(value: unknown): value is SearchAttributeValue {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function decodeSearchAttributeRecord(
  attributeBytes: Uint8Array | null,
): Record<string, SearchAttributeValue> | null {
  if (attributeBytes === null) return null;

  const decoded = decode(attributeBytes);
  if (!isPlainObjectRecord(decoded)) return null;

  const attributes: Record<string, SearchAttributeValue> = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (isSearchAttributeFilterValue(value)) {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function attributeFilterExactValues(
  filter: AttributeFilter,
): readonly AttributeFilterScalarValue[] | null {
  if (filter.value === undefined) return null;
  if (Array.isArray(filter.value)) return [...filter.value];
  return [filter.value];
}

function storedAttributeScalarValues(
  value: SearchAttributeValue,
): readonly AttributeFilterScalarValue[] {
  return Array.isArray(value) ? value : [value];
}

function attributeValuesEqual(
  actual: AttributeFilterScalarValue,
  expected: AttributeFilterScalarValue,
): boolean {
  if (actual instanceof Date || expected instanceof Date) {
    return (
      actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime()
    );
  }

  return actual === expected;
}

function attributeValueMatchesAnyOf(
  actual: SearchAttributeValue,
  expectedValues: readonly AttributeFilterScalarValue[],
): boolean {
  if (expectedValues.length === 0) return false;

  for (const actualValue of storedAttributeScalarValues(actual)) {
    if (expectedValues.some((expectedValue) => attributeValuesEqual(actualValue, expectedValue))) {
      return true;
    }
  }
  return false;
}

function encodedAttributeValueSatisfiesRange(
  encodedValue: string,
  filter: AttributeFilter,
): boolean {
  if (filter.gte !== undefined && encodedValue < encodeAttributeValue(filter.gte)) return false;
  if (filter.gt !== undefined && encodedValue <= encodeAttributeValue(filter.gt)) return false;
  if (filter.lte !== undefined && encodedValue > encodeAttributeValue(filter.lte)) return false;
  if (filter.lt !== undefined && encodedValue >= encodeAttributeValue(filter.lt)) return false;
  return true;
}

function attributeValueMatchesRange(value: SearchAttributeValue, filter: AttributeFilter): boolean {
  for (const scalarValue of storedAttributeScalarValues(value)) {
    if (encodedAttributeValueSatisfiesRange(encodeAttributeValue(scalarValue), filter)) {
      return true;
    }
  }
  return false;
}

function matchesAttributeFilter(
  searchAttributes: Readonly<Record<string, SearchAttributeValue>>,
  filter: AttributeFilter,
): boolean {
  const attributeValue = searchAttributes[searchAttributeName(filter.key)];
  if (attributeValue === undefined) return false;

  const exactValues = attributeFilterExactValues(filter);
  if (exactValues !== null) {
    return attributeValueMatchesAnyOf(attributeValue, exactValues);
  }

  return attributeValueMatchesRange(attributeValue, filter);
}

function matchesListFilterAttributes(
  searchAttributes: Readonly<Record<string, SearchAttributeValue>> | null | undefined,
  filter: ListFilter,
): boolean {
  if (!listFilterHasAttributeFilters(filter)) return true;
  if (searchAttributes === null || searchAttributes === undefined) return false;

  return filter.attributes!.every((attributeFilter) =>
    matchesAttributeFilter(searchAttributes, attributeFilter),
  );
}

export function matchesListFilter(
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
  searchAttributes?: Readonly<Record<string, SearchAttributeValue>> | null,
): boolean {
  if (constrainedIds !== null && !constrainedIds.has(state.id)) return false;
  if (!matchesWorkflowTagFilter(state.tags, normalizedTagFilters)) return false;
  if (filter === undefined) return true;
  if (!matchesListFilterIdentity(state, filter)) return false;
  if (!matchesListFilterTimeRanges(state, filter)) return false;
  if (!matchesListFilterFailureCategory(state, filter)) return false;
  if (!matchesListFilterAttributes(searchAttributes, filter)) return false;
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
