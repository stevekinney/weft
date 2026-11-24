import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { decode } from '../core/codec.ts';
import { Engine } from '../core/engine/index.ts';
import { listWorkflowSources } from '../core/engine/source-listing.ts';
import { EventLog } from '../core/event-log.ts';
import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
} from '../core/events/catalog-events.ts';
import { workflow } from '../core/types.ts';
import { KEYS } from '../storage/keys.ts';
import {
  WorkflowDocumentValidationError,
  validateWorkflowDocument,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
} from './document.ts';
import { documentActivityOperation } from './interpreter.ts';
import { registerWorkflowDocuments } from './register.ts';

const handlerCalls: string[] = [];
const traces: { input: unknown; trigger: unknown; previous: unknown; signal: unknown }[] = [];
const identities: { workflowId: string; step: number; stepAddress?: string }[] = [];
let hangIdentify = false;
let mapActive = 0;
let mapMaximum = 0;
const retryMapAttempts: number[] = [];
let validationMapAttempts = 0;

const host: DocumentWorkflowHost = {
  activities: {
    greet: ({ input, trigger, previous }) => {
      handlerCalls.push('greet');
      return { greeting: input, trigger, previous };
    },
    shout: ({ input, previous }) => `${JSON.stringify(input)}:${JSON.stringify(previous)}`,
    explode: () => {
      handlerCalls.push('explode');
      throw new Error('handler exploded');
    },
    version: ({ input }) => input,
    'payments.charge': () => null,
    identify: ({ workflowId, step, stepAddress }) => {
      identities.push({ workflowId, step, ...(stepAddress === undefined ? {} : { stepAddress }) });
      return hangIdentify ? new Promise(() => undefined) : { workflowId, step };
    },
    trace: ({ input, trigger, previous, signal }) => {
      traces.push({ input, trigger, previous, signal });
      return input;
    },
    mapWork: async ({ input, previous, stepAddress }) => {
      mapActive++;
      mapMaximum = Math.max(mapMaximum, mapActive);
      await Bun.sleep(2);
      mapActive--;
      return { input, previous, stepAddress };
    },
    mapAfter: ({ previous, stepAddress }) => ({ previous, stepAddress }),
    mapUndefined: () => undefined,
    retryMap: {
      retry: { maxAttempts: 2, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: ({ previous }) => {
        const item = previous as number;
        retryMapAttempts.push(item);
        if (item === 1 && retryMapAttempts.filter((value) => value === 1).length === 1) {
          throw new Error('retry mapped item');
        }
        return item * 10;
      },
    },
    validationMap: {
      retry: {
        maxAttempts: 3,
        initialBackoff: 0,
        backoffMultiplier: 1,
        maxBackoff: 0,
        nonRetryableErrors: ['ValidationError'],
      },
      execute: () => {
        validationMapAttempts++;
        const error = new Error('invalid mapped item');
        error.name = 'ValidationError';
        throw error;
      },
    },
    mapFail: async ({ previous }) => {
      mapActive++;
      mapMaximum = Math.max(mapMaximum, mapActive);
      await Bun.sleep(2);
      mapActive--;
      if (previous === 3) throw new Error('map item failed');
      return previous;
    },
  },
  triggerKinds: { manual: () => undefined },
};

function createDocument(
  name: string,
  steps: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { name, trigger: { kind: 'manual' }, steps };
}

async function waitForParkedOnSignal(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const timeline = await engine.getTimeline(workflowId);
      return timeline.some((entry) => entry.operationType === 'wait-signal');
    },
    { label: `${workflowId} parked on its signal` },
  );
}

async function fileWorkflowEvents(engine: Engine, workflowId: string) {
  const events = await engine.getEvents(workflowId);
  return events
    .filter((event) => event.type.startsWith('file-workflow:'))
    .map(({ type, data }) => ({ type, data }));
}

