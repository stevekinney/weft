/**
 * Constant scope for workflow-type-shared durable state (single source of truth;
 * never inline the literal). Keys live under `state:workflow-scope:` — distinct
 * from the legacy `state:workflow:<tenantId>:` layout so a historical tenant id
 * cannot alias in, making a future re-partition a key rename, not a data
 * migration. See `KEYS.stateWorkflow` in `./interface.ts`.
 *
 * Internal leaf module (no imports) so both `./interface.ts` and
 * `../core/atomic-state.ts` can depend on it without an import cycle.
 *
 * @example
 * ```ts
 * import { DEFAULT_SCOPE } from '@lostgradient/weft/storage/interface';
 * console.log(DEFAULT_SCOPE); // 'default'
 * ```
 */
export const DEFAULT_SCOPE = 'default';
