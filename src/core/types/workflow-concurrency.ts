type WorkflowConcurrencyKeyResolver<TInput> = {
  resolve(input: TInput): string;
}['resolve'];

/**
 * Workflow-level start admission policy. When present on a workflow definition,
 * the engine admits at most `max` non-terminal runs for the same partition.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowConcurrencyOptions } from '@lostgradient/weft';
 *
 * type OrderInput = { customerId: string };
 *
 * const concurrency: WorkflowConcurrencyOptions<OrderInput> = {
 *   max: 3,
 *   key: (input) => input.customerId,
 * };
 *
 * const processOrder = workflow({ name: 'process-order', concurrency }).execute(
 *   async function* () {
 *     return 'done';
 *   },
 * );
 * void processOrder;
 * ```
 */
export interface WorkflowConcurrencyOptions<TInput = unknown> {
  /**
   * Maximum number of non-terminal runs admitted for the workflow type or
   * partition key. Excess starts are rejected immediately.
   */
  max: number;
  /**
   * Optional partition key resolver. When omitted, the limit applies to the
   * workflow type as a whole.
   */
  key?: WorkflowConcurrencyKeyResolver<TInput>;
}
