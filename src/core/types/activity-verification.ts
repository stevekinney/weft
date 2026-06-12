/**
 * Activity verification types: the two-phase verifier contract an activity can
 * declare via {@link ActivityDefinition.verify}. Split out of `activity.ts` to
 * keep that module under the per-file line ceiling; these types are re-exported
 * through `../types.ts` so the public surface is unchanged.
 */

/**
 * Identifies whether an activity verifier is checking a fresh result or
 * reconciling a prior keyed dispatch before redispatch.
 *
 * @example
 * ```ts
 * import type { ActivityVerificationPhase } from '@lostgradient/weft';
 *
 * const phase: ActivityVerificationPhase = 'pre-dispatch-reconciliation';
 * console.log(phase);
 * ```
 */
export type ActivityVerificationPhase = 'post-execution-validation' | 'pre-dispatch-reconciliation';

/**
 * Metadata passed to a Tier-0 activity verifier.
 *
 * @example
 * ```ts
 * import type { ActivityVerificationContext } from '@lostgradient/weft';
 *
 * function shouldQueryExternalSystem(context: ActivityVerificationContext): boolean {
 *   return context.phase === 'pre-dispatch-reconciliation';
 * }
 * ```
 */
export interface ActivityVerificationContext<TInput = unknown> {
  phase: ActivityVerificationPhase;
  workflowId: string;
  activityName: string;
  operationId: string;
  input: TInput;
  idempotencyKey?: string;
  attempt: number;
}

/**
 * Return value for activity verification. Post-execution validation uses a
 * boolean; pre-dispatch reconciliation can report whether a prior keyed side
 * effect completed, did not complete, or is indeterminate.
 *
 * @example
 * ```ts
 * import type { ActivityVerificationResult } from '@lostgradient/weft';
 *
 * const result: ActivityVerificationResult<string> = {
 *   status: 'completed-with-result',
 *   result: 'already-finished',
 * };
 * console.log(result.status);
 * ```
 */
export type ActivityVerificationResult<TOutput = unknown> =
  | boolean
  | 'not-completed'
  | 'completed-result-unavailable'
  | 'indeterminate'
  | { status: 'completed-with-result'; result: TOutput };

export type ActivityPostExecutionVerifier<TOutput = unknown> = {
  bivarianceHack(result: TOutput): Promise<boolean> | boolean;
}['bivarianceHack'];

export type ActivityTier0Verifier<TInput = unknown, TOutput = unknown> = {
  bivarianceHack(
    result: TOutput | undefined,
    context: ActivityVerificationContext<TInput>,
  ): Promise<ActivityVerificationResult<TOutput>> | ActivityVerificationResult<TOutput>;
}['bivarianceHack'];

export type ActivityVerifier<TInput = unknown, TOutput = unknown> =
  | ActivityPostExecutionVerifier<TOutput>
  | ActivityTier0Verifier<TInput, TOutput>;
