/**
 * Worker-side helper that turns a `workflows` map into the qualified-name
 * activity table the RemoteWorker advertises and dispatches against.
 *
 * Protocol v2 (Phase 4) shifted activity advertisements from bare activity
 * names to `${workflowType}.${activityName}` qualified names. This module owns
 * the worker-side normalization:
 *
 *   - the outer map key is canonical — if `workflow.name` disagrees with the
 *     key, throw immediately (same rule as the engine-side `Engine.create({
 *     workflows })`).
 *   - workflow names and activity keys are validated through the shared
 *     `validateWorkflowOrActivityName` helper so a `.` in either name is
 *     rejected at construction time, not in the middle of a task dispatch.
 *   - the resulting table keys every activity under
 *     `${workflowType}.${activityName}`, which is exactly the string the
 *     server matches against the `RegisterMessage.activities` array.
 *
 * Bare function activities and `{ execute }` objects are both accepted, matching
 * the engine-side `activities()` builder contract.
 *
 * @module worker/workflow-activity-binding
 */

import { validateWorkflowOrActivityName } from '../core/types/name-grammar.ts';
import type { RemoteActivityContext } from './remote-activity-context.ts';

/**
 * An activity implementation accepted by the worker-side `workflows` map.
 *
 * Returns a `Promise<unknown>` to match `executeWithInterceptors`. Sync
 * activities can return `Promise.resolve(...)` or be declared `async`.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerActivityFunction } from '@lostgradient/weft';
 *
 * const formatGreeting: RemoteWorkerActivityFunction = async (input) =>
 *   `hi ${String((input as { name: string }).name)}`;
 * ```
 */
export type RemoteWorkerActivityFunction = (
  input: unknown,
  context?: RemoteActivityContext,
) => Promise<unknown>;

/**
 * Either a bare function or an `{ execute }` object — same shape the engine
 * accepts when normalising a builder's `.activities({ ... })` map.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerActivityImplementation } from '@lostgradient/weft';
 *
 * const bare: RemoteWorkerActivityImplementation = async () => 'a';
 * const shaped: RemoteWorkerActivityImplementation = { execute: async () => 'b' };
 * ```
 */
export type RemoteWorkerActivityImplementation =
  | RemoteWorkerActivityFunction
  | { execute: RemoteWorkerActivityFunction };

/**
 * Minimal workflow shape the worker SDK consumes from a `workflows` map. Only
 * `name` and `activities` are read; the rest of the engine-side definition is
 * irrelevant to dispatch.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerWorkflowDefinition } from '@lostgradient/weft';
 *
 * const welcome: RemoteWorkerWorkflowDefinition = {
 *   name: 'welcome',
 *   activities: { formatGreeting: async () => 'hi' },
 * };
 * ```
 */
export type RemoteWorkerWorkflowDefinition = {
  name: string;
  activities: Record<string, RemoteWorkerActivityImplementation>;
};

/**
 * Build a flat `qualifiedName → executor` table from a `workflows` map.
 *
 * Throws if any workflow's `name` disagrees with the outer key, or if any
 * workflow/activity name fails the wire-safe grammar.
 *
 * @example
 * ```ts
 * import { buildQualifiedActivityTable } from '@lostgradient/weft';
 *
 * const table = buildQualifiedActivityTable({
 *   welcome: {
 *     name: 'welcome',
 *     activities: {
 *       formatGreeting: async (input) =>
 *         `hi ${String((input as { name: string }).name)}`,
 *     },
 *   },
 * });
 * // table['welcome.formatGreeting'] is the bound executor.
 * ```
 */
export function buildQualifiedActivityTable(
  workflows: Record<string, RemoteWorkerWorkflowDefinition>,
): Record<string, RemoteWorkerActivityFunction> {
  const table: Record<string, RemoteWorkerActivityFunction> = {};
  for (const [key, workflow] of Object.entries(workflows)) {
    if (workflow.name !== key) {
      throw new Error(
        `Worker workflow map key "${key}" does not match workflow.name "${workflow.name}"`,
      );
    }
    validateWorkflowOrActivityName(key, 'workflow');
    for (const [activityKey, implementation] of Object.entries(workflow.activities)) {
      validateWorkflowOrActivityName(activityKey, 'activity');
      const qualifiedName = `${key}.${activityKey}`;
      table[qualifiedName] = resolveActivityExecutor(implementation, qualifiedName);
    }
  }
  return table;
}

function resolveActivityExecutor(
  implementation: RemoteWorkerActivityImplementation,
  qualifiedName: string,
): RemoteWorkerActivityFunction {
  if (typeof implementation === 'function') return implementation;
  if (
    implementation === null ||
    typeof implementation !== 'object' ||
    typeof (implementation as { execute?: unknown }).execute !== 'function'
  ) {
    throw new TypeError(
      `Activity "${qualifiedName}" must be a function or an object with a callable "execute" method`,
    );
  }
  return implementation.execute;
}
