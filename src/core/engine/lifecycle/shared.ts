import { KEYS, storageHas } from '../../../storage/interface.ts';
import type { ComposedWorkflowInterceptor } from '../../interceptor.ts';
import { coerceStartWorkflowTags } from '../../start-workflow-validation.ts';
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
 * Options for {@link Engine.recoverAll}. The acknowledgement flag is an
 * explicit escape hatch for deployments that intentionally skip stored
 * workflows whose type is not registered on this engine.
 *
 * @example
 * ```ts
 * import { Engine, type RecoverAllOptions } from 'weft';
 *
 * const engine = new Engine();
 * const options: RecoverAllOptions = { acknowledgeUnknownWorkflowTypes: true };
 * await engine.recoverAll(options);
 * ```
 */
export type RecoverAllOptions = {
  /**
   * Skip stored running workflows whose type is not registered. Use only for
   * rolling deploys or explicit storage migrations.
   */
  acknowledgeUnknownWorkflowTypes?: boolean;
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
};

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
