import { describe, expect, it } from 'bun:test';
import type { WorkflowContext } from '../core/types.ts';
import { signal } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import type { WeftClient } from './interface.ts';

type ClientContractWorkflowTypes = {
  echo: string;
  waiting: string;
  waitingObject: string;
  waitingTwice: string;
};

type ClientContractTestOptions = {
  label: string;
  getClient: () => WeftClient;
  idPrefix: string;
  workflowTypes: ClientContractWorkflowTypes;
  waitForRunning?: (workflowId: string) => Promise<void>;
};

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
function waitForHandleEvent(
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
      const completed = waitForHandleEvent(handle, 'workflow:completed', 1000);
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
}
