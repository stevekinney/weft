import { KEYS, storageHas } from '../../../storage/interface.ts';
import { EventLog } from '../../event-log.ts';
import type { ComposedWorkflowInterceptor } from '../../interceptor.ts';
import { coerceStartWorkflowTags } from '../../start-workflow-validation.ts';
import type {
  WorkflowServicesResolverLaunchOptions,
  WorkflowServicesResolverScheduleInfo,
} from '../../types.ts';
import { normalizeWorkflowTags } from '../../workflow-tags.ts';
import type { QueuedInlineWorkflowExecutionStart } from '../engine-internal-types.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { loadWorkflowStartHeaders as loadWorkflowStartHeadersFromStorage } from '../storage-io.ts';

export type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

export const FORK_LINEAGE_ATTRIBUTE = 'weft:forkedFrom';

export const EMPTY_STORAGE_VALUE = new Uint8Array(0);

/**
 * Durable run context passed to {@link RecoverAllOptions.onRecoveredWorkflow}
 * before recovered user code advances.
 *
 * @example
 * ```ts
 * import type { RecoveredWorkflowInfo } from '@lostgradient/weft';
 *
 * function registerSurface(info: RecoveredWorkflowInfo): void {
 *   console.log(`Recovered ${info.workflowType}/${info.workflowId}`);
 * }
 * ```
 */
export interface RecoveredWorkflowInfo {
  /** Handle for the recovered run. */
  handle: WorkflowHandle;
  workflowId: string;
  workflowType: string;
  input: unknown;
  launchOptions: WorkflowServicesResolverLaunchOptions;
  schedule?: WorkflowServicesResolverScheduleInfo;
  /** Re-provided host services, or `undefined` when the run did not use services. */
  services: unknown;
}

/**
 * Options for {@link Engine.recoverAll}. The acknowledgement flag is an
 * explicit escape hatch for deployments that intentionally skip stored
 * workflows whose type is not registered on this engine.
 *
 * @example
 * ```ts
 * import { Engine, type RecoverAllOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const options: RecoverAllOptions = { acknowledgeUnknownWorkflowTypes: true };
 * await engine.recoverAll(options);
 * ```
 */
export type RecoverAllOptions = {
  /**
   * Skip stored running workflows whose type is not registered. Use only for
   * rolling deploys or explicit operator storage repair.
   */
  acknowledgeUnknownWorkflowTypes?: boolean;
  /**
   * Register consumer-owned live state for each recovered run after services
   * are re-provided but before the workflow generator advances. The callback is
   * awaited. If it throws, only that run fails with a `system` failure and
   * recovery continues with its siblings.
   */
  onRecoveredWorkflow?: (info: RecoveredWorkflowInfo) => void | Promise<void>;
};

export type LifecycleCallbacks = {
  dispatchEvent: (event: Event) => void;
  getHandle: (workflowId: string) => WorkflowHandle;
  createWorkflowHandleWithResultPromise: (workflowId: string) => WorkflowHandle;
  runSerializedWorkflowStateWrite: (workflowId: string, fn: () => Promise<void>) => Promise<void>;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
  resolveWorkflowTypeTarget: (target: string | Function) => string;
  processPendingUpdatesAfterReplay: (workflowId: string) => void;
  processPendingUpdatesAfterInlineAdvance: (workflowId: string) => Promise<void>;
  processPendingUpdatesForHandlers: (workflowId: string) => Promise<void>;
  queueInlineWorkflowExecutionStart: (start: QueuedInlineWorkflowExecutionStart) => void;
  isInlineWorkflowLocallyOwned: (workflowId: string, workflowStatus: string) => boolean;
  hasLocalCheckpointOwnership: (workflowId: string, workflowStatus: string) => boolean;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
  /**
   * Force the workflow to a terminal `timed-out` state because its persisted
   * event-log record count breached the history circuit-breaker threshold.
   * Invoked by {@link enforceHistoryPolicyBeforeReplay} so an already-oversized
   * history is terminated without being replayed.
   */
  enforceHistoryCircuitBreaker: (workflowId: string) => Promise<void>;
  /**
   * Force a recovered workflow to a terminal `failed` state because its
   * non-serialized `services` could not be re-provided (the engine's
   * `resolveWorkflowServices` reported `unavailable`). Fails just this run with
   * a `system` failure category; the engine and other recovered runs continue.
   * `error` is the canonical {@link unavailableServicesError}.
   */
  failWorkflowForUnavailableServices: (workflowId: string, error: Error) => Promise<void>;
  /** Fail one recovered workflow whose pre-resume consumer hook threw. */
  failWorkflowForRecoveryHook: (workflowId: string, error: Error) => Promise<void>;
  /**
   * Force a recovered workflow to a terminal `failed` state because its
   * persisted checkpoint cannot be decoded on this runtime. The failure is
   * isolated to the affected run so `recoverAll()` can continue recovering
   * other workflows from the same storage backend.
   */
  failWorkflowForCheckpointDecodeError: (workflowId: string, error: Error) => Promise<void>;
};

