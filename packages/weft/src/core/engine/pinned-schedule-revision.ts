/**
 * Revision resolution for a `revisionPolicy: 'pinned'` schedule (WFT-20):
 * capture-time resolution (what revision would run right now, recorded on
 * the schedule) and fire-time resolution (resolve and reserve EXACTLY the
 * captured revision, enforcing a real, checkable commitment for an eager
 * workflow type rather than silently degrading to active-at-fire behavior).
 *
 * Fire-time resolution deliberately does NOT reuse
 * `resolveExecutableRegistrationForRevision()` unchanged for an eager type:
 * that resolver's documented "eager ignores the pin" rule is correct for
 * run RECOVERY (a process only ever runs the code it has loaded, so a stale
 * pin on an eager type is harmless) but wrong for a schedule's
 * forward-looking commitment — silently falling back to whatever is active
 * would make a "pinned" schedule lie about what it guarantees, and would
 * make `pinnedSchedules` reference-count accounting
 * ({@link import('./pinned-schedule-revision-count.ts').countPinnedSchedulesForRevision})
 * block removal of a revision nothing will ever actually run again.
 *
 * @module core/engine/pinned-schedule-revision
 */

import type { ConditionalBatchCondition } from '../../storage/interface.ts';
import type { ScheduleRevisionPolicy } from '../types.ts';
import { releaseInFlightStart, reserveInFlightStart } from './catalog-removal.ts';
import {
  resolveExecutableRegistration,
  resolveExecutableRegistrationForRevision,
  type ExecutableRegistration,
} from './dynamic-source-execution.ts';
import type { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { buildCatalogEntryRevisionCondition } from './lifecycle/start-commit.ts';
import {
  resolveCachedStartRevision,
  resolveStartRevisionUncached,
} from './lifecycle/start-revision-resolution.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';

/**
 * Capture-time resolution: the revision that would run RIGHT NOW for `type`,
 * reusing the same resolver (and revision-selection rule) a fresh
 * `engine.start()` call would use. Called by `schedule()`/`updateSchedule()`
 * when a caller requests `revisionPolicy: 'pinned'`, so the captured
 * {@link import('../types/schedules.ts').ScheduleMetadata.pinnedRevision} is
 * exactly what would have run had the schedule fired at this instant. No
 * `inFlightStartsByRevision` reservation here — this is not launching a
 * workflow, only recording a decision; the write that persists the pin is
 * separately fenced against a concurrent `removeWorkflowRevision()` via
 * `buildCatalogEntryRevisionCondition` at the `writeScheduleState` call site.
 */
export async function resolveScheduleRevisionForPin(
  engine: Engine,
  internals: EngineInternals,
  type: string,
): Promise<string> {
  const { revision: resolvedRevision } = await resolveExecutableRegistration(
    engine,
    internals,
    type,
  );
  return (
    resolveCachedStartRevision(internals, type, resolvedRevision) ??
    (await resolveStartRevisionUncached(internals, type))
  );
}

/**
 * Resolve `type` against its EXACT pinned `revision`, for a real Worker
 * fire-time launch of a pinned schedule's occurrence — not for recovery.
 * An eager registration must match `internals.registeredCatalogRevisions`
 * EXACTLY or this throws {@link WorkflowRevisionUnavailableError} with
 * reason `'not-registered'` (this is the one call site in the codebase that
 * does NOT let an eager type ignore its pin — see the module doc). A
 * dynamic-source type delegates to
 * {@link resolveExecutableRegistrationForRevision} unchanged, which already
 * enforces the exact-match rule for that case.
 */
async function resolvePinnedExecutableRegistration(
  engine: Engine,
  internals: EngineInternals,
  type: string,
  revision: string,
  onRevisionChosen?: (revision: string) => void,
): Promise<ExecutableRegistration> {
  const eager = internals.registrations.get(type);
  if (eager !== undefined) {
    if (internals.registeredCatalogRevisions.get(type) !== revision) {
      throw new WorkflowRevisionUnavailableError(type, revision, 'not-registered');
    }
    onRevisionChosen?.(revision);
    return { entry: eager, revision: undefined };
  }

  // The exact revision is already known (it is the pin, not derived from an
  // active pointer) — reserve BEFORE the dynamic-source load the same way
  // `resolveExecutableRegistration`'s own sole-candidate fast path does, to
  // close the identical concurrent-`removeWorkflowRevision()` TOCTOU window.
  onRevisionChosen?.(revision);
  return resolveExecutableRegistrationForRevision(engine, internals, type, revision);
}

/**
 * `schedule()`'s create-time revision resolution — split out to keep that
 * function under the complexity ceiling. For `revisionPolicy: 'pinned'`,
 * captures and returns the current revision via
 * {@link resolveScheduleRevisionForPin} (which already resolves, and for a
 * lazy type loads, `type` internally). For `'active-at-fire'`, returns
 * `undefined` and — for a lazy type not yet eagerly registered — resolves
 * once here purely to trigger the loader at schedule-creation time, exactly
 * as before this revision-policy field existed.
 */
export async function resolveScheduleCreationRevision(
  internals: EngineInternals,
  type: string,
  revisionPolicy: ScheduleRevisionPolicy,
): Promise<string | undefined> {
  if (revisionPolicy === 'pinned') {
    return resolveScheduleRevisionForPin(internals.engine as unknown as Engine, internals, type);
  }
  if (!internals.registrations.has(type)) {
    await resolveExecutableRegistration(internals.engine as unknown as Engine, internals, type);
  }
  return undefined;
}

/**
 * Fire-time resolve-and-reserve for a pinned schedule occurrence — the
 * pinned-revision counterpart of
 * `catalog-removal.ts`'s `resolveAndReserveExecutableRegistration`, reusing
 * the identical early/late `inFlightStartsByRevision` reservation shape so a
 * concurrent `removeWorkflowRevision()` sees an in-flight reference the same
 * way it would for an ordinary start.
 */
export async function resolveAndReservePinnedExecutableRegistration(
  engine: Engine,
  internals: EngineInternals,
  type: string,
  revision: string,
): Promise<{
  registration: ExecutableRegistration['entry'];
  inFlightRevision: string | undefined;
  resolvedRevision: string | undefined;
}> {
  let earlyReservation: string | undefined;
  try {
    const { entry: registration, revision: resolvedRevision } =
      await resolvePinnedExecutableRegistration(engine, internals, type, revision, (chosen) => {
        earlyReservation = reserveInFlightStart(internals, type, chosen);
      });
    const inFlightRevision =
      earlyReservation !== undefined
        ? earlyReservation
        : reserveInFlightStart(internals, type, resolvedRevision);
    return { registration, inFlightRevision, resolvedRevision };
  } catch (error) {
    releaseInFlightStart(internals, type, earlyReservation);
    throw error;
  }
}

/**
 * The `writeScheduleState` `extraConditions`/`onExtraConditionsLost` options
 * that fence a pinned schedule's create/update write against a concurrent
 * `removeWorkflowRevision()` landing between {@link resolveScheduleRevisionForPin}'s
 * capture and this commit — see `storage-io.ts`'s `writeScheduleState` doc for
 * why this is necessary (the scan-based `pinnedSchedules` reference count
 * cannot see an uncommitted schedule write, so `removeWorkflowRevision()`'s
 * own reference check cannot block it on its own). `undefined` (no fencing)
 * when `pinnedRevision` is `undefined` — this write is not pinning.
 */
export async function buildPinnedRevisionWriteOptions(
  internals: EngineInternals,
  type: string,
  pinnedRevision: string | undefined,
): Promise<
  { extraConditions: ConditionalBatchCondition[]; onExtraConditionsLost: () => Error } | undefined
> {
  if (pinnedRevision === undefined) {
    return undefined;
  }
  const condition = await buildCatalogEntryRevisionCondition(internals, type, pinnedRevision);
  return {
    extraConditions: [condition],
    onExtraConditionsLost: () =>
      new WorkflowRevisionUnavailableError(type, pinnedRevision, 'not-installed'),
  };
}
