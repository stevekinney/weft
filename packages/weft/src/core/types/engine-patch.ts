import type { EngineOptions } from './options.ts';

/**
 * The {@link EngineOptions} that {@link Engine.reconfigure} can change on a running engine. Every
 * other option is bound when the engine is constructed. A key that is absent, or present with
 * the value `undefined`, is left as it is.
 *
 * @example
 * ```ts
 * import type { EnginePatch } from '@lostgradient/weft';
 *
 * const patch: EnginePatch = {
 *   payloadSize: { maxBytes: 1_048_576 },
 *   retentionSweepInterval: '30s',
 * };
 * void patch;
 * ```
 */
export type EnginePatch = Partial<
  Pick<
    EngineOptions,
    | 'retention'
    | 'retentionSweepInterval'
    | 'retentionSweepBatchSize'
    | 'history'
    | 'payloadSize'
    | 'checkpointSizeWarningThreshold'
    | 'schedulerPollIntervalMs'
  >
>;

/**
 * What {@link Engine.reconfigure} returns. It never throws for a patch it cannot apply: the
 * patch is either applied whole or rejected whole.
 *
 * - `applied`: every key in the patch is in force. `applied` holds exactly the keys the patch
 *   carried, with the value now in force: durations are milliseconds, `retentionSweepBatchSize`
 *   is the clamped integer, and the policy keys (`retention`, `history`, `payloadSize`) are
 *   copies of the supplied policy.
 * - `rejected`: nothing was applied and no timer was touched. `keys` names the keys that failed
 *   validation (a key the patch may not carry is named too), and `message` is the validation
 *   error `Engine` would have thrown at construction for the same value.
 *
 * @example
 * ```ts
 * import type { EngineReconfigureResult } from '@lostgradient/weft';
 *
 * function describe(result: EngineReconfigureResult): string {
 *   return result.outcome === 'applied'
 *     ? `applied ${Object.keys(result.applied).join(', ')}`
 *     : `rejected ${result.keys.join(', ')}: ${result.message}`;
 * }
 * void describe;
 * ```
 */
export type EngineReconfigureResult =
  | { readonly outcome: 'applied'; readonly applied: EnginePatch }
  | { readonly outcome: 'rejected'; readonly keys: readonly string[]; readonly message: string };
