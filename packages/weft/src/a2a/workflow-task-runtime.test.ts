import { describe, expect, test } from 'bun:test';

import { type Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { SignalWaitingEvent } from '../core/events/signal-events.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { createPushFixture, onCleanup } from './push-delivery.test-support.ts';
import {
  callContext,
  createFixtureEngine,
  sendRequest,
  serveWorkflow,
  startTask,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';
import { SIGNAL_NAMES_METADATA_KEY } from './workflow-task-projection.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

/** Waits for `a` and `b` at once, then completes with both. */
const bothWorkflow = workflow({
  name: 'agent-both',
  description: 'Waits for two signals at once.',
}).execute(async function* (ctx: WorkflowContext, _request: unknown) {
  const [a, b] = yield* ctx.all([ctx.waitForSignal('a'), ctx.waitForSignal('b')]);
  return { a, b };
});

async function serveBothWorkflow() {
  const push = await createPushFixture();
  const engine = createFixtureEngine(push.storage);
  engine.register(bothWorkflow);
  onCleanup(() => engine[Symbol.asyncDispose]());
  const { agent } = serveWorkflow(push, engine, { workflowType: bothWorkflow.name });
  return { engine, agent };
}

describe('signals delivered within one generation', () => {
  test('keeps every wait a continuation answered hidden until the engine drops it', async () => {
    const { engine, agent } = await serveBothWorkflow();
    const task = await startTask(agent, alice());
    expect(task.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY]).toEqual(['a', 'b']);

    // Hold each delivery back from the engine, so its persisted `waitingForSignals`
    // still names both waits after both continuations are accepted.
    const signal = engine.signal.bind(engine);
    const held: Parameters<typeof signal>[] = [];
    engine.signal = (async (...args: Parameters<typeof signal>) => {
      held.push(args);
    }) as typeof engine.signal;
    const answer = (signalName: string | undefined, text: string) =>
      agent.requestHandler.sendMessage(
        sendRequest(
          userMessage({
            taskId: task.id,
            text,
            ...(signalName === undefined ? {} : { metadata: { signalName } }),
          }),
          { returnImmediately: true },
        ),
        alice(),
      ) as Promise<Task>;

    await answer('a', 'first');
    await answer('b', 'second');
    await agent.idle();
    const latest = await agent.requestHandler.getTask({ tenant: '', id: task.id }, alice());

    expect(held.map(([, name]) => name)).toEqual(['a', 'b']);
    expect(latest.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    // The only waits announced are the two open at the start, then `b` once `a` was answered.
    const announced = latest.history
      .map((message) => message.metadata?.[SIGNAL_NAMES_METADATA_KEY])
      .filter((names) => names !== undefined);
    expect(announced).toEqual([['a', 'b'], ['b']]);
    expect(await rejectionOf(answer(undefined, 'third'))).toBeInstanceOf(RequestMalformedError);
    expect(await rejectionOf(answer('a', 'third'))).toBeInstanceOf(RequestMalformedError);
    expect(held).toHaveLength(2);

    engine.signal = signal;
    for (const args of held) await signal(...args);
    const completed = await waitForState(agent, task.id, alice(), TaskState.TASK_STATE_COMPLETED);
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const state = await engine.get(task.id);
    expect(state?.result).toEqual({ a: 'first', b: 'second' });
  });

  for (const { announcedDuring, open } of [
    { announcedDuring: 'b', open: ['b'] },
    { announcedDuring: 'a', open: ['a', 'b'] },
  ]) {
    test(`a wait for '${announcedDuring}' announced while 'a' is delivered leaves ${open.join(' and ')} open`, async () => {
      const { engine, agent } = await serveBothWorkflow();
      const task = await startTask(agent, alice());
      // The delivery is held from the engine, so the persisted list keeps naming both
      // waits; the announcement stands in for the engine re-reading a wait mid-delivery.
      const signal = engine.signal.bind(engine);
      engine.signal = async (id: string) => {
        engine.dispatchEvent(new SignalWaitingEvent(id, announcedDuring));
      };

      const continued = await startTask(
        agent,
        alice(),
        userMessage({ taskId: task.id, text: 'first', metadata: { signalName: 'a' } }),
      );
      engine.signal = signal;

      expect(continued.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      expect(continued.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY]).toEqual(open);
    });
  }
});
