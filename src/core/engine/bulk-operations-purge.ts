import type { BatchOperation, Storage as WeftStorage } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  storageHas,
  storageKeys,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type {
  ListFilter,
  NormalizedRetentionPolicy,
  PurgeResult,
  SearchAttributeValue,
  WorkflowState,
} from '../types.ts';
import { buildWorkflowTagIndexOperations, normalizeWorkflowTags } from '../workflow-tags.ts';
import { asyncActivityWorkflowPrefix } from './async-activity-records.ts';
import { forgetCommittedCheckpointBytes } from './checkpoint-commit-snapshots.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { streamWorkflowStates } from './listing.ts';
import { decodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';
import {
  decodeWorkflowState,
  isTerminalWorkflowStatus,
  resolveRetentionForStatus,
} from './validation.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

export const TERMINAL_CLEANUP_DELAY_MS = 60_000;

export type PurgeParameters = {
  expiredOnly: boolean;
  now: number;
  limit?: number;
};

export type CleanupWaiters = (workflowId: string) => void;

export async function purgeInternal(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  parameters: PurgeParameters,
  cleanupWaiters: CleanupWaiters,
): Promise<PurgeResult> {
  const { effectiveLimit, manualOffset } = resolvePurgeWindow(internals, filter, parameters.limit);

  if (effectiveLimit === 0) return { deleted: 0 };

  let remainingOffset = manualOffset;
  let deleted = 0;

  const workflowStateStream =
    parameters.expiredOnly && filter === undefined
      ? streamExpiredRetentionWorkflowStates(internals, parameters.now)
      : streamWorkflowStates(internals, filter);

  for await (const state of workflowStateStream) {
    if (
      !(await shouldPurgeWorkflowState(internals, state, parameters.expiredOnly, parameters.now))
    ) {
      continue;
    }

    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    await purgeWorkflow(internals, state, cleanupWaiters);
    deleted += 1;

    if (effectiveLimit !== undefined && deleted >= effectiveLimit) {
      break;
    }
  }

  return { deleted };
}

function getMinimumRetentionMs(internals: EngineInternals): number | null {
  let minimumRetentionMs: number | null = null;

  const considerRetentionPolicy = (policy: NormalizedRetentionPolicy | null | undefined): void => {
    for (const retentionMs of [
      policy?.completed,
      policy?.failed,
      policy?.cancelled,
      policy?.timedOut,
    ]) {
      if (retentionMs === undefined) continue;

      minimumRetentionMs =
        minimumRetentionMs === null ? retentionMs : Math.min(minimumRetentionMs, retentionMs);
    }
  };

  considerRetentionPolicy(internals.options.retention);
  for (const registration of internals.registrations.values()) {
    considerRetentionPolicy(registration.retention);
  }

  return minimumRetentionMs;
}

async function* streamExpiredRetentionWorkflowStates(
  internals: EngineInternals,
  now: number,
): AsyncGenerator<WorkflowState> {
  const minimumRetentionMs = getMinimumRetentionMs(internals);
  if (minimumRetentionMs === null) return;

  const terminalWorkflowPrefix = KEYS.terminalWorkflowPrefix();
  const newestPossibleExpiredUpdatedAt = now - minimumRetentionMs;
  const upperBound = `${terminalWorkflowPrefix}${String(newestPossibleExpiredUpdatedAt).padStart(16, '0')}:\xff`;

  for await (const [key] of internals.storage.scan(terminalWorkflowPrefix, {
    lte: upperBound,
  })) {
    const encodedWorkflowId = key.slice(key.lastIndexOf(':') + 1);
    const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
    if (workflowId === null) continue;

    const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) {
      await internals.storage.delete(key);
      continue;
    }

    const state = decodeWorkflowState(stateBytes);
    if (!isTerminalWorkflowStatus(state.status)) continue;

    yield state;
  }
}

function resolvePurgeWindow(
  _internals: EngineInternals,
  filter: ListFilter | undefined,
  fallbackLimit: number | undefined,
): { effectiveLimit: number | undefined; manualOffset: number } {
  return {
    manualOffset: normalizePurgeOffset(filter?.offset),
    effectiveLimit: resolvePurgeLimit(normalizePurgeLimit(filter?.limit), fallbackLimit),
  };
}

function normalizePurgeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset)) return 0;
  if (offset <= 0) return 0;
  return Math.floor(offset);
}

function normalizePurgeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return undefined;
  if (limit < 0) return undefined;
  return Math.floor(limit);
}

function resolvePurgeLimit(
  manualLimit: number | undefined,
  fallbackLimit: number | undefined,
): number | undefined {
  if (manualLimit === undefined) return fallbackLimit;
  if (fallbackLimit === undefined) return manualLimit;
  return Math.min(manualLimit, fallbackLimit);
}

async function shouldPurgeWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
  expiredOnly: boolean,
  now: number,
): Promise<boolean> {
  if (!isTerminalWorkflowStatus(state.status)) return false;

  // A workflow that still owes an engine-driven finalizer (#446) must not be
  // purged: purge deletes the `finalizerState` payload the finalizer needs as its
  // input, so purging first would silently abandon the teardown of a paid external
  // resource — the exact leak #446 prevents. The finalizer deletes this marker on
  // success or when it dead-letters, which is what unblocks purge. The dead-letter
  // record (`teardownDeadLetter`) is deliberately NOT a gate — it is a terminal
  // audit trail, not outstanding work, and is excluded from the purge delete-set.
  if (await storageHas(internals.storage, KEYS.teardownOwed(state.id))) return false;

  if (!expiredOnly) return true;

  const deadline = getWorkflowRetentionDeadline(internals, state);
  return deadline !== null && deadline <= now;
}

function getWorkflowRetentionDeadline(
  internals: EngineInternals,
  state: WorkflowState,
): number | null {
  if (!isTerminalWorkflowStatus(state.status)) return null;

  const policy = internals.registrations.get(state.type)?.retention ?? internals.options.retention;
  const retentionMs = resolveRetentionForStatus(policy, state.status);
  if (retentionMs === undefined) return null;

  return state.updatedAt + retentionMs;
}

export async function purgeWorkflow(
  internals: EngineInternals,
  state: WorkflowState,
  cleanupWaiters: CleanupWaiters,
): Promise<void> {
  const deleteOperations = await collectWorkflowPurgeDeleteOperations(internals, state);
  await commitFencedEngineWrite(
    internals,
    deleteOperations,
    [],
    () => new Error(`Purge commit for workflow "${state.id}" lost its precondition.`),
  );
  clearPurgedWorkflowInMemoryState(internals, state.id, cleanupWaiters);
}

/**
 * Collect every storage delete operation that removing a workflow id entails —
 * index deletes (search attributes + tags), the explicit key set (state,
 * checkpoint, headers, services marker, update requests/responses, and the
 * `wf:`/`ev:`/`sig:`/... prefix sweeps), and the visibility-index transition to
 * `null`. Pure: it reads storage to discover keys but writes nothing, so a caller
 * can fold the returned ops into a larger atomic batch instead of committing them
 * standalone. {@link purgeWorkflow} commits them on their own; the
 * `onTerminalConflict: 'start-new'` restart path prepends them to the create batch
 * so purge-and-recreate land as one atomic unit (no window where the prior run is
 * gone but the new one has not committed). Keep this the single source of truth
 * for "what a purge deletes" — do not fork the delete-set.
 */
