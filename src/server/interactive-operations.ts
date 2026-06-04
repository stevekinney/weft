/**
 * The interactively-used subset of operations that MUST carry a longer-form
 * `description` (in addition to the mandatory `summary` that every operation
 * has). These are the operations a human or agent reaches for directly:
 * workflow lifecycle control, schedule CRUD, review handling, and worker
 * control. The remaining operations (raw storage, bulk mutations, diagnostics,
 * internal metrics) may omit `description`.
 *
 * This list is the single source of truth consumed by
 * `scripts/check-catalog-completeness.ts`. Update it together with the
 * operations it names.
 *
 * @module server/interactive-operations
 */

/** Operation names that must declare a `description`. */
export const INTERACTIVE_OPERATION_NAMES: ReadonlyArray<string> = [
  // Workflow lifecycle
  'weft.workflows.start',
  'weft.workflows.get',
  'weft.workflows.list',
  'weft.workflows.signal',
  'weft.workflows.query',
  'weft.workflows.update',
  'weft.workflows.cancel',
  'weft.workflows.timeout',
  'weft.workflows.resume',
  'weft.workflows.suspend',
  'weft.workflows.replay',
  // Schedule CRUD
  'weft.schedules.create',
  'weft.schedules.get',
  'weft.schedules.list',
  'weft.schedules.update',
  'weft.schedules.cancel',
  'weft.schedules.pause',
  'weft.schedules.resume',
  // Reviews
  'weft.reviews.list',
  'weft.reviews.get',
  'weft.reviews.decision.submit',
  // Worker control
  'weft.workers.list',
  'weft.workers.drain',
];

const INTERACTIVE_OPERATION_SET: ReadonlySet<string> = new Set(INTERACTIVE_OPERATION_NAMES);

/** Whether the named operation must declare a longer-form `description`. */
export function isInteractiveOperation(name: string): boolean {
  return INTERACTIVE_OPERATION_SET.has(name);
}
