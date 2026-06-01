import type { Checkpoint, SearchAttributeValue, Serializer, WorkflowId } from '../types.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION } from '../types/checkpoint.ts';
import { serializeCheckpoint } from './serialization.ts';

/**
 * Create a fresh checkpoint for a new workflow.
 *
 * @example
 * ```ts
 * import { createCheckpoint } from '@lostgradient/weft';
 *
 * const checkpoint = createCheckpoint('wf-789', '1.0.0');
 * console.log(checkpoint.workflowId); // 'wf-789'
 * console.log(checkpoint.step);       // 0
 * console.log(checkpoint.version);    // '1.0.0'
 * ```
 */
export function createCheckpoint(
  workflowId: WorkflowId,
  version: string,
  now?: number,
): Checkpoint {
  return {
    workflowId,
    step: 0,
    locals: {},
    accumulatedResults: [],
    pendingSignals: [],
    searchAttributes: {},
    version,
    schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
    createdAt: now ?? Date.now(),
  };
}

/**
 * Advance a checkpoint to the next step with new locals.
 *
 * @example
 * ```ts
 * import { createCheckpoint, advanceCheckpoint } from '@lostgradient/weft';
 *
 * const checkpoint = createCheckpoint('wf-abc', '1.0.0');
 * const next = advanceCheckpoint(checkpoint, { userId: 'u-1', status: 'active' });
 * console.log(next.step);            // 1
 * console.log(next.locals['userId']);   // 'u-1'
 * ```
 */
export function advanceCheckpoint(
  checkpoint: Checkpoint,
  locals: Record<string, unknown>,
  options?: {
    searchAttributes?: Record<string, SearchAttributeValue>;
    accumulatedResults?: Array<[number, unknown]>;
    now?: number;
  },
): Checkpoint {
  return {
    workflowId: checkpoint.workflowId,
    step: checkpoint.step + 1,
    locals,
    accumulatedResults: options?.accumulatedResults ?? checkpoint.accumulatedResults,
    ...(checkpoint.workerReplaySignatures === undefined
      ? {}
      : { workerReplaySignatures: checkpoint.workerReplaySignatures }),
    ...(checkpoint.workerReplayFailures === undefined
      ? {}
      : { workerReplayFailures: checkpoint.workerReplayFailures }),
    pendingSignals: checkpoint.pendingSignals,
    searchAttributes: {
      ...checkpoint.searchAttributes,
      ...options?.searchAttributes,
    },
    version: checkpoint.version,
    schemaVersion: checkpoint.schemaVersion,
    createdAt: options?.now ?? Date.now(),
  };
}

/**
 * Get the serialized size of a checkpoint in bytes.
 *
 * @example
 * ```ts
 * import { createCheckpoint, advanceCheckpoint, checkpointSizeBytes } from '@lostgradient/weft';
 *
 * const cp = advanceCheckpoint(
 *   createCheckpoint('wf-size', '1.0.0'),
 *   { items: Array.from({ length: 100 }, (_, i) => i) },
 * );
 * const bytes = checkpointSizeBytes(cp);
 * console.log(bytes > 0); // true
 * ```
 */
export function checkpointSizeBytes(checkpoint: Checkpoint, serializer?: Serializer): number {
  return serializeCheckpoint(checkpoint, serializer).byteLength;
}