/**
 * Pre-replay history circuit breaker. Called at every restore-from-checkpoint
 * entry point immediately after the persisted event-log head is loaded and
 * before replay. When `maxEvents` is configured and the workflow's durable
 * event-log record count (`head.sequence + 1`) exceeds it, force the workflow
 * to a terminal `timed-out` state and return `true` so the caller skips replay.
 * Returns `false` (and does nothing) when the circuit breaker is disabled or
 * the limit is not breached.
 */
export async function enforceHistoryPolicyBeforeReplay(
  internals: EngineInternals,
  workflowId: string,
  head: { sequence: number },
  callbacks: Pick<LifecycleCallbacks, 'enforceHistoryCircuitBreaker'>,
): Promise<boolean> {
  const maxEvents = internals.options.historyPolicy.maxEvents;
  if (maxEvents === null || head.sequence + 1 <= maxEvents) {
    return false;
  }
  await callbacks.enforceHistoryCircuitBreaker(workflowId);
  return true;
}

/**
 * {@link enforceHistoryPolicyBeforeReplay} for callers that have not already
 * loaded the event-log head. Resolves the head from the engine's in-memory map
 * (present for workflows this instance already tracks, e.g. locally-owned ones)
 * and falls back to storage. Used by `resume` on its local-ownership paths,
 * which return before reaching `resumeWorkflowFromStorage` (where the head is
 * otherwise loaded for the guard) — without this the circuit breaker would be
 * skipped for a locally-owned workflow left `running` with an oversized history.
 */
export async function enforceHistoryPolicyBeforeReplayById(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<LifecycleCallbacks, 'enforceHistoryCircuitBreaker'>,
): Promise<boolean> {
  if (internals.options.historyPolicy.maxEvents === null) {
    return false;
  }
  const head =
    internals.eventLogHeads.get(workflowId) ??
    (await new EventLog(internals.storage, workflowId).loadHead());
  return enforceHistoryPolicyBeforeReplay(internals, workflowId, head, callbacks);
}

export function createWorkflowHandle(
  _internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<LifecycleCallbacks, 'createWorkflowHandleWithResultPromise'>,
): WorkflowHandle {
  return callbacks.createWorkflowHandleWithResultPromise(workflowId);
}

export function setWorkflowStartHeaders(
  internals: EngineInternals,
  workflowId: string,
  headers: Map<string, string> | undefined,
  _callbacks: LifecycleCallbacks,
): void {
  if (!headers || headers.size === 0) {
    internals.workflowHeaders.delete(workflowId);
    return;
  }

  internals.workflowHeaders.set(workflowId, new Map(headers));
  internals.workflowsNeedingTerminalCleanup.add(workflowId);
}

export async function loadWorkflowStartHeaders(
  internals: EngineInternals,
  workflowId: string,
  _callbacks: LifecycleCallbacks,
): Promise<Map<string, string> | undefined> {
  return loadWorkflowStartHeadersFromStorage(internals, workflowId);
}

export async function loadTerminalCleanupTrackedState(
  internals: EngineInternals,
  workflowId: string,
  _callbacks: LifecycleCallbacks,
): Promise<void> {
  if (await storageHas(internals.storage, KEYS.terminalCleanupNeeded(workflowId))) {
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
  }
}

export function normalizeStartWorkflowTags(
  _internals: EngineInternals,
  tags: unknown,
  fieldName: string | undefined,
  _callbacks: LifecycleCallbacks,
): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  return normalizeWorkflowTags(coerceStartWorkflowTags(tags, fieldName ?? 'options.tags'));
}

export async function processPendingUpdatesAfterReplay(
  _internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<LifecycleCallbacks, 'handleCleanupError' | 'processPendingUpdatesForHandlers'>,
): Promise<void> {
  try {
    await callbacks.processPendingUpdatesForHandlers(workflowId);
  } catch (error: unknown) {
    callbacks.handleCleanupError('processPendingUpdates', error, workflowId);
  }
}
