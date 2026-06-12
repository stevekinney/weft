import { describe, expect, it } from 'bun:test';
import type { ActivityContext, WorkflowContext } from '../core/types.ts';
import { activity, signal } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import type { WeftClient } from './interface.ts';

type ClientContractWorkflowTypes = {
  echo: string;
  waiting: string;
  waitingObject: string;
  waitingTwice: string;
  asyncActivity: string;
};

type ClientContractTestOptions = {
  label: string;
  getClient: () => WeftClient;
  idPrefix: string;
  workflowTypes: ClientContractWorkflowTypes;
  waitForRunning?: (workflowId: string) => Promise<void>;
  /**
   * Resolve with the durable task token the next time the underlying engine
   * parks an async activity. Each harness wires this to its engine's
   * `activity:async-pending` event.
   */
  captureNextAsyncToken: () => Promise<string>;
  /**
   * The engine's configured `payloadSize.maxBytes`. The payload-size contract
   * test sends a completion result larger than this and asserts both transports
   * reject it.
   */
  asyncResultCapBytes: number;
  /**
   * Assert that `error` is the transport's "token not found" rejection — a
   * `NotFound` 404 over HTTP, an `AsyncActivityTokenNotFoundError` in process.
   * Each harness supplies the per-transport check so the cross-transport
   * contract verifies the *kind* of rejection, not merely that it rejected (a
   * masked 500 would otherwise pass a bare "rejected" assertion).
   */
  expectTokenNotFound: (error: unknown) => void;
};

const sharedWeftClientMethodNames = [
  'start',
  'startOrSignal',
  'schedule',
  'get',
  'getSchedule',
  'list',
  'listSchedules',
  'cancel',
  'pauseSchedule',
  'resumeSchedule',
  'cancelSchedule',
  'updateSchedule',
  'signal',
  'query',
  'update',
  'resume',
  'recoverAll',
  'getHandle',
  'timeout',
  'getAttributes',
  'setAttributes',
  'addTags',
  'removeTags',
  'getEvents',
  'tail',
  'getTimeline',
  'replayTo',
  'listReviews',
  'submitReview',
  'getStreamChunks',
  'fork',
  'getRetentionOverview',
  'purge',
  'cancelAll',
  'signalAll',
  'deleteAll',
  'tagAll',
  'untagAll',
  'submitCoordinatedUpdate',
  'getUpdateResult',
] as const satisfies readonly (keyof WeftClient)[];

export function expectSharedWeftClientMethodSurface(client: WeftClient): void {
  for (const methodName of sharedWeftClientMethodNames) {
    expect(client[methodName], `WeftClient.${methodName}`).toBeFunction();
  }
  expect(client.activity.complete, 'WeftClient.activity.complete').toBeFunction();
  expect(
    client.activity.completeExceptionally,
    'WeftClient.activity.completeExceptionally',
  ).toBeFunction();
}

export const clientContractEchoWorkflow = workflow({ name: 'client-contract-echo' }).execute(
  async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  },
);

