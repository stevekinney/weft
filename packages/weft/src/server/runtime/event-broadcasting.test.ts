import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { decode, encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import {
  ActivityAsyncPendingEvent,
  AlertFiredEvent,
  CheckpointSizeWarningEvent,
  CleanupWarningEvent,
  ConstraintViolatedEvent,
  DevelopmentWarningEvent,
  LeaseHealthChangedEvent,
  QueueDepthChangedEvent,
  RealmStateChangedEvent,
  RemoteActivityCancellationRequestedEvent,
  RemoteActivityQueuedEvent,
  ScheduleFiredEvent,
  ScheduleMissedFireEvent,
  StorageSizeReportedEvent,
  StreamChunkEvent,
  TaskResultDeadLetteredEvent,
  WorkerConnectedEvent,
  WorkerDeploymentChangedEvent,
  WorkerDisconnectedEvent,
  WorkerRegistrationRejectedEvent,
  WorkflowCancelledEvent,
  WorkflowDefinitionRegisteredEvent,
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionActivationRejectedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
  WorkflowRevisionRemovedEvent,
  WorkflowSourceLoadCancelledEvent,
  WorkflowSourceLoadFailedEvent,
  WorkflowSourceLoadReadyEvent,
  WorkflowSourceLoadStartedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
} from '../../core/events.ts';
import { waitForParityCondition as waitFor } from '../../core/parity/real-timer-wait.test-support.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from '../../core/review/events.ts';
import { taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import { KEYS } from '../../storage/keys.ts';
import { createFleetEventFeed, type FleetEventEnvelope } from '../fleet-event-feed.ts';
import {
  CLIENT_VISIBLE_EVENT_TYPES,
  EVENT_CLASSIFICATIONS,
  serializeClientVisibleEventData,
  TOKEN_EVENT_TYPE,
} from './client-visible-events.ts';
import { registerWorkflowEventLifecycle, wireEventBroadcasting } from './event-broadcasting.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';

class TokenEvent extends Event {
  constructor(
    public readonly workflowId: string,
    public readonly token: string,
    public readonly model: string,
  ) {
    super(TOKEN_EVENT_TYPE);
  }
}

describe('wireEventBroadcasting', () => {
  it('keeps every newly published event own-property payload within the wire whitelist', () => {
    const safeEvents: Array<[string, Event]> = [
      ['workflow:definition-registered', new WorkflowDefinitionRegisteredEvent('checkout')],
      [
        'workflow:recovery-skipped',
        new WorkflowRecoverySkippedEvent('wf-1', 'checkout', 'type-not-registered'),
      ],
      ['activity:remote-queued', new RemoteActivityQueuedEvent('op-1', 'wf-1', 'default')],
      [
        'activity:remote-cancellation-requested',
        new RemoteActivityCancellationRequestedEvent('op-1', 'wf-1'),
      ],
      ['catalog:revision-installed', new WorkflowRevisionInstalledEvent('checkout', 'r1')],
      [
        'catalog:revision-activated',
        new WorkflowRevisionActivatedEvent('checkout', 'r1', 1, undefined),
      ],
      [
        'catalog:activation-rejected',
        new WorkflowRevisionActivationRejectedEvent('checkout', 'r2', 'conflict'),
      ],
      ['catalog:revision-draining', new WorkflowRevisionDrainingEvent('checkout', 'r1')],
      ['catalog:revision-removed', new WorkflowRevisionRemovedEvent('checkout', 'r1')],
      [
        'workflow-source:load-started',
        new WorkflowSourceLoadStartedEvent('checkout', 'r1', 'module'),
      ],
      [
        'workflow-source:load-ready',
        new WorkflowSourceLoadReadyEvent('checkout', 'r1', 'module', 12),
      ],
      [
        'workflow-source:load-failed',
        new WorkflowSourceLoadFailedEvent('checkout', 'r1', 'module', 12, 'application'),
      ],
      [
        'workflow-source:load-cancelled',
        new WorkflowSourceLoadCancelledEvent('checkout', 'r1', 'module'),
      ],
      ['realm:state-changed', new RealmStateChangedEvent('realm-1', 'r1', 'crashed', 2)],
      ['lease:health-changed', new LeaseHealthChangedEvent('contested')],
      [
        'worker:registration-rejected',
        new WorkerRegistrationRejectedEvent('worker-1', 'deployment_conflict'),
      ],
      [
        'worker:deployment-changed',
        new WorkerDeploymentChangedEvent('billing', 'b1', 'draining', 4),
      ],
      ['stream:chunk', new StreamChunkEvent('wf-1', 'progress', 7)],
      ['queue:depth-changed', new QueueDepthChangedEvent('payments', 12)],
    ];
    const allowed = new Set([
      'isTrusted',
      'workflowId',
      'workflowType',
      'revision',
      'generation',
      'previousRevision',
      'candidateRevision',
      'reason',
      'incompatibilityReasons',
      'operationId',
      'queue',
      'kind',
      'loadDurationMs',
      'failureCategory',
      'realmId',
      'state',
      'restartCount',
      'status',
      'workerId',
      'code',
      'deploymentName',
      'buildId',
      'drainState',
      'routingGeneration',
      'key',
      'sequence',
      'queue',
      'depth',
    ]);

    for (const [kind, event] of safeEvents) {
      expect(EVENT_CLASSIFICATIONS[kind as keyof typeof EVENT_CLASSIFICATIONS]).toBe('published');
      expect(
        Object.keys(event)
          .filter((key) => key !== 'type')
          .every((key) => allowed.has(key)),
      ).toBe(true);
      expect(serializeClientVisibleEventData(event)).not.toHaveProperty('isTrusted');
    }

    expect(serializeClientVisibleEventData(new WorkflowSuspendedEvent('wf-legacy'))).toHaveProperty(
      'isTrusted',
      false,
    );
  });

  it('denies the unsafe task-attempt event with a reason and keeps it out of read filters', () => {
    const classification = EVENT_CLASSIFICATIONS['task:attempt-transition'];
    expect(classification).toMatchObject({ denied: expect.any(String) });
    expect(CLIENT_VISIBLE_EVENT_TYPES).not.toContain('task:attempt-transition');
  });

  it('keeps workflow-facing operational events in the client-visible broadcast set', () => {
    expect(CLIENT_VISIBLE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        ActivityAsyncPendingEvent.type,
        TaskResultDeadLetteredEvent.type,
        ScheduleFiredEvent.type,
        ScheduleMissedFireEvent.type,
        CheckpointSizeWarningEvent.type,
        CleanupWarningEvent.type,
        DevelopmentWarningEvent.type,
        StorageSizeReportedEvent.type,
        ReviewRequestedEvent.type,
        ReviewCompletedEvent.type,
        AlertFiredEvent.type,
        ConstraintViolatedEvent.type,
        WorkerConnectedEvent.type,
        WorkerDisconnectedEvent.type,
        WorkflowResumedEvent.type,
        WorkflowSuspendedEvent.type,
        WorkflowTeardownEvent.type,
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

  it('publishes the realm, lease, rejection, deployment and queue-depth events through the fleet feed with identifier-only payloads (COR-1724)', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const fleetEventFeed = createFleetEventFeed(engine.storage);
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, { fleetEventFeed });

    engine.dispatchEvent(new RealmStateChangedEvent('realm-1', 'r1', 'crashed', 2));
    engine.dispatchEvent(new LeaseHealthChangedEvent('contested'));
    engine.dispatchEvent(new WorkerRegistrationRejectedEvent('worker-1', 'deployment_conflict'));
    engine.dispatchEvent(new WorkerDeploymentChangedEvent('billing', undefined, 'draining', 4));
    engine.dispatchEvent(new QueueDepthChangedEvent('payments', 12));

    const events: FleetEventEnvelope[] = [];
    await waitFor(
      async () => {
        events.length = 0;
        for await (const envelope of fleetEventFeed.replay()) events.push(envelope);
        return events.length === 5;
      },
      { label: 'five fleet events persisted' },
    );
    handle.dispose();
    engine[Symbol.dispose]();

    expect(events.map((envelope) => [envelope.kind, envelope.payload])).toEqual([
      [
        'realm:state-changed',
        { realmId: 'realm-1', revision: 'r1', state: 'crashed', restartCount: 2 },
      ],
      ['lease:health-changed', { status: 'contested' }],
      ['worker:registration-rejected', { workerId: 'worker-1', code: 'deployment_conflict' }],
      [
        'worker:deployment-changed',
        { deploymentName: 'billing', drainState: 'draining', routingGeneration: 4 },
      ],
      ['queue:depth-changed', { queue: 'payments', depth: 12 }],
    ]);
  });

  it('keeps workflowless catalog events out of workflow watch storage and publication', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const fleetEventFeed = createFleetEventFeed(engine.storage);
    const published: string[] = [];
    const handle = wireEventBroadcasting(
      engine,
      {
        publish(_channel: string, message: string) {
          published.push(message);
        },
      } as never,
      { fleetEventFeed },
    );

    engine.dispatchEvent(new WorkflowRevisionInstalledEvent('checkout', 'r1'));

    await waitFor(
      async () => {
        for await (const _envelope of fleetEventFeed.replay()) return true;
        return false;
      },
      { label: 'workflowless catalog event persisted to fleet feed' },
    );
    const fleetEvents: FleetEventEnvelope[] = [];
    for await (const envelope of fleetEventFeed.replay()) fleetEvents.push(envelope);
    const watchKeys: string[] = [];
    for await (const [key] of engine.storage.scan('watch-event:')) watchKeys.push(key);

    handle.dispose();
    engine[Symbol.dispose]();

    expect(fleetEvents).toHaveLength(1);
    expect(fleetEvents[0]).toMatchObject({
      kind: WorkflowRevisionInstalledEvent.type,
      payload: { workflowType: 'checkout', revision: 'r1' },
    });
    expect(fleetEvents[0]!.payload).not.toHaveProperty('isTrusted');
    expect(fleetEvents[0]).not.toHaveProperty('workflowId');
    expect(watchKeys).toEqual([]);
    expect(published).toEqual([]);
  });

  it('keeps token stream payloads out of events-read feeds and watch storage', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const fleetEventFeed = createFleetEventFeed(engine.storage);
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, { fleetEventFeed });

    engine.dispatchEvent(new TokenEvent('wf-token', 'secret-token', 'gpt-4'));

    await waitFor(
      async () => (await engine.storage.get(KEYS.streamTail('wf-token', 'tokens'))) !== null,
      { label: 'token stream chunk persisted' },
    );

    const fleetEvents: FleetEventEnvelope[] = [];
    for await (const envelope of fleetEventFeed.replay()) fleetEvents.push(envelope);
    const storedWatchEvent = await engine.storage.get(KEYS.watchEvent('wf-token', 0));
    handle.dispose();
    engine[Symbol.dispose]();

    expect(fleetEvents).toEqual([]);
    expect(storedWatchEvent).toBeNull();
  });

  it('continues token stream sequencing from a stored tail marker', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    await engine.storage.put(KEYS.streamTail('wf-tail', 'tokens'), encode({ sequence: 6 }));
    const published: Array<{ workflowId: string; sequence: number; message: string }> = [];
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
      publishTokenMessage(workflowId, sequence, message) {
        published.push({ workflowId, sequence, message });
      },
    });

    engine.dispatchEvent(new TokenEvent('wf-tail', 'tail-token', 'gpt-4'));

    await waitFor(async () => published.length === 1, { label: 'token stream published' });
    const tail = decode((await engine.storage.get(KEYS.streamTail('wf-tail', 'tokens')))!);
    handle.dispose();
    engine[Symbol.dispose]();

    expect(published[0]).toMatchObject({ workflowId: 'wf-tail', sequence: 7 });
    expect(tail).toEqual({ sequence: 7 });
  });

  it('continues token stream sequencing from existing chunk keys when no tail marker exists', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    await engine.storage.put(KEYS.streamChunk('wf-chunk', 'tokens', 4), encode({ token: 'old' }));
    const published: Array<{ sequence: number; message: string }> = [];
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
      publishTokenMessage(_workflowId, sequence, message) {
        published.push({ sequence, message });
      },
    });

    engine.dispatchEvent(new TokenEvent('wf-chunk', 'chunk-token', 'gpt-4'));

    await waitFor(async () => published.length === 1, { label: 'token stream published' });
    handle.dispose();
    engine[Symbol.dispose]();

    expect(published[0]!.sequence).toBe(5);
  });

  it('publishes watch events through the server channel when no direct watch publisher is supplied', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const published: Array<{ channel: string; message: string }> = [];
    const handle = wireEventBroadcasting(engine, {
      publish(channel: string, message: string) {
        published.push({ channel, message });
      },
    } as never);

    engine.dispatchEvent(new WorkflowSuspendedEvent('wf-watch-fallback'));

    await waitFor(async () => published.length === 1, { label: 'watch event published' });
    handle.dispose();
    engine[Symbol.dispose]();

    expect(published[0]!.channel).toBe('/v1/workflows/wf-watch-fallback/watch');
    expect(JSON.parse(published[0]!.message)).toMatchObject({
      type: WorkflowSuspendedEvent.type,
      sequence: 0,
      cursor: '0',
      data: { workflowId: 'wf-watch-fallback' },
    });
    expect(JSON.parse(published[0]!.message).data).toHaveProperty('isTrusted', false);
  });

  it('logs and suppresses fleet append failures', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
      fleetEventFeed: {
        append: async () => {
          throw new Error('fleet append failed');
        },
      } as never,
    });

    try {
      engine.dispatchEvent(new AlertFiredEvent('queue-depth', 10, 11));
      await waitFor(async () => logged.length === 1, { label: 'fleet append failure logged' });
    } finally {
      console.error = originalError;
      handle.dispose();
      engine[Symbol.dispose]();
    }

    expect(logged[0]![0]).toBe(`[weft] Failed to append fleet event "${AlertFiredEvent.type}":`);
    expect(logged[0]![1]).toBeInstanceOf(Error);
  });
});

