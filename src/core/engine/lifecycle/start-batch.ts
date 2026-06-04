import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { serializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import { buildTimerBatchOperations } from '../../scheduler.ts';
import { buildIndexOperations, validateAttributeType } from '../../search-attributes.ts';
import type {
  Checkpoint,
  SearchAttributeValue,
  StartOptions,
  TimerEntry,
  WorkflowState,
} from '../../types.ts';
import { buildWorkflowTagIndexOperations } from '../../workflow-tags.ts';
import { validateAttributeValueSizes } from '../attributes-tags.ts';
import type { EngineInternals } from '../internals.ts';
import { encodeWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowVisibilityIndexOperations } from '../workflow-indexes.ts';
import { EMPTY_STORAGE_VALUE, type LifecycleCallbacks, type RegistrationEntry } from './shared.ts';

export function buildStartBatchOperations(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  options: StartOptions | undefined,
  executionDeadline: number | undefined,
  delayedStartTimer: TimerEntry | undefined,
  workflowStartHeaders: Map<string, string> | undefined,
  additionalOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
): BatchOperation[] {
  const visibilityIndexOperations = buildWorkflowVisibilityIndexOperations(
    workflowId,
    null,
    state,
  ).batchOps;
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
    {
      type: 'put',
      key: KEYS.checkpoint(workflowId),
      value: serializeCheckpoint(checkpoint),
    },
    ...visibilityIndexOperations,
    ...buildWorkflowTagIndexOperations(workflowId, undefined, state.tags),
    ...buildInitialSearchAttributeOperations(
      _internals,
      workflowId,
      registration,
      options?.searchAttributes,
      callbacks,
    ),
    ...buildPerRunScratchOperations(workflowId, options, workflowStartHeaders),
    ...(additionalOperations ?? []),
  ];

  // Fold deadline timer operations into the same batch so workflows with
  // an execution timeout don't pay for a second storage transaction.
  // Uses the shared helper so key format stays in sync with Scheduler.
  if (executionDeadline !== undefined) {
    operations.push(
      ...buildTimerBatchOperations({
        id: `deadline:${workflowId}`,
        workflowId,
        fireAt: executionDeadline,
        kind: 'execution-deadline',
      }),
    );
  }

  if (delayedStartTimer) {
    operations.push(...buildTimerBatchOperations(delayedStartTimer));
  }

  return operations;
}

/**
 * Durable per-run scratch written at start: start headers, the presence-only
 * "expects services" marker, and the `terminalCleanupNeeded` flag.
 *
 * The services marker's value is never written — only this presence bit, so a
 * fresh-process recovery can tell a run that lost its services on crash apart
 * from one that never had any (which must recover without consulting the
 * resolver). Writing it in this batch (not a separate write after) keeps it
 * atomic with the rest of start, closing the crash window it exists to close.
 *
 * `terminalCleanupNeeded` is written whenever the run leaves ANY durable scratch
 * the synchronous in-memory completion path does not sweep — headers and the
 * services marker both qualify. It is the durable trigger for the deferred
 * `cleanupWorkflowStorage` pass; without it a services-only run (no headers,
 * signals, or forks) would leak its marker forever.
 */
function buildPerRunScratchOperations(
  workflowId: string,
  options: StartOptions | undefined,
  workflowStartHeaders: Map<string, string> | undefined,
): BatchOperation[] {
  const hasHeaders = workflowStartHeaders !== undefined && workflowStartHeaders.size > 0;
  const hasServices = options?.services !== undefined;

  const operations: BatchOperation[] = [];
  if (hasHeaders) {
    operations.push({
      type: 'put',
      key: KEYS.workflowHeaders(workflowId),
      value: encodeWorkflowStartHeaders(workflowStartHeaders),
    });
  }
  if (hasServices) {
    operations.push({
      type: 'put',
      key: KEYS.workflowHasServices(workflowId),
      value: EMPTY_STORAGE_VALUE,
    });
  }
  if (hasHeaders || hasServices) {
    operations.push({
      type: 'put',
      key: KEYS.terminalCleanupNeeded(workflowId),
      value: EMPTY_STORAGE_VALUE,
    });
  }
  return operations;
}

export function buildInitialSearchAttributeOperations(
  _internals: EngineInternals,
  workflowId: string,
  registration: RegistrationEntry,
  searchAttributes: StartOptions['searchAttributes'],
  callbacks: LifecycleCallbacks,
): BatchOperation[] {
  if (!searchAttributes || Object.keys(searchAttributes).length === 0) {
    return [];
  }

  validateSearchAttributes(_internals, registration, searchAttributes, callbacks);
  validateAttributeValueSizes(searchAttributes);

  return [
    {
      type: 'put',
      key: KEYS.attribute(workflowId),
      value: encode(searchAttributes),
    },
    ...buildIndexOperations(workflowId, {}, searchAttributes),
  ];
}

export function validateSearchAttributes(
  _internals: EngineInternals,
  registration: RegistrationEntry,
  searchAttributes: Record<string, SearchAttributeValue>,
  _callbacks: LifecycleCallbacks,
): void {
  if (!registration.searchAttributes) {
    return;
  }

  const schema = registration.searchAttributes;
  for (const [key, value] of Object.entries(searchAttributes)) {
    if (!(key in schema)) {
      throw new Error(
        `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
      );
    }
    validateAttributeType(key, value, schema[key]!);
  }
}