export const clientContractWaitingWorkflow = workflow({
  name: 'client-contract-waiting',
}).execute(async function* (ctx: WorkflowContext, input: unknown) {
  ctx.expose({ ready: () => true });
  ctx.onQuery('echoInput', (queryInput) => queryInput);
  ctx.onUpdate('rename', (payload) => ({
    accepted: true,
    input,
    payload,
  }));

  const receivedSignal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${receivedSignal}`;
});

const clientContractContinueSignal = signal('continue');
const clientContractObjectSignal = signal<{ signalId: string }>('object-signal');

export const clientContractWaitingTwiceWorkflow = workflow({
  name: 'client-contract-waiting-twice',
}).execute(async function* (ctx: WorkflowContext, input: unknown) {
  ctx.expose({ ready: () => true });

  yield* ctx.waitForSignal(clientContractContinueSignal);
  yield* ctx.waitForSignal(clientContractContinueSignal);
  return `${String(input)}:done`;
});

export const clientContractWaitingObjectWorkflow = workflow({
  name: 'client-contract-waiting-object',
}).execute(async function* (ctx: WorkflowContext, input: unknown) {
  ctx.expose({ ready: () => true });

  const payload = yield* ctx.waitForSignal(clientContractObjectSignal);
  return `${String(input)}:${payload.signalId}`;
});

/**
 * Activity that hands off to out-of-band completion. `completeAsync()` throws to
 * suspend, so the body never returns normally — the workflow parks until an
 * external caller resolves it by token through `client.activity`.
 */
const clientContractAwaitCallback = activity({
  name: 'clientContractAwaitCallback',
  execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
});

export const clientContractAsyncActivityWorkflow = workflow({
  name: 'client-contract-async-activity',
})
  .activities({ clientContractAwaitCallback })
  .execute(async function* (ctx: WorkflowContext, input: unknown) {
    const resolved = yield* ctx.run(clientContractAwaitCallback);
    return { input, resolved };
  });

export async function waitForQueryReadyForTesting(
  client: WeftClient,
  workflowId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await client.query(workflowId, 'ready')) === true) {
      return;
    }

    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not expose query handlers`);
}

/**
 * Resolve when the workflow emits `type`, or reject if the deadline passes.
 * The deadline doubles as a regression guard: a value well under the old
 * 2-second poll interval proves events are delivered push-based, not polled.
 */
