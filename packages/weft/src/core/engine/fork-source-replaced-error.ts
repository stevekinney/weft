/**
 * {@link ForkSourceReplacedError} (WFT-21, Codex review, item 6) — split
 * into its own module, mirroring `revision-errors.ts`'s
 * {@link import('./revision-errors.ts').WorkflowRevisionUnavailableError},
 * to keep `errors.ts` under the repository's 500-line implementation-file
 * ceiling.
 *
 * @module core/engine/fork-source-replaced-error
 */

import { WeftError } from '../weft-error.ts';

/**
 * Thrown by {@link Engine.fork} when the SOURCE run is replaced by a
 * concurrent `start(..., { id: sourceWorkflowId, onTerminalConflict:
 * 'start-new' })` between `fork()`'s own read of the source's
 * `WorkflowState` and either (a) loading and hydrating the source
 * checkpoint it forks from, or (b) the fork's own commit — both windows
 * involve unavoidable async work (a dynamic-source resolver load, header
 * lookups, lineage construction) a replacement could land inside. Without
 * this check, a version-compatible replacement landing in either window
 * could let the fork commit against a MIX of the two generations — the
 * original run's type/input, but a checkpoint or commit-time state
 * belonging to the replacement — since `derivePreparedExecutionState()`'s
 * own version-compatibility gate has no way to tell the two generations
 * apart when their versions are compatible. `fork()` now correlates
 * `sourceState.workflowExecutionToken` against the loaded checkpoint's own
 * token immediately after hydration, and revalidates it again by
 * re-reading `WorkflowState` immediately before the commit; either check
 * finding a mismatch rejects the fork outright rather than risk committing
 * a mixed-generation run. The caller re-issues `fork()`, which reads the
 * replacement's own current state fresh.
 *
 * @example
 * ```ts
 * import { Engine, ForkSourceReplacedError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.fork('source-workflow-id');
 * } catch (err) {
 *   if (err instanceof ForkSourceReplacedError) {
 *     console.error('source was replaced mid-fork:', err.sourceWorkflowId);
 *   }
 * }
 * ```
 */
export class ForkSourceReplacedError extends WeftError<'ForkSourceReplacedError'> {
  readonly sourceWorkflowId: string;

  constructor(sourceWorkflowId: string) {
    super(
      'ForkSourceReplacedError',
      `Cannot fork workflow "${sourceWorkflowId}": its source run was replaced by a ` +
        'concurrent start-new before the fork could commit. Retry the fork against the ' +
        'replacement.',
    );
    this.sourceWorkflowId = sourceWorkflowId;
  }
}