describe('registerWorkflowDocuments()', () => {
  it('maps in order with per-item previous values and bounded concurrency', async () => {
    mapActive = 0;
    mapMaximum = 0;
    const document = createDocument('map-document', [
      { kind: 'activity', handler: 'version', input: { items: [1, 2, 3, 4, 5] } },
      {
        kind: 'map',
        over: 'items',
        concurrency: 2,
        steps: [{ kind: 'activity', handler: 'mapWork', input: 'work' }],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-document', null, { id: 'map-run' });
    expect(await run.result()).toEqual([
      { input: 'work', previous: 1, stepAddress: '2#0' },
      { input: 'work', previous: 2, stepAddress: '2#1' },
      { input: 'work', previous: 3, stepAddress: '2#2' },
      { input: 'work', previous: 4, stepAddress: '2#3' },
      { input: 'work', previous: 5, stepAddress: '2#4' },
    ]);
    expect(mapMaximum).toBe(2);
    const events = await fileWorkflowEvents(engine, 'map-run');
    expect(
      events
        .filter((event) => event.type === 'file-workflow:activity-started')
        .map((event) => event.data),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepAddress: '2#0' }),
        expect.objectContaining({ stepAddress: '2#1' }),
      ]),
    );
    expect(
      events
        .filter((event) => event.type === 'file-workflow:activity-completed')
        .map((event) => event.data),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepAddress: '2#0' }),
        expect.objectContaining({ stepAddress: '2#1' }),
      ]),
    );
  });

  it('defaults map concurrency to four iterations', async () => {
    mapActive = 0;
    mapMaximum = 0;
    const document = createDocument('map-default-concurrency', [
      { kind: 'activity', handler: 'version', input: { items: [1, 2, 3, 4, 5] } },
      {
        kind: 'map',
        over: 'items',
        steps: [{ kind: 'activity', handler: 'mapWork', input: 'work' }],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-default-concurrency', null, {
      id: 'map-default-concurrency-run',
    });
    await run.result();
    expect(mapMaximum).toBe(4);
  });

  it('runs every step in a mapped item before collecting its result', async () => {
    mapActive = 0;
    mapMaximum = 0;
    const document = createDocument('map-multi-step', [
      { kind: 'activity', handler: 'version', input: { items: [1, 2] } },
      {
        kind: 'map',
        over: 'items',
        steps: [
          { kind: 'activity', handler: 'mapWork', input: 'work' },
          { kind: 'activity', handler: 'mapAfter' },
        ],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-multi-step', null, { id: 'map-multi-step-run' });
    expect(await run.result()).toEqual([
      { previous: { input: 'work', previous: 1, stepAddress: '2#0' }, stepAddress: '3#0' },
      { previous: { input: 'work', previous: 2, stepAddress: '2#1' }, stepAddress: '3#1' },
    ]);
    expect(mapMaximum).toBe(2);
  });

  it('preserves an undefined result from a mapped item', async () => {
    const document = createDocument('map-undefined', [
      { kind: 'activity', handler: 'version', input: { items: [1] } },
      { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'mapUndefined' }] },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-undefined', null, { id: 'map-undefined-run' });
    expect(await run.result()).toEqual([undefined]);
  });

  it('retries a mapped activity through its originating item and does not duplicate siblings', async () => {
    retryMapAttempts.length = 0;
    const document = createDocument('map-retry', [
      { kind: 'activity', handler: 'version', input: { items: [1, 2] } },
      {
        kind: 'map',
        over: 'items',
        concurrency: 2,
        steps: [{ kind: 'activity', handler: 'retryMap' }],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-retry', null, { id: 'map-retry-run' });
    expect(await run.result()).toEqual([10, 20]);
    expect(retryMapAttempts).toEqual([1, 2, 1]);
  });

  it('fails a mapped activity on a non-retryable error without retrying it', async () => {
    validationMapAttempts = 0;
    const document = createDocument('map-non-retryable', [
      { kind: 'activity', handler: 'version', input: { items: [1] } },
      { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'validationMap' }] },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-non-retryable', null, { id: 'map-non-retryable-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('invalid mapped item');
    expect(validationMapAttempts).toBe(1);
  });

  it('retries a nested mapped activity through its originating item', async () => {
    retryMapAttempts.length = 0;
    const document = createDocument('nested-map-retry', [
      { kind: 'activity', handler: 'version', input: { groups: [{ items: [1, 2] }] } },
      {
        kind: 'map',
        over: 'groups',
        steps: [
          {
            kind: 'map',
            over: 'items',
            concurrency: 2,
            steps: [{ kind: 'activity', handler: 'retryMap' }],
          },
        ],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('nested-map-retry', null, { id: 'nested-map-retry-run' });
    expect(await run.result()).toEqual([[10, 20]]);
    expect(retryMapAttempts).toEqual([1, 2, 1]);
  });

  it('restarts a non-waiting map before a wait without moving the wait address', async () => {
    const storage = new MemoryStorage();
    const document = createDocument('map-before-wait', [
      { kind: 'activity', handler: 'version', input: { items: ['a'] } },
      { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'identify' }] },
      { kind: 'await-signal', signal: 'continue' },
      { kind: 'activity', handler: 'identify' },
    ]);
    let addressBeforeRestart: string | undefined;
    let stepIndexBeforeRestart: number | undefined;
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      const run = await original.start('map-before-wait', null, { id: 'map-before-wait-run' });
      await waitForParkedOnSignal(original, run.id);
      const timelineBeforeRestart = await original.getTimeline(run.id);
      const waiting = timelineBeforeRestart.find((entry) => entry.operationType === 'wait-signal');
      addressBeforeRestart = waiting?.documentStepAddress;
      stepIndexBeforeRestart = waiting?.stepIndex;
    }

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [run] = await restarted.recoverAll();
    expect(run?.id).toBe('map-before-wait-run');
    const timelineAfterRestart = await restarted.getTimeline(run!.id);
    const waitingAfterRestart = timelineAfterRestart.find(
      (entry) => entry.operationType === 'wait-signal',
    );
    const addressAfterRestart = waitingAfterRestart?.documentStepAddress;
    expect(addressAfterRestart).toBe(addressBeforeRestart);
    expect(addressAfterRestart).toBe('3');
    expect(waitingAfterRestart?.stepIndex).toBe(stepIndexBeforeRestart);
    expect(waitingAfterRestart?.stepIndex).toBe(3);
    await run!.signal('continue', null);
    await run!.result();
  });

  it('rejects non-array and over-limit map inputs with named errors', async () => {
    const nonArray = createDocument('map-not-array', [
      { kind: 'activity', handler: 'version', input: 'nope' },
      { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'version' }] },
    ]);
    const tooMany = createDocument('map-too-many', [
      {
        kind: 'activity',
        handler: 'version',
        input: { items: Array.from({ length: 1001 }, () => null) },
      },
      { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'version' }] },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [nonArray, tooMany] });
    const nonArrayRun = await engine.start('map-not-array', null, { id: 'map-not-array-run' });
    const tooManyRun = await engine.start('map-too-many', null, { id: 'map-too-many-run' });
    expect(await throwingRejectionOf(nonArrayRun.result())).toThrow(
      'requires field "items" of the previous result to be an array',
    );
    expect(await throwingRejectionOf(tooManyRun.result())).toThrow(
      'cannot iterate more than 1000 items',
    );
  });

  it('cleans up sibling iterations when one map item fails', async () => {
    mapActive = 0;
    mapMaximum = 0;
    const document = createDocument('map-cleanup', [
      { kind: 'activity', handler: 'version', input: { items: [1, 2, 3, 4] } },
      {
        kind: 'map',
        over: 'items',
        concurrency: 4,
        steps: [{ kind: 'activity', handler: 'mapFail' }],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-cleanup', null, { id: 'map-cleanup-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('map item failed');
    expect(mapActive).toBe(0);
  });

  it('runs wait-bearing map steps through the normal parent run with stable iteration addresses', async () => {
    identities.length = 0;
    const document = createDocument('map-wait', [
      { kind: 'activity', handler: 'version', input: { items: ['a', 'b'] } },
      {
        kind: 'map',
        over: 'items',
        concurrency: 2,
        steps: [
          { kind: 'await-signal', signal: 'continue' },
          { kind: 'activity', handler: 'identify' },
        ],
      },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('map-wait', null, { id: 'map-wait-run' });
    await run.signal('continue', { ok: true });
    await waitForCondition(async () => identities.length === 1, {
      label: 'first wait-bearing map iteration to complete',
    });
    const waiting = await engine.getTimeline(run.id);
    expect(
      waiting.filter((entry) => entry.operationType === 'wait-signal').length,
    ).toBeGreaterThanOrEqual(2);
    await run.signal('continue', { ok: true });
    await run.result();
    expect(identities.map(({ stepAddress }) => stepAddress)).toEqual(['3#0', '3#1']);
  });

  it('recovers a partially completed map without replaying effects, then cancels cleanly', async () => {
    identities.length = 0;
    const storage = new MemoryStorage();
    const document = createDocument('map-restart-cancel', [
      { kind: 'activity', handler: 'version', input: { items: ['a', 'b'] } },
      {
        kind: 'map',
        over: 'items',
        steps: [
          { kind: 'await-signal', signal: 'continue' },
          { kind: 'activity', handler: 'identify' },
        ],
      },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      const run = await original.start('map-restart-cancel', null, {
        id: 'map-restart-cancel-run',
      });
      await run.signal('continue', { item: 'a' });
      await waitForCondition(async () => identities.length === 1, {
        label: 'partial map result to commit before restart',
      });
    }

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [run] = await restarted.recoverAll();
    expect(run?.id).toBe('map-restart-cancel-run');
    await run!.cancel();
    expect(identities.map(({ stepAddress }) => stepAddress)).toEqual(['3#0']);
    const state = await restarted.get('map-restart-cancel-run');
    const timeline = await restarted.getTimeline('map-restart-cancel-run');
    expect(state?.status).toBe('cancelled');
    expect(
      timeline.some((entry) => entry.operationType === 'activity' && entry.status === 'running'),
    ).toBe(false);
  });
  it('runs only the matching branch case and continues with its result', async () => {
    traces.length = 0;
    const document = createDocument('branch-document', [
      { kind: 'activity', handler: 'version', input: { status: 'ready' } },
      {
        kind: 'branch',
        on: 'status',
        cases: {
          ready: [{ kind: 'activity', handler: 'trace', input: 'selected' }],
          waiting: [{ kind: 'activity', handler: 'trace', input: 'wrong' }],
        },
        otherwise: [{ kind: 'activity', handler: 'trace', input: 'fallback' }],
      },
      { kind: 'activity', handler: 'trace', input: 'after' },
    ]);

    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('branch-document', null, { id: 'branch-run' });
    expect(await run.result()).toBe('after');
    expect(traces.map(({ input }) => input)).toEqual(['selected', 'after']);
  });

  it('uses static preorder identities for a later branch case', async () => {
    identities.length = 0;
    const document = createDocument('branch-static-address', [
      { kind: 'activity', handler: 'version', input: { status: 'waiting' } },
      {
        kind: 'branch',
        on: 'status',
        cases: {
          ready: [{ kind: 'activity', handler: 'identify', input: 'ready' }],
          waiting: [{ kind: 'activity', handler: 'identify', input: 'waiting' }],
        },
        otherwise: [{ kind: 'activity', handler: 'identify', input: 'otherwise' }],
      },
    ]);

    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('branch-static-address', null, { id: 'branch-static-run' });

    expect(await run.result()).toEqual({ workflowId: 'branch-static-run', step: 3 });
    expect(identities).toEqual([{ workflowId: 'branch-static-run', step: 3, stepAddress: '3' }]);
  });

  it('recovers a parked nested step with the same address after case reordering', async () => {
    identities.length = 0;
    const original = createDocument('branch-recovery-address', [
      { kind: 'activity', handler: 'version', input: { status: 'waiting' } },
      {
        kind: 'branch',
        on: 'status',
        cases: {
          ready: [{ kind: 'activity', handler: 'greet', input: 'ready' }],
          waiting: [
            { kind: 'await-signal', signal: 'go' },
            { kind: 'activity', handler: 'identify' },
          ],
        },
      },
    ]);
    const reordered = createDocument('branch-recovery-address', [
      { kind: 'activity', handler: 'version', input: { status: 'waiting' } },
      {
        kind: 'branch',
        on: 'status',
        cases: {
          waiting: [
            { kind: 'await-signal', signal: 'go' },
            { kind: 'activity', handler: 'identify' },
          ],
          ready: [{ kind: 'activity', handler: 'greet', input: 'ready' }],
        },
      },
    ]);
    expect(await workflowDocumentVersion(validateWorkflowDocument(original, host))).toBe(
      await workflowDocumentVersion(validateWorkflowDocument(reordered, host)),
    );

    const storage = new MemoryStorage();
    {
      await using engine = new Engine({ storage });
      await registerWorkflowDocuments(engine, host, { active: [original] });
      await engine.start('branch-recovery-address', null, { id: 'branch-recovery-run' });
      await waitForParkedOnSignal(engine, 'branch-recovery-run');
    }

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [reordered] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('go', null);
    expect(await handle!.result()).toEqual({ workflowId: 'branch-recovery-run', step: 4 });
    expect(identities).toEqual([{ workflowId: 'branch-recovery-run', step: 4, stepAddress: '4' }]);
  });

  it('fails a branch with no matching case or otherwise using a named error', async () => {
    const document = createDocument('branch-no-match', [
      { kind: 'activity', handler: 'greet', input: { status: 'missing' } },
      { kind: 'branch', on: 'status', cases: { ready: [{ kind: 'activity', handler: 'greet' }] } },
    ]);

    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('branch-no-match', null, { id: 'branch-no-match-run' });

    const rejected = await throwingRejectionOf(run.result());
    expect(rejected).toThrow('Branch has no matching case for field "status"');
  });

  it('records durable lifecycle history for document steps', async () => {
    const document = createDocument('document-history', [
      { kind: 'activity', handler: 'greet', input: 'hello' },
      { kind: 'await-signal', signal: 'approve' },
    ]);

    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('document-history', null, { id: 'document-history-run' });
    await waitForParkedOnSignal(engine, run.id);
    const fileEvents = () => fileWorkflowEvents(engine, run.id);
    expect(await fileEvents()).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:activity-started', data: { step: 0, handler: 'greet' } },
      { type: 'file-workflow:activity-completed', data: { step: 0, handler: 'greet' } },
      { type: 'file-workflow:step-completed', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:step-started', data: { step: 1, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 1, signal: 'approve' } },
    ]);

    await run.signal('approve', null);
    await run.result();
    expect(await fileEvents()).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:activity-started', data: { step: 0, handler: 'greet' } },
      { type: 'file-workflow:activity-completed', data: { step: 0, handler: 'greet' } },
      { type: 'file-workflow:step-completed', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:step-started', data: { step: 1, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 1, signal: 'approve' } },
      { type: 'file-workflow:signal-received', data: { step: 1, signal: 'approve' } },
      { type: 'file-workflow:step-completed', data: { step: 1, kind: 'await-signal' } },
      { type: 'file-workflow:run-terminal', data: { status: 'completed' } },
    ]);
  });

  it('records a received event for a signal delivered before the wait parks', async () => {
    const document = createDocument('buffered-document', [
      { kind: 'activity', handler: 'greet', input: 'hello' },
      { kind: 'await-signal', signal: 'approve' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('buffered-document', null, { id: 'buffered-run' });
    await run.signal('approve', { secret: 'not recorded' });
    await run.result();
    expect(await fileWorkflowEvents(engine, run.id)).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:activity-started', data: { step: 0, handler: 'greet' } },
      { type: 'file-workflow:activity-completed', data: { step: 0, handler: 'greet' } },
      { type: 'file-workflow:step-completed', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:step-started', data: { step: 1, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 1, signal: 'approve' } },
      { type: 'file-workflow:signal-received', data: { step: 1, signal: 'approve' } },
      { type: 'file-workflow:step-completed', data: { step: 1, kind: 'await-signal' } },
      { type: 'file-workflow:run-terminal', data: { status: 'completed' } },
    ]);
  });

  it('registers two documents as two workflow types and runs each', async () => {
    const documentA = createDocument('document-a', [
      { kind: 'activity', handler: 'greet', input: 'hello' },
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'activity', handler: 'shout', input: 'done' },
    ]);
    const documentB = createDocument('document-b', [
      { kind: 'activity', handler: 'greet', input: 'second' },
    ]);

    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const registered = await registerWorkflowDocuments(engine, host, {
      active: [documentA, documentB],
    });

    expect(registered.map((entry) => entry.name)).toEqual(['document-a', 'document-b']);

    const runA = await engine.start('document-a', { fire: 1 }, { id: 'run-a' });
    const runB = await engine.start('document-b', { fire: 2 }, { id: 'run-b' });

    expect(await runB.result()).toEqual({
      greeting: 'second',
      trigger: { fire: 2 },
      previous: null,
    });
    await runA.signal('approve', { by: 'owner' });
    expect(await runA.result()).toBe(
      '"done":{"greeting":"hello","trigger":{"fire":1},"previous":null}',
    );
  });

  it('preserves activity output across waits and delivers the signal payload once', async () => {
    traces.length = 0;
    const document = createDocument('previous-values', [
      { kind: 'sleep', duration: 1 },
      { kind: 'activity', handler: 'trace', input: 'a' },
      { kind: 'activity', handler: 'trace', input: 'b' },
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'trace', input: 'c' },
      { kind: 'sleep', duration: 1 },
      { kind: 'activity', handler: 'trace', input: 'd' },
      { kind: 'sleep', duration: 1 },
    ]);
    // Keep the real scheduler for the sleep steps, with a short poll interval for this fixture.
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      schedulerPollIntervalMs: 10,
    });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('previous-values', 'fire', { id: 'previous-run' });
    await run.signal('go', { payload: true });

    expect(await run.result()).toBe('d');
    expect(traces).toEqual([
      { input: 'a', trigger: 'fire', previous: null, signal: undefined },
      { input: 'b', trigger: 'fire', previous: 'a', signal: undefined },
      { input: 'c', trigger: 'fire', previous: 'b', signal: { payload: true } },
      { input: 'd', trigger: 'fire', previous: 'c', signal: undefined },
    ]);
  });

  it('fails the instance with the handler error and does not retry the step', async () => {
    handlerCalls.length = 0;
    const document = createDocument('failing-document', [{ kind: 'activity', handler: 'explode' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('failing-document', null, { id: 'failing-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('handler exploded');
    expect(handlerCalls).toEqual(['explode']);
    const failed = await engine.get('failing-run');
    expect(failed?.status).toBe('failed');
    expect(await fileWorkflowEvents(engine, 'failing-run')).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'activity' } },
      { type: 'file-workflow:activity-started', data: { step: 0, handler: 'explode' } },
      {
        type: 'file-workflow:run-terminal',
        data: { status: 'failed', message: 'Workflow run failed.' },
      },
    ]);
  });

  it('records one cancelled terminal event without completing the interrupted step', async () => {
    const document = createDocument('cancelled-document', [
      { kind: 'await-signal', signal: 'approve' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('cancelled-document', null, { id: 'cancelled-run' });
    await waitForParkedOnSignal(engine, run.id);
    await run.cancel();
    expect(await fileWorkflowEvents(engine, run.id)).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 0, signal: 'approve' } },
      { type: 'file-workflow:run-terminal', data: { status: 'cancelled' } },
    ]);
  });

  it('preserves the event chain when a second engine cancels after a checkpoint race', async () => {
    const document = createDocument('cancel-race-document', [
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'activity', handler: 'identify' },
    ]);
    const storage = new MemoryStorage();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    const gatedStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (
            conditions: Parameters<NonNullable<typeof storage.conditionalBatch>>[0],
            operations: Parameters<NonNullable<typeof storage.conditionalBatch>>[1],
          ) => {
            const cancelling = operations.some(
              (operation) =>
                operation.type === 'put' &&
                operation.key === KEYS.workflow('cancel-race-run') &&
                (decode(operation.value) as { status?: string }).status === 'cancelled',
            );
            if (armed && cancelling) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    await using engineB = new Engine({ storage: gatedStorage, backgroundTasks: 'manual' });
    try {
      await registerWorkflowDocuments(engineA, host, { active: [document] });
      await registerWorkflowDocuments(engineB, host, { active: [document] });
      const run = await engineA.start('cancel-race-document', null, { id: 'cancel-race-run' });
      await waitForParkedOnSignal(engineA, run.id);
      hangIdentify = true;
      const cancellation = engineB.cancel(run.id);
      await reached.promise;
      await engineA.signal(run.id, 'approve');
      release.resolve();
      await cancellation;
      hangIdentify = false;
      const events = await engineA.getEvents(run.id);
      const fileEvents = events.filter((event) => event.type.startsWith('file-workflow:'));
      expect(fileEvents.at(-1)?.type).toBe('file-workflow:run-terminal');
      expect(
        fileEvents.filter((event) => event.type === 'file-workflow:run-terminal'),
      ).toHaveLength(1);
      const verification = await new EventLog(storage, run.id).verify();
      expect(verification.valid).toBe(true);
    } finally {
      hangIdentify = false;
      release.resolve();
    }
  });

  it('records a safe timed-out terminal event', async () => {
    const document = createDocument('timed-out-document', [
      { kind: 'await-signal', signal: 'approve' },
    ]);
    let now = 1_000;
    await using engine = new Engine({ storage: new MemoryStorage(), getNow: () => now });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('timed-out-document', null, {
      id: 'timed-out-run',
      executionTimeout: 5_000,
    });
    await waitForParkedOnSignal(engine, run.id);
    now = 6_001;
    await engine.scheduler.tick(now);
    expect(await throwingRejectionOf(run.result())).toThrow('exceeded execution timeout');
    expect(await fileWorkflowEvents(engine, run.id)).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 0, signal: 'approve' } },
      {
        type: 'file-workflow:run-terminal',
        data: { status: 'timed-out', message: 'Workflow run timed out.' },
      },
    ]);
  });

  it("carries the document version in the contract's workflowVersion and lists its activity steps", async () => {
    const document = createDocument('contract-document', [
      { kind: 'activity', handler: 'greet' },
      { kind: 'activity', handler: 'shout', input: 'x' },
      { kind: 'activity', handler: 'greet' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const [registered] = await registerWorkflowDocuments(engine, host, { active: [document] });

    const record = await engine.workflows.getRevision('contract-document', registered!.revision);

    expect(registered!.workflowVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record?.manifest.workflowVersion).toBe(registered!.workflowVersion);
    expect(record?.manifest.contract.workflowVersion).toBe(registered!.workflowVersion);
    expect(Object.keys(record?.manifest.contract.activities ?? {}).toSorted()).toEqual([
      'greet',
      'shout',
    ]);
  });

  it('declares the signals a document awaits in its contract, and none when it awaits none', async () => {
    const awaiting = createDocument('awaiting-document', [
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'activity', handler: 'greet' },
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'await-signal', signal: 'cancel' },
    ]);
    const plain = createDocument('plain-document', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const [withSignals, withoutSignals] = await registerWorkflowDocuments(engine, host, {
      active: [awaiting, plain],
    });

    const awaitingRecord = await engine.workflows.getRevision(
      'awaiting-document',
      withSignals!.revision,
    );
    const plainRecord = await engine.workflows.getRevision(
      'plain-document',
      withoutSignals!.revision,
    );

    expect(Object.keys(awaitingRecord?.manifest.contract.signals ?? {}).toSorted()).toEqual([
      'approve',
      'cancel',
    ]);
    expect(plainRecord?.manifest.contract.signals).toBeUndefined();
  });

  it('gives identical content the same revision and a one-step change a new one', async () => {
    const steps = [
      { kind: 'activity', handler: 'shout', input: 'a' },
      { kind: 'await-signal', signal: 'go' },
    ];
    const registerOn = async (candidate: Record<string, unknown>) => {
      await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
      const [registered] = await registerWorkflowDocuments(engine, host, { active: [candidate] });
      return registered!;
    };

    const first = await registerOn(createDocument('revisions', steps));
    const again = await registerOn(createDocument('revisions', structuredClone(steps)));
    const changed = await registerOn(
      createDocument('revisions', [{ kind: 'activity', handler: 'shout', input: 'b' }, steps[1]!]),
    );

    expect(again).toEqual(first);
    expect(changed.workflowVersion).not.toBe(first.workflowVersion);
    expect(changed.revision).not.toBe(first.revision);
  });

  it('keeps a running instance on the revision it started on', async () => {
    const version1 = createDocument('versioned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'one' },
    ]);
    const version2 = createDocument('versioned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'two' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [version1] });
    const oldRun = await engine.start('versioned', null, { id: 'old-run' });

    const [registered] = await registerWorkflowDocuments(engine, host, {
      active: [version2],
      retained: [version1],
    });
    const newRun = await engine.start('versioned', null, { id: 'new-run' });
    await newRun.signal('go', null);
    await oldRun.signal('go', null);

    expect(await newRun.result()).toBe('two');
    expect(await oldRun.result()).toBe('one');
    const active = await engine.workflows.getActive('versioned');
    expect(active?.revision).toBe(registered!.revision);
  });

  it('announces each document revision as installed and activated, and the displaced one as draining', async () => {
    const version1 = createDocument('announced', [
      { kind: 'activity', handler: 'greet', input: 1 },
    ]);
    const version2 = createDocument('announced', [
      { kind: 'activity', handler: 'greet', input: 2 },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const seen: string[] = [];
    engine.addEventListener(WorkflowRevisionInstalledEvent.type, () => seen.push('installed'));
    engine.addEventListener(WorkflowRevisionDrainingEvent.type, () => seen.push('draining'));
    engine.addEventListener(WorkflowRevisionActivatedEvent.type, () => seen.push('activated'));

    await registerWorkflowDocuments(engine, host, { active: [version1] });
    await registerWorkflowDocuments(engine, host, { active: [version2], retained: [version1] });

    expect(seen).toEqual(['installed', 'activated', 'installed', 'draining', 'activated']);
  });

  it('is idempotent for a document that is already registered', async () => {
    const document = createDocument('repeated', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    const first = await registerWorkflowDocuments(engine, host, { active: [document] });
    const second = await registerWorkflowDocuments(engine, host, { active: [document] });

    expect(second).toEqual(first);
  });

  it('rejects an invalid document before registering anything', async () => {
    const valid = createDocument('valid-document', [{ kind: 'activity', handler: 'greet' }]);
    const invalid = createDocument('invalid-document', [{ kind: 'activity', handler: 'missing' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [valid, invalid] }),
      ),
    ).toThrow(WorkflowDocumentValidationError);
    expect(listWorkflowSources(engine)).toEqual([]);
  });

  it('rejects a handler that is not a wire-safe activity name before registering anything', async () => {
    const valid = createDocument('valid-document', [{ kind: 'activity', handler: 'greet' }]);
    const dotted = createDocument('dotted-document', [
      { kind: 'activity', handler: 'payments.charge' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [valid, dotted] }),
      ),
    ).toThrow(WorkflowDocumentValidationError);
    expect(listWorkflowSources(engine)).toEqual([]);
  });

  it('rejects a document named like a code workflow before registering anything', async () => {
    const valid = createDocument('valid-document', [{ kind: 'activity', handler: 'greet' }]);
    const clashing = createDocument('code-workflow', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    engine.register(
      workflow({ name: 'code-workflow' }).execute(async function* () {
        return 'code';
      }),
    );

    for (const documents of [
      { active: [valid, clashing] },
      { active: [valid], retained: [clashing] },
    ]) {
      expect(await throwingRejectionOf(registerWorkflowDocuments(engine, host, documents))).toThrow(
        WorkflowDocumentValidationError,
      );
    }
    expect(listWorkflowSources(engine)).toEqual([]);
  });

  it('rejects two active documents for one name', async () => {
    const first = createDocument('twice', [{ kind: 'activity', handler: 'greet' }]);
    const second = createDocument('twice', [{ kind: 'activity', handler: 'shout' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [first, second] }),
      ),
    ).toThrow(WorkflowDocumentValidationError);
    expect(listWorkflowSources(engine)).toEqual([]);
  });
});

describe('a Weft schedule targeting a document type', () => {
  it('fires an instance with the fire as its trigger', async () => {
    const document = createDocument('scheduled-document', [
      { kind: 'activity', handler: 'greet', input: 'tick' },
    ]);
    const clock = { now: Date.UTC(2026, 0, 1) };
    await using engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
    });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const fire = { source: 'schedule', occurrence: 1 };
    const schedule = await engine.schedule(
      'scheduled-document',
      fire,
      { every: '1m' },
      { id: 'tick' },
    );
    const summary = await schedule.describe();
    const nextFireAt = summary.nextFireAt!;
    clock.now = nextFireAt;
    await engine.scheduler.tick(clock.now);

    await waitForCondition(
      async () => {
        const page = await engine.list({ type: 'scheduled-document' });
        return page.items.some((state) => state.status === 'completed');
      },
      { label: 'scheduled document instance to complete' },
    );
    const { items } = await engine.list({ type: 'scheduled-document' });
    const completed = await engine.get(items[0]!.id);
    expect(completed?.result).toEqual({
      greeting: 'tick',
      trigger: fire,
      previous: null,
    });
  });
});