export function waitForHandleEventForTesting(
  handle: { addEventListener: (type: string, listener: (event: Event) => void) => void },
  type: string,
  timeoutMs: number,
): Promise<Event> {
  return new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`workflow event "${type}" did not arrive within ${timeoutMs}ms`));
    }, timeoutMs);
    handle.addEventListener(type, (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

export function runWeftClientContractTests(options: ClientContractTestOptions): void {
  const { getClient, idPrefix, label, waitForRunning, workflowTypes } = options;

  describe(`${label}: shared streaming contract`, () => {
    it('delivers handle.addEventListener events push-based, not on a 2s poll', async () => {
      const client = getClient();
      const handle = await client.start(workflowTypes.waiting, 'stream', {
        id: `${idPrefix}-stream-listener`,
      });

      await waitForRunning?.(handle.id);
      await waitForQueryReadyForTesting(client, handle.id);

      // A 1-second budget is comfortably under the 2-second poll cadence the
      // old HttpHandle used, so this fails loudly if streaming regresses to
      // polling. Attach the listener, wait for the stream to be live (so no
      // event is missed in the connect window), then signal.
      const completed = waitForHandleEventForTesting(handle, 'workflow:completed', 1000);
      await handle.whenConnected();
      await handle.signal('continue', 'done');
      const event = await completed;
      expect(event.type).toBe('workflow:completed');

      expect(await handle.result()).toBe('stream:done');
    });

    it('client.tail async-iterates events and terminates cleanly on completion', async () => {
      const client = getClient();
      const handle = await client.start(workflowTypes.waiting, 'tail', {
        id: `${idPrefix}-tail`,
      });

      await waitForRunning?.(handle.id);
      await waitForQueryReadyForTesting(client, handle.id);

      const tail = client.tail(handle.id);
      const seen: string[] = [];
      const consume = (async () => {
        for await (const event of tail) {
          seen.push(event.type);
        }
      })();

      // Wait for the tail to be live before advancing the workflow so no event
      // is missed in the connect window.
      await tail.whenConnected();
      await handle.signal('continue', 'done');

      // The tail must terminate on its own when the workflow completes; if it
      // hangs, this race rejects so the test fails instead of timing out.
      await Promise.race([
        consume,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `client.tail did not terminate on completion; seen=${JSON.stringify(seen)}`,
                ),
              ),
            2000,
          ),
        ),
      ]);

      expect(seen).toContain('workflow:completed');
      expect(await handle.result()).toBe('tail:done');
    });

    it('handle.tail yields events through the same surface as client.tail', async () => {
      const client = getClient();
      const handle = await client.start(workflowTypes.waiting, 'handle-tail', {
        id: `${idPrefix}-handle-tail`,
      });

      await waitForRunning?.(handle.id);
      await waitForQueryReadyForTesting(client, handle.id);

      const tail = handle.tail();
      const seen: string[] = [];
      const consume = (async () => {
        for await (const event of tail) {
          seen.push(event.type);
        }
      })();

      await tail.whenConnected();
      await handle.signal('continue', 'done');
      await Promise.race([
        consume,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`handle.tail did not terminate; seen=${JSON.stringify(seen)}`)),
            2000,
          ),
        ),
      ]);

      expect(seen).toContain('workflow:completed');
    });
  });

  describe(`${label}: shared WeftClient contract`, () => {
    it('passes query input and update payloads through client and handle methods', async () => {
      const client = getClient();
      const handle = await client.start(workflowTypes.waiting, 'payload', {
        id: `${idPrefix}-query-update`,
      });

      await waitForRunning?.(handle.id);
      await waitForQueryReadyForTesting(client, handle.id);

      await expect(client.query(handle.id, 'echoInput', { detail: true })).resolves.toEqual({
        detail: true,
      });
      await expect(handle.query('echoInput', { source: 'handle' })).resolves.toEqual({
        source: 'handle',
      });
      await expect(
        client.update(handle.id, 'rename', { source: 'client' }, { timeout: 1000 }),
      ).resolves.toEqual({
        accepted: true,
        input: 'payload',
        payload: { source: 'client' },
      });
      await expect(
        handle.update('rename', { source: 'handle' }, { timeout: 1000 }),
      ).resolves.toEqual({
        accepted: true,
        input: 'payload',
        payload: { source: 'handle' },
      });

      await handle.signal('continue', 'done');
      await expect(handle.result()).resolves.toBe('payload:done');
    });

    it('getHandle re-attaches to a running workflow and awaits its result', async () => {
      const client = getClient();
      const started = await client.start(workflowTypes.waiting, 'reattach', {
        id: `${idPrefix}-get-handle-running`,
      });

      await waitForRunning?.(started.id);
      await waitForQueryReadyForTesting(client, started.id);

      // Re-attach with only the id — no reference to the original handle.
      const reattached = await client.getHandle(started.id);
      if (reattached === null) throw new Error('getHandle returned null for a running workflow');
      expect(reattached.id).toBe(started.id);

      await reattached.signal('continue', 'done');
      const reattachedResult = (await reattached.result()) as string;
      expect(reattachedResult).toBe('reattach:done');
    });

    it('getHandle on an already-terminal workflow resolves result() from persisted state', async () => {
      const client = getClient();
      const started = await client.start(workflowTypes.echo, 'finished', {
        id: `${idPrefix}-get-handle-terminal`,
      });
      // Let it run to completion before re-attaching, so result() must come from
      // persisted state rather than a live in-flight subscription.
      await expect(started.result()).resolves.toBe('finished');

      const reattached = await client.getHandle(started.id);
      if (reattached === null) throw new Error('getHandle returned null for a terminal workflow');
      const reattachedResult = (await reattached.result()) as string;
      expect(reattachedResult).toBe('finished');
    });

    it('getHandle returns null for an unknown workflow id', async () => {
      const client = getClient();
      await expect(client.getHandle(`${idPrefix}-get-handle-missing`)).resolves.toBeNull();
    });

    it('round-trips workflow attributes and tag mutations through handle helpers', async () => {
      const client = getClient();
      const handle = await client.start(workflowTypes.waiting, 'tagged', {
        id: `${idPrefix}-attributes-tags`,
        tags: ['initial'],
      });

      await waitForRunning?.(handle.id);
      await waitForQueryReadyForTesting(client, handle.id);

      await handle.setAttributes({ priority: 'high' });
      await expect(handle.getAttributes()).resolves.toEqual({ priority: 'high' });
      await client.setAttributes(handle.id, { owner: 'contract', priority: 'critical' });
      await expect(client.getAttributes(handle.id)).resolves.toEqual({
        owner: 'contract',
        priority: 'critical',
      });

      await handle.addTags('beta', 'release-candidate');
      await handle.removeTags('initial');
      await expect(client.get(handle.id)).resolves.toMatchObject({
        tags: ['beta', 'release-candidate'],
      });

      await handle.signal('continue', 'done');
      await expect(handle.result()).resolves.toBe('tagged:done');
    });

    it('deduplicates typed zero-payload signalIds through client and handle methods', async () => {
      const client = getClient();
      const handle = await client.start(workflowTypes.waitingTwice, 'signal-id', {
        id: `${idPrefix}-signal-id`,
      });

      await waitForRunning?.(handle.id);
      await waitForQueryReadyForTesting(client, handle.id);

      await client.signal(handle.id, clientContractContinueSignal, undefined, {
        signalId: 'first',
      });
      await client.signal(handle.id, clientContractContinueSignal, undefined, {
        signalId: 'first',
      });
      await handle.signal(clientContractContinueSignal, undefined, { signalId: 'second' });

      await expect(handle.result()).resolves.toBe('signal-id:done');
    });

    it('preserves typed signal payloads that overlap delivery options', async () => {
      const client = getClient();
      const clientHandle = await client.start(workflowTypes.waitingObject, 'client', {
        id: `${idPrefix}-signal-options-payload-client`,
      });
      const handleHandle = await client.start(workflowTypes.waitingObject, 'handle', {
        id: `${idPrefix}-signal-options-payload-handle`,
      });

      await waitForRunning?.(clientHandle.id);
      await waitForRunning?.(handleHandle.id);
      await waitForQueryReadyForTesting(client, clientHandle.id);
      await waitForQueryReadyForTesting(client, handleHandle.id);

      await client.signal(clientHandle.id, clientContractObjectSignal, { signalId: 'payload' });
      await handleHandle.signal(clientContractObjectSignal, { signalId: 'payload' });

      await expect(clientHandle.result()).resolves.toBe('client:payload');
      await expect(handleHandle.result()).resolves.toBe('handle:payload');
    });

    it('startOrSignal reports outcome "started" then "signalled" across calls (#466)', async () => {
      const client = getClient();
      const id = `${idPrefix}-start-or-signal-outcome`;

      // First call creates the run.
      const first = await client.startOrSignal(
        workflowTypes.waitingTwice,
        'outcome',
        { name: 'continue', signalId: 'sos-first' },
        { id },
      );
      expect(first.outcome).toBe('started');

      await waitForRunning?.(id);
      await waitForQueryReadyForTesting(client, id);

      // Second call signals the now-existing run.
      const second = await client.startOrSignal(
        workflowTypes.waitingTwice,
        'outcome',
        { name: 'continue', signalId: 'sos-second' },
        { id },
      );
      expect(second.outcome).toBe('signalled');

      const result = (await first.result()) as string;
      expect(result).toBe('outcome:done');
    });

    it('startOrSignal gives converged concurrent callers their own per-call outcome (#466)', async () => {
      const client = getClient();
      // Concurrent same-key callers converge on ONE run, but each call returns its
      // OWN handle, so exactly one observes 'started' and the rest 'signalled' —
      // no shared-handle clobbering across the convergence.
      const handles = await Promise.all([
        client.startOrSignal(
          workflowTypes.waitingTwice,
          'converge',
          { name: 'continue' },
          { idempotencyKey: `${idPrefix}-sos-converge` },
        ),
        client.startOrSignal(
          workflowTypes.waitingTwice,
          'converge',
          { name: 'continue' },
          { idempotencyKey: `${idPrefix}-sos-converge` },
        ),
        client.startOrSignal(
          workflowTypes.waitingTwice,
          'converge',
          { name: 'continue' },
          { idempotencyKey: `${idPrefix}-sos-converge` },
        ),
      ]);

      // All converge on one workflow id.
      expect(new Set(handles.map((handle) => handle.id)).size).toBe(1);
      // Exactly one 'started', the rest 'signalled'.
      const outcomes = handles
        .map((handle) => handle.outcome ?? '')
        .toSorted((first, second) => (first < second ? -1 : first > second ? 1 : 0));
      expect(outcomes).toEqual(['signalled', 'signalled', 'started']);
    });

    it('creates, describes, updates, resumes, and cancels schedules', async () => {
      const client = getClient();
      const schedule = await client.schedule(
        workflowTypes.echo,
        { payload: 'hourly' },
        '0 * * * *',
        {
          backfill: true,
          id: `${idPrefix}-schedule`,
          overlap: 'queue',
        },
      );

      expect(schedule.id).toBe(`${idPrefix}-schedule`);
      await expect(schedule.describe()).resolves.toEqual(
        expect.objectContaining({
          backfill: true,
          cronExpression: '0 * * * *',
          id: `${idPrefix}-schedule`,
          overlap: 'queue',
          status: 'active',
          workflowType: workflowTypes.echo,
        }),
      );
      await expect(client.getSchedule(schedule.id)).resolves.toEqual(
        expect.objectContaining({ id: schedule.id }),
      );
      await expect(client.listSchedules()).resolves.toEqual(
        expect.objectContaining({
          items: expect.arrayContaining([expect.objectContaining({ id: schedule.id })]),
        }),
      );

      await schedule.pause();
      await expect(client.getSchedule(schedule.id)).resolves.toEqual(
        expect.objectContaining({ status: 'paused' }),
      );

      await schedule.update('30 * * * *');
      await expect(schedule.describe()).resolves.toEqual(
        expect.objectContaining({ cronExpression: '30 * * * *' }),
      );

      await client.resumeSchedule(schedule.id);
      await expect(client.getSchedule(schedule.id)).resolves.toEqual(
        expect.objectContaining({ status: 'active' }),
      );

      await schedule.cancel();
      await expect(client.getSchedule(schedule.id)).resolves.toEqual(
        expect.objectContaining({ nextFireAt: null, status: 'cancelled' }),
      );
    });
  });

  // The async-activity surface is the reason this contract exists for both
  // transports: `client.activity.{complete,completeExceptionally}` must behave
  // identically over the in-process engine and over HTTP.
  describe(`${label}: shared async-activity contract`, () => {
    const { asyncResultCapBytes, captureNextAsyncToken, expectTokenNotFound } = options;

    it('completes a deferred activity by token and resumes the parked workflow', async () => {
      const client = getClient();
      const tokenPromise = captureNextAsyncToken();
      const handle = await client.start(workflowTypes.asyncActivity, 'complete-case', {
        id: `${idPrefix}-async-complete`,
      });
      const token = await tokenPromise;

      // Parked, not finished: the workflow is suspended on the async activity.
      await waitForRunning?.(handle.id);
      await expect(client.get(handle.id)).resolves.toMatchObject({ status: 'running' });

      await client.activity.complete(token, { decision: 'approved' });

      await expect(handle.result()).resolves.toEqual({
        input: 'complete-case',
        resolved: { decision: 'approved' },
      });
    });

    it('completes with an omitted result, resuming the workflow with undefined', async () => {
      const client = getClient();
      const tokenPromise = captureNextAsyncToken();
      const handle = await client.start(workflowTypes.asyncActivity, 'no-result-case', {
        id: `${idPrefix}-async-no-result`,
      });
      const token = await tokenPromise;
      await waitForRunning?.(handle.id);

      // `complete(token)` with no result must behave identically across transports:
      // over HTTP `undefined` is omitted from the body and arrives as `undefined`.
      await client.activity.complete(token);
      await expect(handle.result()).resolves.toEqual({
        input: 'no-result-case',
        resolved: undefined,
      });
    });

    it('fails a deferred activity by token, throwing into the parked workflow', async () => {
      const client = getClient();
      const tokenPromise = captureNextAsyncToken();
      const handle = await client.start(workflowTypes.asyncActivity, 'fail-case', {
        id: `${idPrefix}-async-fail`,
      });
      const token = await tokenPromise;

      await waitForRunning?.(handle.id);

      await client.activity.completeExceptionally(
        token,
        new Error('callback rejected by reviewer'),
      );

      // The error is thrown into the workflow at the parked step; with no
      // try/catch it surfaces as a workflow failure. Assert on the *message*,
      // not error identity — a live Error cannot cross the HTTP boundary, so
      // both transports converge on the reduced message the engine keeps.
      const settled = await handle
        .result()
        .then(() => ({ kind: 'resolved' as const }))
        .catch((error: unknown) => ({ kind: 'rejected' as const, error }));
      expect(settled.kind).toBe('rejected');
      if (settled.kind === 'rejected') {
        const message =
          settled.error instanceof Error ? settled.error.message : String(settled.error);
        expect(message).toContain('callback rejected by reviewer');
      }
    });

    it('rejects completion of an unknown or already-consumed token', async () => {
      const client = getClient();
      const tokenPromise = captureNextAsyncToken();
      const handle = await client.start(workflowTypes.asyncActivity, 'single-use-case', {
        id: `${idPrefix}-async-single-use`,
      });
      const token = await tokenPromise;
      await waitForRunning?.(handle.id);

      // First completion consumes the single-use token.
      await client.activity.complete(token, { decision: 'first' });
      await expect(handle.result()).resolves.toEqual({
        input: 'single-use-case',
        resolved: { decision: 'first' },
      });

      // A second completion must reject with the transport's token-not-found
      // error — `expectTokenNotFound` pins NotFound (404) over HTTP and
      // AsyncActivityTokenNotFoundError in process, so a masked 500 fails here.
      const replayed = await client.activity
        .complete(token, { decision: 'second' })
        .then(() => ({ kind: 'resolved' as const }))
        .catch((error: unknown) => ({ kind: 'rejected' as const, error }));
      expect(replayed.kind).toBe('rejected');
      if (replayed.kind === 'rejected') {
        expectTokenNotFound(replayed.error);
      }
    });

    it('rejects an oversized completion result, leaving the workflow parked', async () => {
      const client = getClient();
      const tokenPromise = captureNextAsyncToken();
      const handle = await client.start(workflowTypes.asyncActivity, 'oversize-case', {
        id: `${idPrefix}-async-oversize`,
      });
      const token = await tokenPromise;
      await waitForRunning?.(handle.id);

      // A result comfortably larger than the cap must be rejected over BOTH
      // transports — the async path mirrors inline-activity and signal payload
      // enforcement. The workflow stays parked; the single-use token survives.
      const oversized = { blob: 'x'.repeat(asyncResultCapBytes * 2 + 1024) };
      const settled = await client.activity
        .complete(token, oversized)
        .then(() => ({ kind: 'resolved' as const }))
        .catch((error: unknown) => ({ kind: 'rejected' as const, error }));
      expect(settled.kind).toBe('rejected');
      await expect(client.get(handle.id)).resolves.toMatchObject({ status: 'running' });

      // The token survived: a within-limit retry still completes the workflow.
      await client.activity.complete(token, { ok: true });
      await expect(handle.result()).resolves.toEqual({
        input: 'oversize-case',
        resolved: { ok: true },
      });
    });
  });
}
