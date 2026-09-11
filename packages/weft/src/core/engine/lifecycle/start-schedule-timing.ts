import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowTimestamp,
  StartWorkflowValidationError,
} from '../../start-workflow-validation.ts';
import type { StartOptions } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { type LifecycleCallbacks } from './shared.ts';
import { parseStartOptionDuration } from './start-state.ts';

/**
 * Resolve a start's effective delayed-start timestamp from
 * `options.startAt`/`options.startAfter`, or `undefined` for an immediate
 * start. Split out of `start.ts` to keep that file under the repository's
 * line-count ceiling; this is a pure resolution step with no dependency on
 * `startWorkflow`'s own reservation/commit state.
 */
export function resolveScheduledStartAt(
  internals: EngineInternals,
  options: StartOptions | undefined,
  submissionTime: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  assertExclusiveStartWorkflowOptions(options?.startAt, options?.startAfter);

  if (options?.startAt !== undefined) {
    return coerceStartWorkflowTimestamp(options.startAt, 'options.startAt');
  }

  if (options?.startAfter !== undefined) {
    const startAfterMilliseconds = parseStartOptionDuration(
      internals,
      options.startAfter,
      'options.startAfter',
      callbacks,
    );
    try {
      return normalizeStorageTimestamp(
        submissionTime + startAfterMilliseconds,
        'options.startAfter',
      );
    } catch {
      throw new StartWorkflowValidationError(
        'options.startAfter must resolve to a finite, non-negative start time',
      );
    }
  }

  return undefined;
}
