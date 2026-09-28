/**
 * Construction wiring for `workflowExecutionMode: 'realm'` (COR-249's engine
 * integration). Extracted from `construction.ts` to keep that file under the
 * repository's file-size ceiling, mirroring `WorkerExecutionDisposal`'s own
 * extraction from `WorkerExecutionStrategy` for the same reason.
 *
 * @module core/engine/revision-realm-execution-construction
 */

import { RevisionRealmExecutionStrategy } from '../realm/revision-realm-execution-strategy.ts';
import { RevisionRealmRegistry } from '../realm/revision-realm-registry.ts';
import type { EngineConstructorOptions, ExecutionStrategyBundle } from './engine-internal-types.ts';

/**
 * Resolve `EngineOptions.revisionRealmExecution`, mirroring
 * `resolveWorkerExecutionForMode()`'s exact required/rejected shape for the
 * sibling `workerExecution` option. Called unconditionally by
 * `createExecutionStrategyBundle` (not only for `'realm'` mode) so
 * `options.revisionRealmExecution` provided alongside `'inline'`/`'worker'`/
 * an omitted mode is rejected rather than silently ignored.
 */
export function resolveRevisionRealmExecutionForMode(
  options: EngineConstructorOptions | undefined,
  workflowExecutionMode: EngineConstructorOptions['workflowExecutionMode'],
): NonNullable<EngineConstructorOptions['revisionRealmExecution']> | null {
  if (workflowExecutionMode === 'realm') {
    if (options?.revisionRealmExecution === undefined) {
      throw new Error(
        'options.revisionRealmExecution is required when workflowExecutionMode is "realm"',
      );
    }
    return options.revisionRealmExecution;
  }
  if (options?.revisionRealmExecution !== undefined) {
    throw new Error(
      'options.workflowExecutionMode must be "realm" when options.revisionRealmExecution is provided',
    );
  }
  return null;
}

/**
 * Reject `options.workerExecution` under `workflowExecutionMode: 'realm'` —
 * the same mutual-exclusivity `resolveWorkerExecutionForMode()` applies for
 * every OTHER mode, called here too since `'realm'`'s own branch there
 * returns early and would otherwise skip it. A separate function (rather
 * than one more branch inside `resolveWorkerExecutionForMode`) keeps that
 * function's cyclomatic complexity under the repository's lint ceiling.
 */
export function assertNoWorkerExecutionForRealmMode(
  options: EngineConstructorOptions | undefined,
): void {
  if (options?.workerExecution !== undefined) {
    throw new Error(
      'options.workerExecution cannot be provided when workflowExecutionMode is "realm" ' +
        '(use options.revisionRealmExecution instead)',
    );
  }
}

/**
 * Build the `RevisionRealmExecutionStrategy` bundle when
 * `workflowExecutionMode: 'realm'`, or `null` for every other mode (the
 * caller falls through to its own inline/worker construction in that case).
 */
export function buildRevisionRealmExecutionStrategyBundle(
  options: EngineConstructorOptions | undefined,
  workflowExecutionMode: EngineConstructorOptions['workflowExecutionMode'],
  revisionRealmExecution: NonNullable<EngineConstructorOptions['revisionRealmExecution']> | null,
  getWorkflowRevisionPin: ((workflowId: string) => string | undefined) | undefined,
): ExecutionStrategyBundle | null {
  if (workflowExecutionMode !== 'realm') return null;
  assertNoWorkerExecutionForRealmMode(options);
  // `resolveRevisionRealmExecutionForMode` already throws when this is
  // missing for `workflowExecutionMode: 'realm'` — this narrows the type
  // without a second, differently-worded check.
  if (!revisionRealmExecution) {
    throw new Error(
      'options.revisionRealmExecution is required when workflowExecutionMode is "realm"',
    );
  }
  if (!getWorkflowRevisionPin) {
    throw new Error(
      'createExecutionStrategyBundle: getWorkflowRevisionPin is required for workflowExecutionMode "realm"',
    );
  }
  const revisionRealmRegistry = new RevisionRealmRegistry();
  return {
    strategy: new RevisionRealmExecutionStrategy({
      registry: revisionRealmRegistry,
      resolveRevisionRealmConfig: revisionRealmExecution.resolveRevisionRealmConfig,
      getWorkflowRevisionPin,
    }),
    inlineStrategy: null,
    revisionRealmRegistry,
  };
}
