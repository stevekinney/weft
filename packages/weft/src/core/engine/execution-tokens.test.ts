import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('workflow and activity execution tokens', () => {
  it('exposes workflow and activity attempt tokens to inline activities', async () => {
    await using engine = new Engine();
    const observedContexts: ActivityContext[] = [];

    const captureTokens = activity({
      name: 'capture-tokens',
      execute: async (_input: unknown, context?: ActivityContext) => {
        if (context === undefined) throw new Error('missing activity context');
        observedContexts.push(context);
        return {
          workflowExecutionToken: context.workflowExecutionToken,
          activityAttemptToken: context.activityAttemptToken,
        };
      },
    });

    engine.register(
      workflow({ name: 'token-workflow' })
        .activities({ 'capture-tokens': captureTokens })
        .execute(async function* (context: WorkflowContext) {
          const result = yield* context.run('capture-tokens');
          return {
            workflowExecutionToken: context.workflowExecutionToken,
            activityWorkflowExecutionToken: (result as { workflowExecutionToken?: string })
              .workflowExecutionToken,
            activityAttemptToken: (result as { activityAttemptToken?: string })
              .activityAttemptToken,
          };
        }),
    );

    const handle = await engine.start('token-workflow', null, { id: 'token-workflow-1' });
    const result = (await handle.result()) as {
      workflowExecutionToken: string;
      activityWorkflowExecutionToken: string;
      activityAttemptToken: string;
    };

    expect(result.workflowExecutionToken).toBeString();
    expect(result.activityWorkflowExecutionToken).toBe(result.workflowExecutionToken);
    expect(result.activityAttemptToken).toContain(result.workflowExecutionToken);
    expect(observedContexts[0]?.activityAttemptToken).toBe(result.activityAttemptToken);
  });

  it('rotates the workflow execution token when start-new reuses a terminal id', async () => {
    await using engine = new Engine();

    engine.register(
      workflow({ name: 'restart-token-workflow' }).execute(async function* (
        context: WorkflowContext,
      ) {
        return context.workflowExecutionToken;
      }),
    );

    const firstHandle = await engine.start('restart-token-workflow', null, {
      id: 'stable-token-id',
    });
    const firstToken = await firstHandle.result();
    await engine.storage.put(
      KEYS.teardownSucceeded('stable-token-id'),
      encode({ workflowExecutionToken: firstToken, attempts: 1, completedAt: 1 }),
    );

    const secondHandle = await engine.start('restart-token-workflow', null, {
      id: 'stable-token-id',
      onTerminalConflict: 'start-new',
    });
    const secondToken = await secondHandle.result();

    expect(firstToken).toBeString();
    expect(secondToken).toBeString();
    expect(secondToken).not.toBe(firstToken);
    expect(await engine.storage.get(KEYS.teardownSucceeded('stable-token-id'))).toBeNull();
    await expect(engine.getFinalizerStatus('stable-token-id')).resolves.toBeNull();
  });

  it('exposes workflow and finalizer attempt tokens to finalizers', async () => {
    await using engine = new Engine();
    const finalizerContexts: ActivityContext[] = [];
    let runToken: string | undefined;

    const cleanup = activity({
      name: 'cleanup-token-workflow',
      execute: async (_input: unknown, context?: ActivityContext) => {
        if (context === undefined) throw new Error('missing finalizer context');
        finalizerContexts.push(context);
      },
    });

    engine.register(
      workflow({ name: 'finalizer-token-workflow', finalizer: cleanup }).execute(async function* (
        context: WorkflowContext,
      ) {
        runToken = context.workflowExecutionToken;
        context.setFinalizerState({ runToken });
        yield* context.waitForSignal('release');
      }),
    );

    const handle = await engine.start('finalizer-token-workflow', null, {
      id: 'finalizer-token-workflow-1',
    });
    await waitForCondition(() => runToken !== undefined, {
      timeoutMs: 2_000,
      label: 'workflow recorded run token',
    });

    await handle.cancel();
    await engine.scheduler.tick(Date.now());

    expect(finalizerContexts[0]?.workflowExecutionToken).toBe(runToken);
    expect(finalizerContexts[0]?.activityAttemptToken).toBe(`${runToken}:finalizer:1`);
  });

  it('lets stale race-loser activities fence external writes by activity attempt token', async () => {
    await using engine = new Engine();
    const slowActivityStarted = Promise.withResolvers<void>();
    const releaseSlowActivity = Promise.withResolvers<void>();
    const slowActivitySettled = Promise.withResolvers<void>();
    const externalStore: {
      ownerToken: string | undefined;
      value: string;
      rejectedToken: string | undefined;
    } = {
      ownerToken: undefined,
      value: 'initial',
      rejectedToken: undefined,
    };

    const slowWrite = activity({
      name: 'slow-race-write',
      execute: async (_input: unknown, context?: ActivityContext) => {
        if (context?.activityAttemptToken === undefined) {
          throw new Error('missing activity attempt token');
        }
        const activityAttemptToken = context.activityAttemptToken;
        externalStore.ownerToken = activityAttemptToken;
        slowActivityStarted.resolve();
        await releaseSlowActivity.promise;

        if (externalStore.ownerToken === activityAttemptToken) {
          externalStore.value = 'late-write';
        } else {
          externalStore.rejectedToken = activityAttemptToken;
        }
        slowActivitySettled.resolve();
      },
    });

    engine.register(
      workflow({ name: 'race-loser-token-workflow' })
        .activities({ 'slow-race-write': slowWrite })
        .execute(async function* (context: WorkflowContext) {
          yield* context.race([
            context.run('slow-race-write'),
            context.waitForSignal('release-race'),
          ]);
        }),
    );

    const handle = await engine.start('race-loser-token-workflow', null, {
      id: 'race-loser-token-workflow-1',
    });
    await slowActivityStarted.promise;
    const staleToken = externalStore.ownerToken;

    externalStore.ownerToken = 'replacement-attempt-token';
    await handle.signal('release-race');
    await handle.result();
    releaseSlowActivity.resolve();
    await slowActivitySettled.promise;

    expect(staleToken).toBeString();
    expect(externalStore.value).toBe('initial');
    expect(externalStore.rejectedToken).toBe(staleToken);
  });

  it('lets finalizers and late activity successes fence external writes by workflow token', async () => {
    await using engine = new Engine();
    const lateActivityStarted = Promise.withResolvers<void>();
    const releaseLateActivity = Promise.withResolvers<void>();
    const lateActivitySettled = Promise.withResolvers<void>();
    const externalStore: {
      ownerToken: string | undefined;
      value: string;
      rejectedWrites: string[];
    } = {
      ownerToken: undefined,
      value: 'initial',
      rejectedWrites: [],
    };
    let runToken: string | undefined;

    const lateSuccess = activity({
      name: 'late-token-success',
      execute: async (_input: unknown, context?: ActivityContext) => {
        if (context?.workflowExecutionToken === undefined) {
          throw new Error('missing workflow execution token');
        }
        const workflowExecutionToken = context.workflowExecutionToken;
        lateActivityStarted.resolve();
        await releaseLateActivity.promise;
        if (externalStore.ownerToken === workflowExecutionToken) {
          externalStore.value = 'late-success';
        } else {
          externalStore.rejectedWrites.push('late-success');
        }
        lateActivitySettled.resolve();
      },
    });

    const cleanup = activity({
      name: 'token-finalizer-cleanup',
      execute: async (_input: unknown, context?: ActivityContext) => {
        if (context?.workflowExecutionToken === undefined) {
          throw new Error('missing finalizer workflow token');
        }
        if (externalStore.ownerToken === context.workflowExecutionToken) {
          externalStore.value = 'cleanup';
        } else {
          externalStore.rejectedWrites.push('cleanup');
        }
      },
    });

    engine.register(
      workflow({ name: 'external-fence-token-workflow', finalizer: cleanup })
        .activities({ 'late-token-success': lateSuccess })
        .execute(async function* (context: WorkflowContext) {
          runToken = context.workflowExecutionToken;
          externalStore.ownerToken = context.workflowExecutionToken;
          context.setFinalizerState({ ownerToken: context.workflowExecutionToken });
          yield* context.run('late-token-success');
        }),
    );

    const handle = await engine.start('external-fence-token-workflow', null, {
      id: 'external-fence-token-workflow-1',
    });
    await lateActivityStarted.promise;
    await waitForCondition(() => runToken !== undefined, {
      timeoutMs: 2_000,
      label: 'workflow recorded external owner token',
    });

    await handle.cancel();
    externalStore.ownerToken = 'successor-workflow-token';
    releaseLateActivity.resolve();
    await lateActivitySettled.promise;
    await engine.scheduler.tick(Date.now());

    expect(runToken).toBeString();
    expect(externalStore.value).toBe('initial');
    expect(externalStore.rejectedWrites).toEqual(['late-success', 'cleanup']);
  });
});
