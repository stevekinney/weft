import type { StartOptions } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * `services` is a non-serializable per-run value read inline as `ctx.services`.
 * It cannot cross to a Worker, so reject it early under worker execution mode.
 */
export function assertServicesSupportedForMode(
  internals: EngineInternals,
  options: StartOptions | undefined,
): void {
  if (options?.services !== undefined && internals.inlineStrategy === null) {
    throw new Error(
      'options.services is only supported in inline execution mode; it cannot be ' +
        'serialized to a Worker. Remove services or use workflowExecutionMode: "inline".',
    );
  }
}
