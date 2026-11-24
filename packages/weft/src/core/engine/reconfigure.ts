import type { EnginePatch, EngineReconfigureResult } from '../types.ts';
import {
  resolveHistoryFields,
  resolveNumericDefaults,
  resolveRetentionFields,
} from './construction.ts';
import type { EngineConstructorOptions, ResolvedOptions } from './engine-internal-types.ts';
import { EngineDisposedError } from './errors.ts';
import type { EngineInternals } from './internals.ts';

type PatchKey = keyof EnginePatch;

/** What one validated key contributes: its resolved options, and the value reported as applied. */
type StagedKey = { readonly resolved: Partial<ResolvedOptions>; readonly applied: unknown };

/** Copy a policy object so the result never aliases the caller's object. */
function copyPolicy(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? { ...value } : value;
}

/**
 * The two options `Engine` construction clamps or defaults instead of validating. Construction
 * keeps accepting whatever it always accepted; a patch is stricter, because a value that is not a
 * finite number would be applied to a live engine as `NaN`.
 */
function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`options.${field} must be a finite number; received ${String(value)}`);
  }
  return value;
}

/**
 * Each key runs through the resolver `Engine` construction uses for it, given an options object
 * that carries only that key, so a patch is validated exactly as `new Engine(...)` validates the
 * same value.
 */
const STAGERS: { readonly [Key in PatchKey]-?: (value: unknown) => StagedKey } = {
  retention: (value) => ({
    resolved: {
      retention: resolveRetentionFields({ retention: value } as EngineConstructorOptions).retention,
    },
    applied: copyPolicy(value),
  }),
  retentionSweepInterval: (value) => {
    const { retentionSweepIntervalMs } = resolveRetentionFields({
      retentionSweepInterval: value,
    } as EngineConstructorOptions);
    return { resolved: { retentionSweepIntervalMs }, applied: retentionSweepIntervalMs };
  },
  retentionSweepBatchSize: (value) => {
    const { retentionSweepBatchSize } = resolveRetentionFields({
      retentionSweepBatchSize: requireFiniteNumber(value, 'retentionSweepBatchSize'),
    });
    return { resolved: { retentionSweepBatchSize }, applied: retentionSweepBatchSize };
  },
  history: (value) => ({
    resolved: {
      historyPolicy: resolveHistoryFields({ history: value } as EngineConstructorOptions)
        .historyPolicy,
    },
    applied: copyPolicy(value),
  }),
  payloadSize: (value) => ({
    resolved: {
      payloadSizePolicy: resolveHistoryFields({ payloadSize: value } as EngineConstructorOptions)
        .payloadSizePolicy,
    },
    applied: copyPolicy(value),
  }),
  checkpointSizeWarningThreshold: (value) => {
    const checkpointSizeWarningThreshold = requireFiniteNumber(
      value,
      'checkpointSizeWarningThreshold',
    );
    return {
      resolved: { checkpointSizeWarningThreshold },
      applied: checkpointSizeWarningThreshold,
    };
  },
  schedulerPollIntervalMs: (value) => {
    const { schedulerPollIntervalMs } = resolveNumericDefaults({
      schedulerPollIntervalMs: value,
    } as EngineConstructorOptions);
    return { resolved: { schedulerPollIntervalMs }, applied: schedulerPollIntervalMs };
  },
};

function isPatchKey(key: string): key is PatchKey {
  return Object.hasOwn(STAGERS, key);
}

function rejected(keys: readonly string[], message: string): EngineReconfigureResult {
  return { outcome: 'rejected', keys, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StagedPatch =
  | {
      readonly kind: 'staged';
      readonly resolved: Partial<ResolvedOptions>;
      readonly applied: EnginePatch;
    }
  | { readonly kind: 'rejected'; readonly result: EngineReconfigureResult };

/** Validate every key of `patch` without applying any: the staged values, or the rejection. */
function stagePatch(patch: unknown): StagedPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { kind: 'rejected', result: rejected([], 'patch must be an object') };
  }

  // A key whose value is `undefined` is absent, as an optional property is.
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  const unknownKeys = entries.map(([key]) => key).filter((key) => !isPatchKey(key));
  if (unknownKeys.length > 0) {
    const message = `patch keys cannot be reconfigured: ${unknownKeys.join(', ')}`;
    return { kind: 'rejected', result: rejected(unknownKeys, message) };
  }

  const resolved: Partial<ResolvedOptions> = {};
  const applied: Record<string, unknown> = {};
  const failedKeys: string[] = [];
  const failures: string[] = [];
  for (const [key, value] of entries) {
    try {
      const staged = STAGERS[key as PatchKey](value);
      Object.assign(resolved, staged.resolved);
      applied[key] = staged.applied;
    } catch (error) {
      failedKeys.push(key);
      failures.push(errorMessage(error));
    }
  }
  if (failedKeys.length > 0) {
    return { kind: 'rejected', result: rejected(failedKeys, failures.join('; ')) };
  }
  return { kind: 'staged', resolved, applied };
}

/**
 * Validate `patch` against the options `Engine` construction validates, then apply it whole or
 * not at all. Nothing is applied, and no timer is touched, unless every key passes.
 *
 * The seven keys are read at the point of use, so storing them on `internals.options` is the
 * whole change, except for the two intervals, whose timers were armed with the old value at
 * construction:
 *
 * - `schedulerPollIntervalMs`: the scheduler re-arms its running poll timer, so the next poll
 *   lands one new interval from now. A scheduler that is not running keeps only the value.
 * - `retentionSweepInterval`: a sweep timer that is armed is cleared and re-armed through the
 *   same path `register()` uses, which re-reads the interval. No timer is armed where none was:
 *   with no retention configured, under `backgroundTasks: 'manual'`, or after disposal.
 *
 * A `retention` patch reconciles the sweep timer the way `register()` does: retention that is now
 * configured arms a sweep at the effective interval, retention that is no longer configured
 * clears it, and a running timer is left alone, so its phase is kept. A patch with neither key
 * touches no timer.
 *
 * @throws {EngineDisposedError} On a disposed engine, as every other `Engine` method throws. A
 * disposed engine has no timers, and re-arming one would hold the process open.
 */
export function reconfigureEngine(
  internals: EngineInternals,
  patch: unknown,
  ensureRetentionSweepInterval: () => void,
): EngineReconfigureResult {
  if (internals.disposed) throw new EngineDisposedError();
  const staged = stagePatch(patch);
  if (staged.kind === 'rejected') return staged.result;

  const previousPollIntervalMs = internals.options.schedulerPollIntervalMs;
  const previousSweepIntervalMs = internals.options.retentionSweepIntervalMs;
  Object.assign(internals.options, staged.resolved);

  const { schedulerPollIntervalMs, retentionSweepIntervalMs } = internals.options;
  if (schedulerPollIntervalMs !== previousPollIntervalMs) {
    internals.scheduler.setPollInterval(schedulerPollIntervalMs);
  }
  let reconcileSweep = 'retention' in staged.resolved;
  if (retentionSweepIntervalMs !== previousSweepIntervalMs && internals.retentionSweepInterval) {
    clearInterval(internals.retentionSweepInterval);
    internals.retentionSweepInterval = null;
    reconcileSweep = true;
  }
  // Re-enter the path `register()` uses when the timer was cleared above or retention changed:
  // it arms a sweep for newly configured retention, clears one when none is configured any more,
  // and leaves a running timer alone, so a retention patch alone never resets the sweep's phase.
  if (reconcileSweep) ensureRetentionSweepInterval();
  return { outcome: 'applied', applied: staged.applied };
}
