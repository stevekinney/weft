/**
 * Dispatches `lease:health-changed` when the status that
 * {@link import('./index.ts').Engine.getLeaseHealth} reports differs from the last status this
 * engine announced. Called wherever the engine learns the lease status may have moved: after
 * acquisition, after each renewal attempt settles, when the lease manager reports a loss, and
 * when a deposition is detected.
 *
 * @module core/engine/lease-health-events
 */

import { LeaseHealthChangedEvent, type LeaseHealthStatus } from '../events/fleet-state-events.ts';
import type { EngineInternals } from './internals.ts';
import type { EngineLeaseHealth } from './lease-health.ts';

/** Compute the engine's last-known ownership-lease health: the body of {@link import('./index.ts').Engine.getLeaseHealth}. Synchronous and never reads storage. */
export function readEngineLeaseHealth(internals: EngineInternals): EngineLeaseHealth {
  if (internals.options.ownershipMode === 'none') {
    return { mode: 'none', status: 'disabled', holdsLease: false };
  }
  if (internals.deposed) {
    const lastKnownLease = internals.leaseManager?.health();
    if (lastKnownLease !== undefined && lastKnownLease.status !== 'no-lease') {
      return {
        mode: 'lease',
        ...lastKnownLease,
        status: 'contested',
        holdsLease: false,
        lossReason: 'deposed',
      };
    }
    return {
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      lossReason: 'deposed',
    };
  }
  return {
    mode: 'lease',
    ...(internals.leaseManager?.health() ?? { status: 'no-lease', holdsLease: false }),
  };
}

/**
 * The status each engine last announced. Absent until the first announcement, when the baseline is
 * the status the engine had at construction: `disabled` under `ownership: 'none'`, else `no-lease`.
 */
const lastAnnouncedStatus = new WeakMap<EngineInternals, LeaseHealthStatus>();

/**
 * Read the engine's current lease status and dispatch {@link LeaseHealthChangedEvent} only when it
 * differs from the last announced status. Synchronous, so two observations of the same status
 * dispatch once, and a status that flips and flips back between observations dispatches nothing.
 */
export function dispatchLeaseHealthIfChanged(internals: EngineInternals): void {
  const { status } = readEngineLeaseHealth(internals);
  const baseline = internals.options.ownershipMode === 'none' ? 'disabled' : 'no-lease';
  if (status === (lastAnnouncedStatus.get(internals) ?? baseline)) return;
  lastAnnouncedStatus.set(internals, status);
  internals.engine.dispatchEvent(new LeaseHealthChangedEvent(status));
}
