/**
 * {@link WorkflowRevisionUnavailableError} (WFT-17/WFT-18) — thrown by
 * {@link import('./dynamic-source-execution.ts').resolveExecutableRegistrationForRevision}
 * when a resumed run's persisted, EXACT pinned `WorkflowState.revision` cannot
 * be resolved in this process. Distinct from
 * {@link import('./dynamic-source-errors.ts').DynamicWorkflowSourceUnavailableError},
 * which covers a dynamic source whose ACTIVE revision is ambiguous or fails
 * to load — this error instead covers "the run's own pin cannot be honored",
 * which can also happen for a legacy (pre-revision-pinning) record on a
 * dynamic source with two or more registered candidates, where there is no
 * pin at all and the ambiguity cannot be resolved by falling back to
 * whichever revision happens to be active (that fallback is exactly the bug
 * this batch closes — see `documentation/guides/recovery-and-deploys.md`).
 *
 * @module core/engine/revision-errors
 */

import { WeftError } from '../weft-error.ts';

/**
 * Thrown when a workflow run's pinned {@link import('../types/state.ts').WorkflowState.revision}
 * cannot be resolved to an executable registration in this process:
 *
 * - `reason: 'not-registered'` — the run pins a specific revision (a
 *   dynamic-source candidate this process has never `registerSource()`-registered,
 *   including the case where the pin no longer matches a dynamic source's sole
 *   remaining candidate).
 * - `reason: 'legacy-ambiguous'` — the run predates revision pinning (no
 *   `revision` was ever persisted for it) and its type is a dynamic source
 *   with two or more registered candidates, so there is no way to tell which
 *   one it actually started against.
 * - `reason: 'not-installed'` — thrown at FRESH START admission, not
 *   recovery: under a lease ownership mode, the resolved revision's durable
 *   catalog entry was concurrently removed (`removeWorkflowRevision()` on a
 *   different process) between this process resolving it and the start
 *   batch's own commit. Fails the one `start()` call outright — never
 *   retried inside the engine — so the caller re-issues `start()`, which
 *   re-resolves against whatever is actually still installed.
 *
 * `engine.recoverAll()` classifies the affected `(type, revision)` group
 * `unavailable`: only the runs in that group fail (with this error as their
 * `system` failure cause, delivered via `failWorkflow()`/`onRecoveredWorkflow`,
 * never thrown to `recoverAll()`'s own caller); sibling groups — including
 * OTHER revisions of the same dynamic-source type — continue recovering
 * normally. A standalone `engine.resume(workflowId)` call has no such
 * isolation to fall back on — there is only the one run — so it throws this
 * error directly to its caller instead.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionUnavailableError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.resume('workflow-id');
 * } catch (err) {
 *   if (err instanceof WorkflowRevisionUnavailableError) {
 *     console.error(err.workflowType, err.revision, err.reason);
 *   }
 * }
 * ```
 */
export class WorkflowRevisionUnavailableError extends WeftError<'WorkflowRevisionUnavailableError'> {
  readonly workflowType: string;
  readonly revision: string | undefined;
  readonly reason: 'not-registered' | 'legacy-ambiguous' | 'not-installed';

  constructor(
    workflowType: string,
    revision: string | undefined,
    reason: 'not-registered' | 'legacy-ambiguous' | 'not-installed',
  ) {
    super(
      'WorkflowRevisionUnavailableError',
      reason === 'legacy-ambiguous'
        ? `Cannot recover workflow type "${workflowType}": this run predates revision ` +
            'pinning and the type is a dynamic source with multiple registered revisions, ' +
            'so which one it started against cannot be determined.'
        : reason === 'not-installed'
          ? `Cannot start workflow type "${workflowType}": revision` +
            `${revision === undefined ? '' : ` "${revision}"`} is no longer installed in the ` +
            'durable catalog (removed concurrently by another process). Retry the start.'
          : `Cannot recover workflow type "${workflowType}": its pinned revision` +
            `${revision === undefined ? '' : ` "${revision}"`} is not registered in this ` +
            'process. Register the exact revision this run started against before retrying.',
    );
    this.workflowType = workflowType;
    this.revision = revision;
    this.reason = reason;
  }
}
