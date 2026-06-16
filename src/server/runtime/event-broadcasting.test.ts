import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import {
  ActivityAsyncPendingEvent,
  AlertFiredEvent,
  ConstraintViolatedEvent,
  ScheduleFiredEvent,
  ScheduleMissedFireEvent,
  TaskResultDeadLetteredEvent,
  WorkerConnectedEvent,
  WorkerDisconnectedEvent,
  WorkflowResumedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
} from '../../core/events.ts';
import { waitForParityCondition as waitFor } from '../../core/parity/real-timer-wait.test-support.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from '../../core/review/events.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createFleetEventFeed, type FleetEventEnvelope } from '../fleet-event-feed.ts';
import { CLIENT_VISIBLE_EVENT_TYPES } from './client-visible-events.ts';
import { wireEventBroadcasting } from './event-broadcasting.ts';

describe('wireEventBroadcasting', () => {
  it('keeps operational runtime events in the client-visible broadcast set', () => {
    expect(CLIENT_VISIBLE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        ActivityAsyncPendingEvent.type,
        TaskResultDeadLetteredEvent.type,
        ScheduleFiredEvent.type,
        ScheduleMissedFireEvent.type,
        ReviewRequestedEvent.type,
        ReviewCompletedEvent.type,
        AlertFiredEvent.type,
        ConstraintViolatedEvent.type,
        WorkflowResumedEvent.type,
        WorkflowSuspendedEvent.type,
        WorkflowTeardownEvent.type,
        WorkerConnectedEvent.type,
        WorkerDisconnectedEvent.type,
      ]),
    );
  });

  it('publishes no-workflow operational events through the fleet feed', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const fleetEventFeed = createFleetEventFeed(engine.storage);
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, { fleetEventFeed });

    engine.dispatchEvent(new AlertFiredEvent('queue-depth', 10, 11));

    await waitFor(
      async () => {
        for await (const _envelope of fleetEventFeed.replay()) return true;
        return false;
      },
      { label: 'fleet alert event persisted' },
    );
    const events: FleetEventEnvelope[] = [];
    for await (const envelope of fleetEventFeed.replay()) events.push(envelope);
    handle.dispose();
    engine[Symbol.dispose]();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: AlertFiredEvent.type,
      payload: { metric: 'queue-depth', threshold: 10, currentValue: 11 },
    });
  });
});
