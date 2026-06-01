/**
 * Workflow constraint primitive.
 *
 * Constraints are domain invariants registered alongside a workflow. The
 * engine evaluates them at every checkpoint commit. When a constraint's
 * `check` function returns `false`, the engine dispatches a
 * {@link ConstraintViolatedEvent} and reacts according to `onViolation`:
 *
 * - `'fail'`       — immediately fails the workflow; saga compensators do NOT run.
 * - `'compensate'` — throws into the generator so an active `ctx.saga()`
 *                    can run its compensators before the error propagates.
 * - `'warn'`       — logs a warning and continues execution.
 *
 * @module core/constraint
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reaction to a violated {@link ConstraintDefinition}. `'fail'` immediately
 * fails the workflow without running saga compensators; `'compensate'`
 * throws into the workflow generator so an active `ctx.saga()` can run its
 * compensators in reverse before the error propagates; `'warn'` logs and
 * continues. Returned from `onViolation` on every constraint definition.
 *
 * @example
 * ```ts
 * import type { ConstraintViolation } from '@lostgradient/weft';
 *
 * const policy: ConstraintViolation = 'compensate';
 * void policy;
 * ```
 */
export type ConstraintViolation = 'compensate' | 'fail' | 'warn';

/**
 * The minimal state snapshot passed to a constraint's `check` function.
 *
 * Only `id`, `type`, and `status` (`'running'`) are available — constraints
 * are evaluated mid-execution, before the workflow has a result or final
 * status. To inspect external state (e.g. a balance), capture it in the
 * enclosing scope instead of relying on this parameter.
 */
export interface ConstraintCheckState {
  id: string;
  type: string;
  status: 'running';
}

/**
 * Domain invariant evaluated at every workflow checkpoint commit. Build via
 * the {@link constraint} factory function and attach to a workflow with the
 * builder's `.constraints(...)` step (or via `WorkflowDefinition.constraints`
 * on a hand-rolled definition). When `check` returns `false` the engine reacts
 * per `onViolation` and emits a {@link ConstraintViolatedEvent}.
 *
 * @example
 * ```ts
 * import { constraint, Engine, workflow, type ConstraintDefinition } from '@lostgradient/weft';
 *
 * let balance = 0;
 * const positiveBalance: ConstraintDefinition = constraint({
 *   name: 'positiveBalance',
 *   scope: 'transaction',
 *   check: () => balance >= 0,
 *   onViolation: 'compensate',
 * });
 *
 * const transfer = workflow({ name: 'transfer', constraints: [positiveBalance] })
 *   .execute(async function* () { return 'done'; });
 *
 * const engine = new Engine();
 * engine.register(transfer);
 * void engine;
 * ```
 *
 * **Worker execution caveat**: constraints attached to a workflow are only
 * evaluated under the inline execution strategy. When
 * `EngineOptions.workerExecution` is configured, constraint evaluation is
 * silently skipped.
 */
export interface ConstraintDefinition {
  name: string;
  /** Domain label for observability (e.g. 'transaction', 'budget'). */
  scope: string;
  /**
   * Return `true` when the invariant holds, `false` when it is violated.
   *
   * The `state` parameter is a {@link ConstraintCheckState} — always
   * `{ id: string; type: string; status: 'running' }`. To check external
   * state (e.g. a balance from your own closure), capture it in the
   * enclosing scope instead:
   *
   * ```ts
   * let balance = 0;
   * const balanceCheck = constraint({
   *   name: 'positiveBalance',
   *   scope: 'transaction',
   *   check: () => balance >= 0,
   *   onViolation: 'compensate',
   * });
   * ```
   *
   * The function may be async — returning `Promise<boolean>` is supported.
   *
   * **Note**: Constraints are only evaluated when using the inline execution
   * strategy. Workflows running in a Web Worker will silently skip constraint
   * evaluation. Document this on your registration if using worker execution.
   */
  check: (state: ConstraintCheckState) => boolean | Promise<boolean>;
  /**
   * Reaction when the constraint is violated.
   *
   * - `'fail'`       — immediately fails the workflow without running any
   *                    `ctx.saga()` compensators. Use this for hard invariants
   *                    where partial rollback would be unsafe or meaningless.
   * - `'compensate'` — throws into the workflow generator so an active
   *                    `ctx.saga()` can catch the error, run its compensators
   *                    in reverse, and then re-throw. Use this when you have
   *                    compensating actions registered that need to execute.
   * - `'warn'`       — logs a warning and continues execution.
   */
  onViolation: ConstraintViolation;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a constraint definition.
 *
 * Constraints are domain invariants evaluated at every checkpoint commit.
 * Capture external state in the enclosing scope — the `state` parameter
 * passed to `check` is always a minimal `{ id, type, status }` snapshot.
 *
 * @example
 * ```ts
 * import { constraint, Engine } from '@lostgradient/weft';
 *
 * let balance = 0;
 *
 * const positiveBalance = constraint({
 *   name: 'positiveBalance',
 *   scope: 'transaction',
 *   check: () => balance >= 0,
 *   onViolation: 'compensate',
 * });
 *
 * const engine = new Engine();
 * // engine.register(workflow, { constraints: [positiveBalance] });
 * ```
 */
export function constraint(definition: ConstraintDefinition): ConstraintDefinition {
  return definition;
}
