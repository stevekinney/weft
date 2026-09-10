/**
 * `recoverAll()`'s per-`(type, revision)` preload barrier (WFT-17/WFT-18),
 * replacing the per-`type`-only barrier `recovery-dynamic-sources.ts` used
 * to own. Split out of `transition.ts`, which has no headroom under the
 * repository's 500-line implementation-file ceiling for this logic inline
 * — the same reason `recovery-dynamic-sources.ts` was split out for
 * WFT-15/16.
 *
 * Recovery scans non-terminal workflow states, groups them by their exact
 * `(type, revision)` pin (a legacy record with no persisted `revision`
 * groups under `undefined` for its type), and preloads/classifies every
 * group BEFORE any group's runs advance — ready, or unavailable with the
 * error every run in that group fails with. Grouping and classification use
 * nested `Map<type, Map<revision, …>>` structures rather than a
 * delimiter-joined composite key, so an arbitrary workflow `type` or
 * `revision` string can never collide with a delimiter.
 *
 * @module core/engine/lifecycle/recovery-revision-groups
 */

import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import { EngineDisposedError } from '../errors.ts';
import type { EngineInternals } from '../internals.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import type { LifecycleCallbacks } from './shared.ts';

/** One preflight-recoverable entry's identity, as `transition.ts`'s preflight scan produces it. */
export type RecoverableRevisionEntry = {
  readonly workflowId: string;
  readonly type: string;
  readonly revision: string | undefined;
};

/** One `(type, revision)` group: every non-terminal run pinned to that exact revision. */
export type RecoveryRevisionGroup = {
  readonly type: string;
  readonly revision: string | undefined;
  readonly workflowIds: readonly string[];
};

/** `type -> revision -> group`. A legacy entry (no persisted `revision`) groups under the `undefined` key. */
export type RecoveryRevisionGroups = ReadonlyMap<
  string,
  ReadonlyMap<string | undefined, RecoveryRevisionGroup>
>;

/**
 * Group preflight-recoverable entries by their exact `(type, revision)` pin.
 * Every non-terminal run pinned to the same revision of the same type lands
 * in one group, regardless of scan order.
 */
export function buildRecoveryRevisionGroups(
  entries: readonly RecoverableRevisionEntry[],
): RecoveryRevisionGroups {
  const groups = new Map<
    string,
    Map<string | undefined, { type: string; revision: string | undefined; workflowIds: string[] }>
  >();
  for (const entry of entries) {
    let byRevision = groups.get(entry.type);
    if (byRevision === undefined) {
      byRevision = new Map();
      groups.set(entry.type, byRevision);
    }
    const existing = byRevision.get(entry.revision);
    if (existing === undefined) {
      byRevision.set(entry.revision, {
        type: entry.type,
        revision: entry.revision,
        workflowIds: [entry.workflowId],
      });
    } else {
      existing.workflowIds.push(entry.workflowId);
    }
  }
  return groups;
}

/** Outcome of classifying one `(type, revision)` group. */
export type RevisionGroupClassification =
  | { readonly status: 'ready' }
  | {
      readonly status: 'unavailable';
      readonly error: WorkflowRevisionUnavailableError | DynamicWorkflowSourceUnavailableError;
    };

/** `type -> revision -> classification`, mirroring {@link RecoveryRevisionGroups}'s shape. */
export type RevisionGroupClassifications = ReadonlyMap<
  string,
  ReadonlyMap<string | undefined, RevisionGroupClassification>
>;

/**
 * Resolve every `(type, revision)` group to `'ready'` or `'unavailable'`,
 * concurrently, one `resolveExecutableRegistrationForRevision()` call per
 * group — even when many non-terminal runs share the same pin. An eager
 * type's groups are omitted from the result entirely (eager is always
 * ready and needs no preload call); only dynamic-source groups are
 * classified. A disposal mid-preload aborts the whole barrier by
 * rethrowing, matching `recoverEntryOrIsolateFailure`'s own un-isolated
 * treatment of {@link EngineDisposedError}.
 */
export async function classifyRevisionGroups(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  groups: RecoveryRevisionGroups,
): Promise<RevisionGroupClassifications> {
  const dynamicGroups: RecoveryRevisionGroup[] = [];
  for (const [type, byRevision] of groups) {
    if (internals.registrations.has(type)) continue;
    dynamicGroups.push(...byRevision.values());
  }

  const results = new Map<string, Map<string | undefined, RevisionGroupClassification>>();
  if (dynamicGroups.length === 0) return results;

  const settled = await Promise.allSettled(
    dynamicGroups.map((group) =>
      callbacks.resolveExecutableRegistrationForRevision(group.type, group.revision),
    ),
  );

  for (const [index, outcome] of settled.entries()) {
    const group = dynamicGroups[index]!;
    let byRevision = results.get(group.type);
    if (byRevision === undefined) {
      byRevision = new Map();
      results.set(group.type, byRevision);
    }
    if (outcome.status === 'fulfilled') {
      byRevision.set(group.revision, { status: 'ready' });
      continue;
    }
    const reason: unknown = outcome.reason;
    if (reason instanceof EngineDisposedError) throw reason;
    const error =
      reason instanceof WorkflowRevisionUnavailableError ||
      reason instanceof DynamicWorkflowSourceUnavailableError
        ? reason
        : new DynamicWorkflowSourceUnavailableError(
            group.type,
            group.revision,
            'load-failed',
            reason,
          );
    byRevision.set(group.revision, { status: 'unavailable', error });
  }

  return results;
}

/**
 * Wrap `callbacks` so `recoverAll()`'s own per-entry `resume()` calls below
 * see a batch's cached `classifyRevisionGroups()` failure for the entry's
 * `(type, revision)` group, WITHOUT touching any state shared with other
 * callers. `classifications` is a plain, closure-local `Map` structure —
 * nothing outside `recoverAll()` ever sees it, so a concurrent, unrelated
 * `engine.start()`, `engine.resume()`, or a second concurrent `recoverAll()`
 * batch for the SAME `(type, revision)` keeps using the real, un-wrapped
 * `callbacks.resolveExecutableRegistrationForRevision` and can never observe
 * (or race the reset of) this batch's classification.
 */
export function createRecoveryScopedRevisionCallbacks(
  callbacks: LifecycleCallbacks,
  classifications: RevisionGroupClassifications,
): LifecycleCallbacks {
  return {
    ...callbacks,
    resolveExecutableRegistrationForRevision: (type, revision) => {
      const classification = classifications.get(type)?.get(revision);
      if (classification?.status === 'unavailable') {
        return Promise.reject(classification.error);
      }
      return callbacks.resolveExecutableRegistrationForRevision(type, revision);
    },
  };
}
