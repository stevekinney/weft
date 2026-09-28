/**
 * COR-152 criterion 12: finalizers and `durableActivity()` helpers remain
 * outside remote dispatch, even under `activityExecution: { mode: 'remote' }`.
 *
 * Both mechanisms are structurally excluded from remote dispatch in
 * production code already:
 *
 * - A workflow's definition-level `finalizer` runs through
 *   `runFinalizerActivity` (`core/engine/termination/finalizer-activity.ts`),
 *   which calls the registered activity's `execute` directly — it never goes
 *   through `operations-activity.ts`'s leaf executor (`invokeRemoteActivity`
 *   / `invokeWorkerActivity` / inline) at all. The finalizer runs
 *   post-terminal, after the workflow's generator and abort controller are
 *   already evicted, so there is no "activity operation" for a broker to
 *   intercept.
 * - `durableActivity()`'s internal helper activities set
 *   `allowRemoteDispatch: false` on their `ActivityOperationExecutionOptions`
 *   (`core/engine/memo-durable-activity.ts`), which
 *   `operations-activity.ts`'s `isRemoteMode` check ANDs against
 *   `internals.remoteActivityBroker` — so even a remote-mode engine executes
 *   them inline.
 *
 * Prior test coverage proved each mechanism exists and behaves correctly in
 * an ordinary (non-remote) engine, and separately that remote dispatch
 * itself works. Neither drove a finalizer or a `durableActivity()` call
 * under a REMOTE-MODE engine and asserted the broker was never reached —
 * this file closes that gap with a recording broker double (legitimate here:
 * the assertion is "enqueue was never called", not "the durable envelope has
 * field X", which is what the production-broker tests in
 * `remote-activity-execution.test.ts` and
 * `server/remote-activity-integration.test.ts` already prove for the
 * opposite case).
 */
import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { durableActivity } from '../context/durable-activity.ts';
import type { RemoteActivityBroker, RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

function createRecordingBroker(): {
  broker: RemoteActivityBroker;
  requests: RemoteActivityTaskRequest[];
} {
  const requests: RemoteActivityTaskRequest[] = [];
  return {
    requests,
    broker: {
      async enqueue(request) {
        requests.push(request);
      },
    },
  };
}

describe('remote dispatch exclusions (COR-152 criterion 12)', () => {
  it('runs a workflow finalizer locally under activityExecution: { mode: "remote" }, never reaching the broker', async () => {
    const { broker, requests } = createRecordingBroker();
    const now = 1_000_000;

    const localDestroySandbox = mock(async (input: unknown) => {
      return { destroyed: input };
    });
    const destroySandbox = activity({
      name: 'destroySandbox',
      execute: localDestroySandbox,
    });

    const provisionWorkflow = workflow({
      name: 'remote-mode-finalizer-workflow',
      finalizer: destroySandbox,
    }).execute(async function* (ctx: WorkflowContext) {
      ctx.setFinalizerState({ sandboxId: 'sbx-remote-mode-1' });
      yield* ctx.waitForSignal('never');
    });

    const engine = new Engine({
      activityExecution: { mode: 'remote', broker },
      getNow: () => now,
    });
    engine.register(provisionWorkflow);

    const handle = await engine.start('remote-mode-finalizer-workflow', null, {
      id: 'remote-mode-finalizer-1',
    });

    await waitForCondition(
      async () => (await engine.storage.get(KEYS.finalizerState(handle.id))) !== null,
      {
        label: 'workflow recorded finalizer state and parked',
        timeoutMs: 2_000,
        intervalMs: 5,
      },
    );

    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow();

    // The teardown timer fires at terminalization time.
    await engine.scheduler.tick(now);

    await waitForCondition(() => localDestroySandbox.mock.calls.length > 0, {
      label: 'finalizer to run',
      timeoutMs: 2_000,
      intervalMs: 5,
    });

    expect(localDestroySandbox).toHaveBeenCalledTimes(1);
    expect(localDestroySandbox.mock.calls[0]?.[0]).toEqual({ sandboxId: 'sbx-remote-mode-1' });
    // The whole point of this test: the finalizer never reached the remote
    // broker, even though the engine is configured for remote mode.
    expect(requests).toHaveLength(0);

    engine[Symbol.dispose]();
  });

  it('runs a durableActivity() helper call locally under activityExecution: { mode: "remote" }, never reaching the broker', async () => {
    const { broker, requests } = createRecordingBroker();

    const localExecuteTool = mock(async (tool: string) => ({ ranTool: tool }));
    const executeTool = activity({
      name: 'executeTool',
      execute: localExecuteTool,
    });

    const definition = workflow({ name: 'remote-mode-durable-activity-workflow' })
      .activities({ executeTool })
      .execute(async function* (ctx: WorkflowContext, input: { tool: string }) {
        return yield* ctx.memo('step-0', async () =>
          durableActivity('executeTool', input.tool, { idempotencyKey: 'remote-mode:durable' }),
        );
      });

    const engine = new Engine({ activityExecution: { mode: 'remote', broker } });
    engine.register(definition);

    const handle = await engine.start(
      'remote-mode-durable-activity-workflow',
      { tool: 'lookup' },
      { id: 'remote-mode-durable-activity-1' },
    );

    expect(await handle.result()).toEqual({ ranTool: 'lookup' });
    expect(localExecuteTool).toHaveBeenCalledTimes(1);
    // The whole point of this test: the helper activity never reached the
    // remote broker, even though the engine is configured for remote mode.
    expect(requests).toHaveLength(0);

    engine[Symbol.dispose]();
  });
});