export async function collectWorkflowPurgeDeleteOperations(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<BatchOperation[]> {
  const workflowId = state.id;
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const deleteOperations = buildWorkflowIndexDeleteOperations(state, attributeBytes);
  const deleteKeys = await collectWorkflowPurgeDeleteKeys(internals, state);
  appendKeyDeleteOperations(deleteOperations, deleteKeys);
  deleteOperations.push(
    ...buildWorkflowVisibilityIndexTransition(workflowId, state, null).batchOps,
  );
  return deleteOperations;
}

/**
 * Drop every in-memory cache entry a purged workflow id owns (checkpoints,
 * heartbeat details, event-log heads, version tuples, handle cache, result
 * resolvers, headers, nesting depths, type map, pending async activities) and run
 * `cleanupWaiters` to settle any pending signal/update/sleep waiters. Split from
 * the storage batch in {@link collectWorkflowPurgeDeleteOperations} so the restart
 * path can clear the OLD run's in-memory state up front — before the new run's
 * caches are written under the reused id — while the durable delete still commits
 * atomically with the create.
 */
export function clearPurgedWorkflowInMemoryState(
  internals: EngineInternals,
  workflowId: string,
  cleanupWaiters: CleanupWaiters,
): void {
  forgetCommittedCheckpointBytes(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.heartbeatDetails.delete(workflowId);
  internals.lastHeartbeatDetailsByStep.delete(workflowId);
  for (const [token, pending] of internals.pendingAsyncActivities) {
    if (pending.workflowId === workflowId) {
      internals.pendingAsyncActivities.delete(token);
    }
  }
  internals.pendingAsyncActivityResolutions.delete(workflowId);
  internals.eventLogHeads.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.handleCache.delete(workflowId);
  internals.resultResolvers.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowNestingDepths.delete(workflowId);
  internals.workflowTypeByWorkflowId.delete(workflowId);
  cleanupWaiters(workflowId);
}

function buildWorkflowIndexDeleteOperations(
  state: WorkflowState,
  attributeBytes: Uint8Array | null,
): BatchOperation[] {
  return [
    ...buildSearchAttributeDeleteOperations(state.id, attributeBytes),
    ...buildTagIndexDeleteOperations(state),
  ];
}

function buildSearchAttributeDeleteOperations(
  workflowId: string,
  attributeBytes: Uint8Array | null,
): BatchOperation[] {
  if (!attributeBytes) return [];
  const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
  return buildIndexOperations(workflowId, currentAttributes, {}).filter(isDeleteOperation);
}

function buildTagIndexDeleteOperations(state: WorkflowState): BatchOperation[] {
  return buildWorkflowTagIndexOperations(
    state.id,
    normalizeWorkflowTags(state.tags),
    undefined,
  ).filter(isDeleteOperation);
}

function isDeleteOperation(operation: BatchOperation): operation is BatchOperation {
  return operation.type === 'delete';
}

async function collectWorkflowPurgeDeleteKeys(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<Set<string>> {
  const workflowId = state.id;
  const deleteKeys = buildBaseWorkflowDeleteKeys(state);
  addExecutionDeadlineDeleteKeys(deleteKeys, state);
  addTerminalCleanupDeleteKey(deleteKeys, state);
  await addScheduleRunHistoryDeleteKeys(internals.storage, deleteKeys, workflowId);
  await addUpdateRequestDeleteKeys(internals.storage, deleteKeys, workflowId);
  await addWorkflowPrefixDeleteKeys(internals.storage, deleteKeys, workflowId);
  return deleteKeys;
}

async function addScheduleRunHistoryDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const linkKey = KEYS.scheduleRunLink(workflowId);
  const linkBytes = await storage.get(linkKey);
  deleteKeys.add(linkKey);
  if (linkBytes === null) return;

  const metadata = decodeScheduleRunMetadata(linkBytes);
  if (metadata !== null) {
    deleteKeys.add(KEYS.scheduleRunBySchedule(metadata.id, workflowId));
  }
}

function buildBaseWorkflowDeleteKeys(state: WorkflowState): Set<string> {
  return new Set([
    KEYS.workflow(state.id),
    KEYS.checkpoint(state.id),
    KEYS.workflowHeaders(state.id),
    KEYS.terminalCleanupNeeded(state.id),
    KEYS.workflowConcurrencyHolder(state.id),
    KEYS.scheduleRun(state.id),
    // The "expects services" marker lives under its own `wf-has-services:`
    // prefix (not `wf:{id}:`), so the prefix sweep below misses it. Delete it
    // explicitly, else a purge + id reuse leaves a stale marker that would make
    // recovery re-provision services for a run that never had them.
    KEYS.workflowHasServices(state.id),
    // The finalizer payload (`wf-finalizer-state:`) and the teardown-owed marker
    // (`wf-teardown-needed:`) live under their own prefixes, not `wf:{id}:`, so the
    // prefix sweep below misses them — delete them explicitly. Purge only reaches a
    // workflow once teardown is done (`shouldPurgeWorkflowState` gates on the owed
    // marker being absent), so by here these are normally already gone; including
    // them is the idempotent backstop for any residue. The dead-letter record
    // (`wf-teardown-deadletter:`) is intentionally NOT listed — it is the durable
    // operator trail for a leaked resource and must outlive purge.
    KEYS.finalizerState(state.id),
    KEYS.teardownOwed(state.id),
    // Successful finalizer outcomes belong to the purged run. Dead-letter records
    // intentionally remain as leak evidence and are run-token qualified on read.
    KEYS.teardownSucceeded(state.id),
    KEYS.attribute(state.id),
    KEYS.terminalWorkflow(state.updatedAt, state.id),
  ]);
}

function addExecutionDeadlineDeleteKeys(deleteKeys: Set<string>, state: WorkflowState): void {
  if (state.executionDeadline === undefined) return;
  deleteKeys.add(KEYS.deadline(state.executionDeadline, state.id));
  deleteKeys.add(`timer-idx:deadline:${state.id}`);
}

function addTerminalCleanupDeleteKey(deleteKeys: Set<string>, state: WorkflowState): void {
  if (state.terminalCleanupToken === undefined) return;
  const terminalCleanupTimerId = createTerminalCleanupTimerId(
    shouldCleanupTerminalOutputArtifacts(state),
    state.terminalCleanupToken,
  );
  deleteKeys.add(
    KEYS.terminalCleanup(state.updatedAt + TERMINAL_CLEANUP_DELAY_MS, terminalCleanupTimerId),
  );
}

function shouldCleanupTerminalOutputArtifacts(state: WorkflowState): boolean {
  return state.status === 'cancelled' || state.status === 'timed-out';
}

async function addUpdateRequestDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const updateRequestPrefix = KEYS.updatePrefix(workflowId);
  const updateRequestKeys = await collectKeysForPrefix(storage, updateRequestPrefix);
  for (const key of updateRequestKeys) {
    deleteKeys.add(key);
    addUpdateResponseDeleteKey(deleteKeys, updateRequestPrefix, key);
  }
}

function addUpdateResponseDeleteKey(
  deleteKeys: Set<string>,
  updateRequestPrefix: string,
  updateRequestKey: string,
): void {
  const updateId = updateRequestKey.slice(updateRequestPrefix.length);
  if (updateId.length > 0) deleteKeys.add(KEYS.updateResponse(updateId));
}

async function addWorkflowPrefixDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  for (const prefix of workflowPurgePrefixes(workflowId)) {
    const keys = await collectKeysForPrefix(storage, prefix);
    for (const key of keys) deleteKeys.add(key);
  }
  await addWorkflowLinkedFleetEventDeleteKeys(storage, deleteKeys, workflowId);
}

async function addWorkflowLinkedFleetEventDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const prefix = KEYS.fleetEventByWorkflowPrefix(workflowId);
  for await (const [key] of storage.scan(prefix)) {
    deleteKeys.add(key);
    const sequence = parseFleetEventSequenceFromWorkflowIndexKey(prefix, key);
    if (sequence !== null) deleteKeys.add(KEYS.fleetEvent(sequence));
  }
}

function parseFleetEventSequenceFromWorkflowIndexKey(prefix: string, key: string): number | null {
  if (!key.startsWith(prefix)) return null;
  const rawSequence = key.slice(prefix.length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function workflowPurgePrefixes(workflowId: string): string[] {
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);
  return [
    `wf:${encodedWorkflowId}:ckpt:`,
    // Compacted-checkpoint timeline entries (`wf:{id}:timeline:{step}`). These
    // are read back during checkpoint reconstruction (checkpoint-reads.ts), so a
    // stale entry left behind after purge would let a reused id — e.g. an
    // `onTerminalConflict: 'start-new'` restart — read the prior run's timeline.
    `wf:${encodedWorkflowId}:timeline:`,
    `ev:${encodedWorkflowId}:`,
    `sig:${encodedWorkflowId}:`,
    `review:${encodedWorkflowId}:`,
    `offload:${encodedWorkflowId}:`,
    `archive:${encodedWorkflowId}:`,
    `blob:${encodedWorkflowId}:`,
    `state:execution:${encodedWorkflowId}:`,
    `tool-effect:${encodedWorkflowId}:`,
    `upk:${encodedWorkflowId}:`,
    `actrec:v1:${encodedWorkflowId}:`,
    asyncActivityWorkflowPrefix(workflowId),
    `sigres:v1:${encodedWorkflowId}:`,
  ];
}

function appendKeyDeleteOperations(
  deleteOperations: BatchOperation[],
  deleteKeys: Iterable<string>,
): void {
  for (const key of deleteKeys) deleteOperations.push({ type: 'delete', key });
}

async function collectKeysForPrefix(storage: WeftStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) keys.push(key);
  return keys;
}
