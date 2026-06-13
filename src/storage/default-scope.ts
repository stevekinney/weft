/**
 * Constant scope for workflow-type-shared durable state (single source of truth;
 * never inline the literal). Keys live under `state:workflow-scope:` — a
 * namespace deliberately distinct from any per-id `state:workflow:<id>:` key so
 * the two keyspaces can never alias into one another, and re-partitioning the
 * scope is a key rename rather than a data rewrite. See `KEYS.stateWorkflow` in
 * `./interface.ts`.
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
