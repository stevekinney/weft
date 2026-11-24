import { afterEach, describe, expect, it } from 'bun:test';

import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { warnIfRetryMissingHeartbeat } from './activity-heartbeat-tracking.ts';
import { driveWorkflowInterceptorGenerator } from './async-activity-completion.ts';
import { broadcast } from './broadcast.ts';
import {
  buildActionableBulkWorkflowFilter,
  buildBulkOperationPreparation,
} from './bulk-operations-shared.ts';
import { deriveWorkflowDefinitionRevision } from './definition-revision.ts';
import { WorkflowSourceNotRegisteredError } from './dynamic-source-errors.ts';
import type { EngineInternals } from './internals.ts';
import { ScheduleHandle } from './schedule-handle.ts';
import { parseTerminalCleanupTimerId, sanitizeWorkflowEventPayload } from './state-utilities.ts';

describe('driveWorkflowInterceptorGenerator', () => {
  it('feeds a non-promise yield straight back into the generator', async () => {
    function* interceptor(): Generator<unknown, unknown, unknown> {
      const first = yield 'plain';
      return `got ${String(first)}`;
    }

    expect(await driveWorkflowInterceptorGenerator(interceptor())).toBe('got plain');
  });
});

describe('broadcast', () => {
  const originalChannel = globalThis.BroadcastChannel;
  afterEach(() => {
    globalThis.BroadcastChannel = originalChannel;
  });

  it('gives up quietly when the runtime cannot open a broadcast channel', () => {
    globalThis.BroadcastChannel = function unavailableBroadcastChannel() {
      throw new Error('BroadcastChannel is unavailable');
    } as unknown as typeof BroadcastChannel;
    const internals = {
      options: { broadcastEvents: true },
      broadcastChannel: null,
    } as unknown as EngineInternals;

    broadcast(internals, { type: 'event' }, {} as never);

    expect(internals.broadcastChannel).toBeNull();
  });
});

describe('deriveWorkflowDefinitionRevision', () => {
  it('derives a revision for a definition that is not a builder definition', async () => {
    const plain = {
      name: 'plain-definition',
      execute: async function* () {
        return 'ok';
      },
    };

    const revision = await deriveWorkflowDefinitionRevision(plain as never);

    expect(revision).toMatch(/\S/);
  });
});

describe('WorkflowSourceNotRegisteredError', () => {
  it('describes a missing workflow name when no revision was asked for', () => {
    const error = new WorkflowSourceNotRegisteredError('checkout');

    expect(error.message).toBe('No workflow registered with name "checkout"');
    expect(error.revision).toBeUndefined();
  });
});

describe('warnIfRetryMissingHeartbeat', () => {
  it('names a string activity state key in the development warning', () => {
    const events: Array<{ message?: string; fields?: unknown }> = [];
    const internals = {
      options: { development: true },
      activityWorkerDispatcher: null,
      lastHeartbeatDetailsByStep: new Map(),
      engine: { dispatchEvent: (event: never) => events.push(event) },
    } as unknown as EngineInternals;

    warnIfRetryMissingHeartbeat(internals, 'wf-1', 'memo-key', 2);

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('activity state key memo-key');
    expect(JSON.stringify(events[0])).toContain('activityStateKey.memo-key.lastHeartbeatDetails');
  });
});

describe('bulk operation filters', () => {
  it('collapses a single requested status to one actionable status', () => {
    const filter = buildActionableBulkWorkflowFilter({} as EngineInternals, { status: 'failed' }, [
      'failed',
      'cancelled',
    ]);

    expect(filter.status).toBe('failed');
  });

  it('keeps an array of requested statuses that are all actionable', () => {
    const filter = buildActionableBulkWorkflowFilter(
      {} as EngineInternals,
      { status: ['failed', 'cancelled'] },
      ['failed', 'cancelled'],
    );

    expect(filter.status).toEqual(['failed', 'cancelled']);
  });

  it('summarizes range-only attribute filters without a value', () => {
    const preparation = buildBulkOperationPreparation(
      'retry-failed',
      { attributes: [{ key: 'amount', gt: 1 }] },
      {},
      [],
      {},
    );

    expect(preparation.scope.filter.attributes).toEqual([{ key: 'amount', gt: 1 }]);
  });
});

describe('ScheduleHandle.describe', () => {
  it('throws when the schedule does not exist', async () => {
    const handle = new ScheduleHandle('missing', { getSchedule: async () => null } as never);

    const error = await rejectionOf(handle.describe());

    expect(String(error)).toContain('Schedule "missing" not found');
  });
});

describe('timer id and event payload helpers', () => {
  it('rejects a preserve-output terminal cleanup timer id with no token', () => {
    const preserved = 'terminal-cleanup:preserve-output:';
    expect(parseTerminalCleanupTimerId(preserved)).toBeNull();
  });

  it('wraps a non-record event payload', () => {
    expect(sanitizeWorkflowEventPayload('plain text')).toEqual({ value: 'plain text' });
  });
});