describe('registerWorkflowEventLifecycle — cancellation propagation', () => {
  it('logs and continues when propagating a workflow cancellation to a task fails', async () => {
    class FailingLedgerReadStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (key === taskLedgerKey('op-cancel-fails')) {
          throw new Error('storage unavailable');
        }
        return super.get(key);
      }
    }

    const engine = new Engine();
    const context = minimalServerContext();
    const options = minimalServeOptions(new FailingLedgerReadStorage());
    context.workflowOperations.set('wf-cancel', new Set(['op-cancel-fails']));

    const cleanedUpWorkflows: string[] = [];
    const dispose = registerWorkflowEventLifecycle(
      engine,
      context,
      {
        dispose: () => Promise.resolve(),
        cleanupWorkflow: (workflowId) => cleanedUpWorkflows.push(workflowId),
      },
      options,
    );

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    engine.dispatchEvent(new WorkflowCancelledEvent('wf-cancel'));

    await waitFor(() => errorSpy.mock.calls.length > 0, {
      label: 'cancellation-propagation failure to be logged',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[weft] Failed to propagate workflow cancellation to task "op-cancel-fails":',
      expect.any(Error),
    );
    // The reverse-index entries are still cleaned up even though the
    // propagation attempt itself failed — the failure is logged, not fatal.
    expect(context.operationToWorkflow.has('op-cancel-fails')).toBe(false);
    expect(context.workflowOperations.has('wf-cancel')).toBe(false);

    dispose();
    engine[Symbol.dispose]();
  });
});
