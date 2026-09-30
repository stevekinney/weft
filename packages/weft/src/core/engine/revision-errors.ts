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

import type { WorkflowCompatibilityReason } from '../contract/compatibility.ts';
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
 * - `reason: 'not-installed'` — thrown at commit-time ADMISSION, not
 *   recovery, for either a fresh `start()` or a checkpoint-backed failed-run
 *   `retryFailedAll()` reactivation (WFT-17/WFT-18 Codex review on PR #958):
 *   the resolved (or pinned) revision's durable catalog entry was
 *   concurrently removed — `removeWorkflowRevision()` racing a `start()` on
 *   a DIFFERENT process under a lease ownership mode, or racing a
 *   `retryFailedAll()` on ANY process/mode, since a failed run contributes no
 *   `inFlightStartsByRevision` reservation of its own — between this
 *   process resolving the revision and that commit batch actually landing.
 *   Fails the one call outright — never retried inside the engine — so the
 *   caller re-issues it, which re-resolves against whatever is actually
 *   still installed.
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
          ? `Cannot admit workflow type "${workflowType}": revision` +
            `${revision === undefined ? '' : ` "${revision}"`} is no longer installed in the ` +
            'durable catalog (removed concurrently). Retry the operation.'
          : `Cannot recover workflow type "${workflowType}": its pinned revision` +
            `${revision === undefined ? '' : ` "${revision}"`} is not registered in this ` +
            'process. Register the exact revision this run started against before retrying.',
    );
    this.workflowType = workflowType;
    this.revision = revision;
    this.reason = reason;
  }
}

/** Why {@link EagerRecoveryRevisionRefusedError} refused a recovery. */
export type EagerRecoveryRefusalReason =
  'incompatible' | 'persisted-revision-not-installed' | 'registered-revision-unknown';

/**
 * Thrown by the resume/recovery path when an EAGER-registered type's run
 * cannot be re-bound to the definition this process registered (COR-13).
 *
 * Recovery of an eager type runs whatever definition the current process
 * registered. When the run's persisted `WorkflowState.revision` differs from
 * the registered revision, `checkWorkflowCompatibility()` is consulted with
 * `{ requireExactRevision: false }`: a compatible verdict re-stamps the run's
 * revision, anything else refuses with this error before any state is written.
 *
 * - `reason: 'incompatible'` - the persisted and registered manifests differ
 *   in a way the policy forbids; `compatibilityReasons` is the ordered list.
 * - `reason: 'persisted-revision-not-installed'` - the durable catalog has no
 *   entry for the run's persisted revision.
 * - `reason: 'registered-revision-unknown'` - the registered eager type's
 *   revision cannot be resolved: this process has no catalog revision recorded
 *   for it, or the recorded revision has no durable catalog entry (fail
 *   closed). `registeredRevision` is populated when a revision was known.
 *
 * `engine.resume(id)` rejects with it; `engine.recoverAll()` rethrows it and
 * aborts the batch. `RecoverAllOptions.versionMismatchPolicy` does not apply.
 *
 * @example
 * ```ts
 * import { Engine, EagerRecoveryRevisionRefusedError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.resume('workflow-id');
 * } catch (err) {
 *   if (err instanceof EagerRecoveryRevisionRefusedError) {
 *     console.error(err.persistedRevision, err.registeredRevision, err.reason);
 *   }
 * }
 * ```
 */
export class EagerRecoveryRevisionRefusedError extends WeftError<'EagerRecoveryRevisionRefusedError'> {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly persistedRevision: string;
  readonly registeredRevision: string | undefined;
  readonly reason: EagerRecoveryRefusalReason;
  readonly compatibilityReasons: readonly WorkflowCompatibilityReason[];

  constructor(details: {
    workflowId: string;
    workflowType: string;
    persistedRevision: string;
    registeredRevision: string | undefined;
    reason: EagerRecoveryRefusalReason;
    compatibilityReasons?: readonly WorkflowCompatibilityReason[];
  }) {
    super(
      'EagerRecoveryRevisionRefusedError',
      `Cannot recover workflow "${details.workflowId}" of type "${details.workflowType}": ` +
        (details.reason === 'incompatible'
          ? `registered revision "${details.registeredRevision}" is not compatible with persisted revision "${details.persistedRevision}" (${(details.compatibilityReasons ?? []).join(', ')}).`
          : details.reason === 'persisted-revision-not-installed'
            ? `persisted revision "${details.persistedRevision}" is not installed in the durable catalog.`
            : details.registeredRevision === undefined
              ? `no registered revision is known for the eager type in this process (persisted revision "${details.persistedRevision}").`
              : `registered revision "${details.registeredRevision}" could not be resolved from the durable catalog (persisted revision "${details.persistedRevision}").`),
    );
    this.workflowId = details.workflowId;
    this.workflowType = details.workflowType;
    this.persistedRevision = details.persistedRevision;
    this.registeredRevision = details.registeredRevision;
    this.reason = details.reason;
    this.compatibilityReasons = details.compatibilityReasons ?? [];
  }
}
