import type { AtomicState, AtomicStateOptions } from '../atomic-state.ts';

/**
 * Admin-facing factories for storage-backed {@link AtomicState} handles.
 * Workflow code should prefer `ctx.state.*`; external maintenance and
 * administrative code can use `engine.state.*` with explicit scope inputs.
 *
 * @example
 * ```ts
 * import { Engine, type EngineStateNamespace } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const state: EngineStateNamespace = engine.state;
 * const counter = state.workflow<number>('invoice', 'count', { initial: 0 });
 * void counter;
 * ```
 */
export interface EngineStateNamespace {
  execution<T>(
    ownerWorkflowId: string,
    key: string,
    options?: AtomicStateOptions<T>,
  ): AtomicState<T>;
  workflow<T>(workflowType: string, key: string, options?: AtomicStateOptions<T>): AtomicState<T>;
}
