/**
 * Phase 15b — Per-operation REST dispatch-mode resolution.
 *
 * Track 8 migrates REST routes onto the transport-neutral
 * `executeOperation` pipeline one operation at a time, behind a
 * feature flag. A route is either:
 *
 *   - `'legacy'` — dispatches to the hand-rolled `handleXxx` executor
 *     in `handler.ts`. Pre-Milestone-1 behavior.
 *   - `'via-execute-operation'` — dispatches via `RestBinding.extractInput`
 *     → `executeOperation` → `RestBinding.shapeSuccess`. Post-migration
 *     behavior.
 *
 * `ServeOptions.restDispatchMode` accepts three shapes:
 *
 *   - omitted / `undefined` — every operation runs on legacy.
 *   - a bare `'legacy' | 'via-execute-operation'` — that mode applies to
 *     every operation.
 *   - `{ default?, operations? }` — per-operation override, with a
 *     fallback. When `default` is omitted the fallback is `'legacy'`.
 *
 * The resolver is pure — identical inputs always produce identical
 * outputs — which makes the dispatch-mode decision trivial to assert
 * in parity diff tests.
 *
 * @module server/rest-dispatch-mode
 */

/** Dispatch mode for a single REST operation. */
export type RestDispatchMode = 'legacy' | 'via-execute-operation';

/** Config shape for `ServeOptions.restDispatchMode`. */
export type RestDispatchModeConfig =
  | RestDispatchMode
  | {
      /** Default mode applied when `operations[name]` is absent. Defaults to `'legacy'`. */
      readonly default?: RestDispatchMode;
      /** Per-operation overrides keyed by operation name (e.g., `'weft.workflows.get'`). */
      readonly operations?: Readonly<Record<string, RestDispatchMode>>;
    };

/**
 * Resolve the dispatch mode for a single operation. See module-level
 * doc for the three accepted config shapes.
 */
export function resolveRestDispatchMode(
  config: RestDispatchModeConfig | undefined,
  operationName: string,
): RestDispatchMode {
  if (config === undefined) return 'legacy';
  if (typeof config === 'string') return config;
  const override = config.operations?.[operationName];
  if (override !== undefined) return override;
  return config.default ?? 'legacy';
}
