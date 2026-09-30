/**
 * Eager-type recovery revision policy (COR-13).
 *
 * An eagerly registered type always recovers into whatever definition the
 * current process registered, regardless of the run's persisted
 * `WorkflowState.revision`. After a redeploy that changed only documentation
 * (`description` or `tags`), the registered revision (B) differs from the
 * persisted one (A) while the contract is unchanged. This module decides
 * whether recovery may proceed and, if so, performs the durable re-stamp so
 * checkpoints produced after recovery are attributed to B.
 *
 * - {@link resolveEagerRecoveryRestamp} is the read-only check: it returns the
 *   revision to re-stamp, `undefined` for the no-op cases, or throws
 *   {@link EagerRecoveryRevisionRefusedError} before anything is written.
 * - {@link restampWorkflowRevision} is the write, called only from inside the
 *   serialized resume section after the generation guard has passed.
 *
 * @module core/engine/lifecycle/resume-revision-restamp
 */

import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { checkWorkflowCompatibility } from '../../contract/compatibility.ts';
import type { WorkflowState } from '../../types.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import {
  EagerRecoveryRevisionRefusedError,
  type EagerRecoveryRefusalReason,
} from '../revision-errors.ts';

function refuse(
  workflowId: string,
  state: WorkflowState,
  persistedRevision: string,
  registeredRevision: string | undefined,
  reason: EagerRecoveryRefusalReason,
  compatibilityReasons?: EagerRecoveryRevisionRefusedError['compatibilityReasons'],
): never {
  throw new EagerRecoveryRevisionRefusedError({
    workflowId,
    workflowType: state.type,
    persistedRevision,
    registeredRevision,
    reason,
    ...(compatibilityReasons !== undefined && { compatibilityReasons }),
  });
}

/**
 * Decide whether recovering `state` needs a revision re-stamp.
 *
 * Returns the registered revision to re-stamp to (compatible redeploy), or
 * `undefined` when there is nothing to do: a legacy record with no persisted
 * revision, a type that is not eagerly registered, or a persisted revision
 * that already equals the registered one. Throws
 * {@link EagerRecoveryRevisionRefusedError} for an incompatible redeploy, a
 * missing persisted catalog entry, or an unknown registered revision. A catalog
 * read that itself throws (a corrupt entry, a storage fault) propagates
 * unwrapped.
 */
export async function resolveEagerRecoveryRestamp(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
): Promise<string | undefined> {
  const persistedRevision = state.revision;
  if (persistedRevision === undefined || !internals.registrations.has(state.type)) {
    return undefined;
  }
  const registeredRevision = internals.registeredCatalogRevisions.get(state.type);
  if (registeredRevision === persistedRevision) {
    return undefined;
  }
  const catalog = internals.workflowCatalog;
  if (registeredRevision === undefined || catalog === null) {
    return refuse(
      workflowId,
      state,
      persistedRevision,
      registeredRevision,
      'registered-revision-unknown',
    );
  }
  const current = await catalog.resolveEntry(state.type, persistedRevision);
  if (current === undefined) {
    return refuse(
      workflowId,
      state,
      persistedRevision,
      registeredRevision,
      'persisted-revision-not-installed',
    );
  }
  const candidate = await catalog.resolveEntry(state.type, registeredRevision);
  if (candidate === undefined) {
    return refuse(
      workflowId,
      state,
      persistedRevision,
      registeredRevision,
      'registered-revision-unknown',
    );
  }
  const verdict = checkWorkflowCompatibility(current.manifest, candidate.manifest, {
    requireExactRevision: false,
  });
  if (!verdict.compatible) {
    return refuse(
      workflowId,
      state,
      persistedRevision,
      registeredRevision,
      'incompatible',
      verdict.reasons,
    );
  }
  return registeredRevision;
}

/**
 * Re-stamp `latestState.revision` in place. A `running` run gets a dedicated
 * fenced put of its workflow record; a `suspended` run is only mutated here,
 * because the suspended-to-running reactivation that follows in the same
 * serialized section persists this field in its own fenced batch, so the two
 * changes land atomically. The visibility index does not reference `revision`,
 * so no index keys change.
 */
export async function restampWorkflowRevision(
  internals: EngineInternals,
  latestState: WorkflowState,
  revision: string,
): Promise<void> {
  latestState.revision = revision;
  if (latestState.status === 'suspended') {
    return;
  }
  latestState.updatedAt = internals.options.getNow();
  await commitFencedEngineWrite(
    internals,
    latestState.id,
    [{ type: 'put', key: KEYS.workflow(latestState.id), value: encode(latestState) }],
    [],
    () => new Error(`Revision re-stamp of workflow "${latestState.id}" lost its CAS race.`),
  );
}