describe('restarting after a crash', () => {
  it('resumes an instance parked on await-signal from that step, without rerunning the steps before it', async () => {
    traces.length = 0;
    const storage = new MemoryStorage();
    const document = createDocument('crash-signal', [
      { kind: 'activity', handler: 'trace', input: 'before' },
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'trace', input: 'after' },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('crash-signal', null, { id: 'crash-signal-run' });
      await waitForParkedOnSignal(original, 'crash-signal-run');
    }
    expect(traces.map((entry) => entry.input)).toEqual(['before']);

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('go', 'resumed');

    expect(await handle!.result()).toBe('after');
    expect(traces.map((entry) => entry.input)).toEqual(['before', 'after']);
  });

  it('finishes a run pinned to a retained revision after a restart, while new runs use the active one', async () => {
    const storage = new MemoryStorage();
    const version1 = createDocument('pinned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'one' },
    ]);
    const version2 = createDocument('pinned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'two' },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [version1] });
      await original.start('pinned', null, { id: 'pinned-old-run' });
      await waitForParkedOnSignal(original, 'pinned-old-run');
    }

    await using restarted = new Engine({ storage });
    const [active] = await registerWorkflowDocuments(restarted, host, {
      active: [version2],
      retained: [version1],
    });
    const [recovered] = await restarted.recoverAll();
    const fresh = await restarted.start('pinned', null, { id: 'pinned-new-run' });
    await recovered!.signal('go', null);
    await fresh.signal('go', null);

    expect(recovered!.id).toBe('pinned-old-run');
    expect(await recovered!.result()).toBe('one');
    expect(await fresh.result()).toBe('two');
    const pointer = await restarted.workflows.getActive('pinned');
    expect(pointer?.revision).toBe(active!.revision);
  });

  it('records cancellation for a suspended retained revision while a newer revision is active', async () => {
    const storage = new MemoryStorage();
    const version1 = createDocument('retained-cancel', [{ kind: 'await-signal', signal: 'go' }]);
    const version2 = createDocument('retained-cancel', [{ kind: 'activity', handler: 'version' }]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [version1] });
      await original.start('retained-cancel', null, { id: 'retained-cancel-run' });
      await waitForParkedOnSignal(original, 'retained-cancel-run');
    }

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [version2], retained: [version1] });
    await restarted.cancel('retained-cancel-run');

    const events = await restarted.getEvents('retained-cancel-run');
    const fileEvents = events.filter((event) => event.type.startsWith('file-workflow:'));
    expect(fileEvents.at(-1)).toMatchObject({
      type: 'file-workflow:run-terminal',
      data: { status: 'cancelled' },
    });
  });

  it('resumes an instance parked on sleep from that step', async () => {
    const storage = new MemoryStorage();
    const document = createDocument('crash-sleep', [
      { kind: 'activity', handler: 'shout', input: 'before' },
      { kind: 'sleep', duration: '1m' },
      { kind: 'activity', handler: 'shout', input: 'after' },
    ]);
    const startedAt = Date.UTC(2026, 0, 1);
    {
      await using original = new Engine({ storage, getNow: () => startedAt });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('crash-sleep', null, { id: 'crash-sleep-run' });
      await waitForCondition(
        async () => {
          const timeline = await original.getTimeline('crash-sleep-run');
          return timeline.some((entry) => entry.operationType === 'sleep');
        },
        { label: 'instance parked on its sleep' },
      );
    }

    await using restarted = new Engine({ storage, getNow: () => startedAt + 61_000 });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();

    expect(await handle!.result()).toBe('"after":"\\"before\\":null"');
  });
});

