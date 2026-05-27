import { describe, expect, it } from 'bun:test';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import type { WeftClient } from './interface.ts';

type ClientContractWorkflowTypes = {
  echo: string;
  waiting: string;
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

  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
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

export function runWeftClientContractTests(options: ClientContractTestOptions): void {
  const { getClient, idPrefix, label, waitForRunning, workflowTypes } = options;

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
