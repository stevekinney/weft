import type { RetentionOverview, WorkflowTypeRetentionPolicy } from '../types.ts';
import { purgeInternal } from './bulk-operations.ts';
import { resolveLastKnownDynamicRegistration } from './dynamic-source-execution.ts';
import type { EngineInternals } from './internals.ts';

type CleanupWaiters = (workflowId: string) => void;
type RetentionSweepCallbacks = {
  hasConfiguredRetention: () => boolean;
  runRetentionSweep: () => Promise<void>;
  setNextRetentionSweepAt: () => void;
};

export function hasConfiguredRetention(internals: EngineInternals): boolean {
  if (internals.options.retention !== null) {
    return true;
  }

  for (const registration of internals.registrations.values()) {
    if (registration.retention !== undefined && registration.retention !== null) {
      return true;
    }
  }

  // Eager registrations alone miss a `registerSource()`-registered type's
  // own retention policy — that definition never lands in
  // `internals.registrations` (see `dynamic-source-execution.ts`). Walk
  // every dynamic type this engine has actually RESOLVED at least once:
  // an unresolved candidate cannot carry a policy this process has ever
  // read, and resolving it here would defeat the point of lazy loading.
  for (const revisions of internals.sources.resolved.values()) {
    for (const resolved of revisions.values()) {
      if (resolved.definition.retention !== undefined && resolved.definition.retention !== null) {
        return true;
      }
    }
  }

  return false;
}

export function setNextRetentionSweepAt(internals: EngineInternals): void {
  internals.nextRetentionSweepAt =
    internals.options.getNow() + internals.options.retentionSweepIntervalMs;
}

export function ensureRetentionSweepInterval(
  internals: EngineInternals,
  callbacks: RetentionSweepCallbacks,
): void {
  if (internals.options.backgroundTaskMode === 'manual') {
    internals.nextRetentionSweepAt = null;
    return;
  }
  if (!callbacks.hasConfiguredRetention()) {
    if (internals.retentionSweepInterval !== null) {
      clearInterval(internals.retentionSweepInterval ?? undefined);
      internals.retentionSweepInterval = null;
    }
    internals.nextRetentionSweepAt = null;
    return;
  }

  if (internals.retentionSweepInterval !== null) {
    return;
  }

  callbacks.setNextRetentionSweepAt();
  internals.retentionSweepInterval = setInterval(() => {
    callbacks.setNextRetentionSweepAt();
    if (internals.retentionSweepInFlight !== null) {
      return;
    }

    const sweepPromise = callbacks.runRetentionSweep();
    const settledSweepPromise = sweepPromise.finally(() => {
      if (internals.retentionSweepInFlight === settledSweepPromise) {
        internals.retentionSweepInFlight = null;
      }
    });
    internals.retentionSweepInFlight = settledSweepPromise;
  }, internals.options.retentionSweepIntervalMs);
}

export async function runRetentionSweep(
  internals: EngineInternals,
  handleCleanupError: (source: string, error: unknown) => void,
  cleanupWaiters: CleanupWaiters,
): Promise<void> {
  try {
    await purgeInternal(
      internals,
      undefined,
      {
        expiredOnly: true,
        limit: internals.options.retentionSweepBatchSize,
        now: internals.options.getNow(),
      },
      cleanupWaiters,
    );
  } catch (error) {
    handleCleanupError('retentionSweep', error);
  }
}

export function resolveWorkflowTypeRetention(
  internals: EngineInternals,
  type: string,
): WorkflowTypeRetentionPolicy {
  // Sync-only, TYPE-level fallback: falls back to the most recently
  // RESOLVED dynamic definition for `type` when there is no eager
  // registration. Never triggers a new resolve.
  //
  // Uses `resolveLastKnownDynamicRegistration()`, not
  // `getResolvedDynamicRegistration()` (WFT-19 review round 6, Codex): this
  // is a TYPE-level overview API (`getRetentionOverview()`'s
  // per-registered-type summary) with no single running instance's own pin
  // to resolve against — unlike `getWorkflowRetentionDeadline()`'s
  // per-instance resolve, which passes the run's own `state.revision` and
  // must fail closed when 2+ candidates make that ambiguous.
  // `resolveLastKnownDynamicRegistration()` is the one place that
  // permissive, possibly-ambiguous answer is still correct to show.
  const registration = resolveLastKnownDynamicRegistration(internals, type);
  if (registration?.retention) {
    return {
      type,
      source: 'workflow',
      retention: registration.retention,
    };
  }

  if (internals.options.retention !== null) {
    return {
      type,
      source: 'engine',
      retention: internals.options.retention,
    };
  }

  return {
    type,
    source: 'none',
    retention: null,
  };
}

export function getRetentionOverview(
  internals: EngineInternals,
  resolveRetentionForType: (type: string) => WorkflowTypeRetentionPolicy = (type) =>
    resolveWorkflowTypeRetention(internals, type),
): RetentionOverview {
  // Union eager registrations with every `registerSource()`-registered
  // name so a dynamic type's retention policy is visible here too, once
  // resolved (`resolveRetentionForType` falls back to the same
  // sync-only resolved-dynamic-definition lookup `resolveWorkflowTypeRetention`
  // above does).
  const workflowTypes = [
    ...new Set([...internals.registrations.keys(), ...internals.sources.byName.keys()]),
  ]
    .toSorted()
    .map((type) => resolveRetentionForType(type));

  return {
    defaultRetention: internals.options.retention,
    sweepIntervalMs: internals.options.retentionSweepIntervalMs,
    sweepBatchSize: internals.options.retentionSweepBatchSize,
    nextSweepAt: internals.nextRetentionSweepAt,
    workflowTypes,
  };
}