describe('the identity every activity handler receives', () => {
  it('names the instance and the zero-based index of the step among all steps', async () => {
    identities.length = 0;
    hangIdentify = false;
    const document = createDocument('identity-steps', [
      { kind: 'sleep', duration: 1 },
      { kind: 'activity', handler: 'identify' },
      { kind: 'activity', handler: 'identify' },
    ]);
    await using engine = await Engine.create({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('identity-steps', null, { id: 'identity-run' });

    expect(await run.result()).toEqual({ workflowId: 'identity-run', step: 2 });
    expect(identities).toEqual([
      { workflowId: 'identity-run', step: 1, stepAddress: '1' },
      { workflowId: 'identity-run', step: 2, stepAddress: '2' },
    ]);
  });

  it('gives a step that a restart re-executes the same workflow id and step', async () => {
    identities.length = 0;
    const storage = new MemoryStorage();
    const document = createDocument('identity-restart', [
      { kind: 'activity', handler: 'trace', input: 'first' },
      { kind: 'activity', handler: 'identify' },
    ]);
    hangIdentify = true;
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('identity-restart', null, { id: 'identity-restart-run' });
      await waitForCondition(async () => identities.length === 1, {
        label: 'the identify step to start',
      });
    }
    hangIdentify = false;

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();

    expect(await handle!.result()).toEqual({ workflowId: 'identity-restart-run', step: 1 });
    expect(identities).toEqual([
      { workflowId: 'identity-restart-run', step: 1, stepAddress: '1' },
      { workflowId: 'identity-restart-run', step: 1, stepAddress: '1' },
    ]);
  });
});

describe('document activity retry addressing', () => {
  it('restamps an activity yielded after a retry operation throws', () => {
    const operation = (function* () {
      try {
        yield { type: 'activity' };
      } catch {
        yield { type: 'activity' };
      }
    })();
    const wrapped = documentActivityOperation(operation, 4, '4#summaries.0');
    wrapped.next();
    const retry = wrapped.throw(new Error('retry'));
    expect(retry.value).toMatchObject({
      type: 'activity',
      documentStep: 4,
      documentStepAddress: '4#summaries.0',
    });
  });
});
