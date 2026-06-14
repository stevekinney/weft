/**
 * Constant scope for workflow-type-shared durable state (single source of truth;
 * never inline the literal). Keys live under `state:workflow-scope:` —
 * deliberately distinct from the retired `state:workflow:<tenantId>:` prefix so
 * that a tenant id which happened to equal a scope name can never alias into
 * this namespace (the current key never starts with `state:workflow:`).
 * Re-partitioning the scope is therefore a key rename, not a data rewrite. See
 * `KEYS.stateWorkflow` in `./interface.ts`, pinned by the alias test in
 * `../core/atomic-state.test.ts`.
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
