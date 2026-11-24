import { describe, expect, test } from 'bun:test';

import { Role, type Task, TaskState } from '@a2a-js/sdk';
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { workflow } from '../core/types.ts';
import { createPushFixture, onCleanup } from './push-delivery.test-support.ts';
import { securitySchemesFromAuthConfig } from './security-schemes.ts';
import { workflowAgentUnusedExecutor } from './workflow-agent-executor.ts';
import {
  AGENT_URL,
  callContext,
  createFixtureEngine,
  createWorkflowAgentFixture,
  echoWorkflow,
  failingWorkflow,
  progressWorkflow,
  serveWorkflow,
  startTask,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

function listRequest(overrides: Record<string, unknown> = {}) {
  return {
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
    ...overrides,
  };
}

describe('the workflow agent card', () => {
  test('takes its name from the card and its description, version, and skill tags from the definition', async () => {
    const { agent } = await createWorkflowAgentFixture({ inputMode: 'data' });

    expect(agent.agentCard).toMatchObject({
      name: 'Approval Agent',
      description: 'Asks for input, then answers.',
      version: '3.1.0',
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      capabilities: { streaming: true, pushNotifications: true },
      skills: [
        {
          id: 'agent-approval',
          name: 'Approval Agent',
          description: 'Asks for input, then answers.',
          tags: ['approvals', 'examples'],
        },
      ],
    });
  });

  test('accepts text/plain input as well in text mode', async () => {
    const { agent } = await createWorkflowAgentFixture({ inputMode: 'text' });

    expect(agent.agentCard.defaultInputModes).toEqual(['application/json', 'text/plain']);
  });

  test('serves its interface at the handler’s publicUrl', async () => {
    const { handler } = await createWorkflowAgentFixture();

    const response = await handler(new Request(`${AGENT_URL}/.well-known/agent-card.json`));
    const card = (await response.json()) as { supportedInterfaces: unknown[] };

    expect(card.supportedInterfaces).toEqual([
      { url: AGENT_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
  });

  test('falls back to card.description, and refuses a workflow with neither', async () => {
    const push = await createPushFixture();
    const engine = createFixtureEngine(push.storage);
    onCleanup(() => engine[Symbol.asyncDispose]());
    engine.register(
      workflow({ name: 'agent-undescribed' }).execute(async function* () {
        return null;
      }),
    );

    const described = serveWorkflow(push, engine, {
      workflowType: 'agent-undescribed',
      card: { name: 'Plain', description: 'From the card.' },
    });

    expect(described.agent.agentCard.description).toBe('From the card.');
    expect(described.agent.agentCard.skills[0]?.description).toBe('From the card.');
    expect(() =>
      serveWorkflow(push, engine, { workflowType: 'agent-undescribed', card: { name: 'Plain' } }),
    ).toThrow("Workflow 'agent-undescribed' has no description");
  });

  test('refuses a workflow type the engine has not registered', async () => {
    const push = await createPushFixture();
    const engine = createFixtureEngine(push.storage);
    onCleanup(() => engine[Symbol.asyncDispose]());

    expect(() => serveWorkflow(push, engine, { workflowType: 'agent-missing' })).toThrow(
      "Workflow type 'agent-missing' is not registered",
    );
  });

  test('advertises the security declaration it is given', async () => {
    const security = securitySchemesFromAuthConfig({ apiKeys: ['key-1'] });
    const { agent } = await createWorkflowAgentFixture({ card: { name: 'Secure', security } });

    expect(agent.agentCard.securitySchemes).toEqual(security.securitySchemes ?? {});
    expect(agent.agentCard.securityRequirements).toEqual(security.securityRequirements ?? []);
  });
});

describe('GetTask', () => {
  test('returns the task with historyLength applied and rejects an unknown or blank identifier', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());

    const full = await agent.requestHandler.getTask({ tenant: '', id: task.id }, alice());
    const last = await agent.requestHandler.getTask(
      { tenant: '', id: task.id, historyLength: 1 },
      alice(),
    );

    expect(full.history).toHaveLength(2);
    expect(last.history.map((message) => message.role)).toEqual([Role.ROLE_AGENT]);
    expect(
      await rejectionOf(agent.requestHandler.getTask({ tenant: '', id: 'missing' }, alice())),
    ).toBeInstanceOf(TaskNotFoundError);
    expect(
      await rejectionOf(agent.requestHandler.getTask({ tenant: '', id: ' ' }, alice())),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('holds only the A2A messages exchanged on the task, never the workflow’s internal events', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: progressWorkflow.name });
    const task = await startTask(
      agent,
      alice(),
      userMessage({ messageId: 'request', text: 'find it' }),
    );
    const done = await startTask(
      agent,
      alice(),
      userMessage({ messageId: 'answer', taskId: task.id, text: 'yes' }),
    );
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    const read = await agent.requestHandler.getTask({ tenant: '', id: task.id }, alice());

    expect(read.history.map((message) => [message.role, message.parts[0]?.content?.value])).toEqual(
      [
        [Role.ROLE_USER, 'find it'],
        [Role.ROLE_AGENT, "Waiting for the signal 'input'."],
        [Role.ROLE_USER, 'yes'],
      ],
    );
  });
});

describe('the artifacts option', () => {
  test('keeps a file artifact’s bytes, filename, and media type in the durable task', async () => {
    const bytes = Buffer.from('report');
    const { agent, push, engine } = await createWorkflowAgentFixture({
      workflowType: echoWorkflow.name,
      artifacts: () => [
        {
          artifactId: 'report',
          name: 'report',
          description: '',
          parts: [
            {
              content: { $case: 'raw', value: bytes },
              metadata: undefined,
              filename: 'report.txt',
              mediaType: 'text/plain',
            },
          ],
          metadata: undefined,
          extensions: [],
        },
      ],
    });
    const task = await startTask(agent, alice());
    agent[Symbol.dispose]();

    // A second agent over the same storage reads the task back from its durable record.
    const { agent: reread } = serveWorkflow(push, engine, { workflowType: echoWorkflow.name });
    const read = await reread.requestHandler.getTask({ tenant: '', id: task.id }, alice());

    expect(read.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(read.artifacts).toEqual(task.artifacts);
    expect(read.artifacts[0]?.parts[0]).toEqual({
      content: { $case: 'raw', value: bytes },
      metadata: undefined,
      filename: 'report.txt',
      mediaType: 'text/plain',
    });
  });
});

describe('CancelTask', () => {
  test('cancels a running workflow through the engine', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const cancelled: string[] = [];
    const cancel = engine.cancel.bind(engine);
    engine.cancel = async (id: string) => {
      cancelled.push(id);
      return cancel(id);
    };

    const result = await agent.requestHandler.cancelTask(
      { tenant: '', id: task.id, metadata: undefined },
      alice(),
    );

    expect(cancelled).toEqual([task.id]);
    expect(result.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const state = await engine.get(task.id);
    expect(state?.status).toBe('cancelled');
  });

  test('returns a canceled task again when asked to cancel it twice', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const first = await agent.requestHandler.cancelTask(
      { tenant: '', id: task.id, metadata: undefined },
      alice(),
    );

    const again = await agent.requestHandler.cancelTask(
      { tenant: '', id: task.id, metadata: undefined },
      alice(),
    );

    expect(again).toEqual(first);
  });

  test('refuses to cancel a completed task', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: echoWorkflow.name });
    const task = await startTask(agent, alice());
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    expect(
      await rejectionOf(
        agent.requestHandler.cancelTask({ tenant: '', id: task.id, metadata: undefined }, alice()),
      ),
    ).toBeInstanceOf(TaskNotCancelableError);
  });

  test('refuses to cancel a failed task', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: failingWorkflow.name });
    const task = await startTask(agent, alice());
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);

    expect(
      await rejectionOf(
        agent.requestHandler.cancelTask({ tenant: '', id: task.id, metadata: undefined }, alice()),
      ),
    ).toBeInstanceOf(TaskNotCancelableError);
  });

  test('refuses to cancel a rejected task', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const rejected: Task = {
      ...task,
      status: { state: TaskState.TASK_STATE_REJECTED, message: undefined, timestamp: undefined },
    };
    await agent.taskStore.save(rejected, alice());

    expect(
      await rejectionOf(
        agent.requestHandler.cancelTask({ tenant: '', id: task.id, metadata: undefined }, alice()),
      ),
    ).toBeInstanceOf(TaskNotCancelableError);
  });

  test('refuses a cancel the workflow’s completion beat, and an unknown task', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    engine.cancel = async (id: string) => {
      await engine.signal(id, 'input', 'raced');
      await waitForState(agent, id, alice(), TaskState.TASK_STATE_COMPLETED);
      return { workflowId: id, status: 'already-terminal', terminalStatus: 'completed' };
    };

    expect(
      await rejectionOf(
        agent.requestHandler.cancelTask({ tenant: '', id: task.id, metadata: undefined }, alice()),
      ),
    ).toBeInstanceOf(TaskNotCancelableError);
    expect(
      await rejectionOf(
        agent.requestHandler.cancelTask(
          { tenant: '', id: 'missing', metadata: undefined },
          alice(),
        ),
      ),
    ).toBeInstanceOf(TaskNotFoundError);
  });
});

describe('ListTasks', () => {
  async function threeTasks() {
    let clock = Date.parse('2026-10-17T00:00:00.000Z');
    const fixture = await createWorkflowAgentFixture({ now: () => (clock += 1000) });
    const tasks: Task[] = [];
    for (const contextId of ['a', 'a', 'b']) {
      tasks.push(await startTask(fixture.agent, alice(), userMessage({ contextId })));
    }
    return { ...fixture, tasks };
  }

  test('sorts by status timestamp, newest first, and counts every match in totalSize', async () => {
    const { agent, tasks } = await threeTasks();

    const listed = await agent.requestHandler.listTasks(listRequest(), alice());

    expect(listed.tasks.map((task) => task.id)).toEqual(tasks.map((task) => task.id).toReversed());
    expect(listed.totalSize).toBe(3);
  });

  test('pages with pageSize and a page token, and rejects a page size outside 1–100', async () => {
    const { agent, tasks } = await threeTasks();

    const first = await agent.requestHandler.listTasks(listRequest({ pageSize: 2 }), alice());
    const second = await agent.requestHandler.listTasks(
      listRequest({ pageSize: 2, pageToken: first.nextPageToken }),
      alice(),
    );

    expect([...first.tasks, ...second.tasks].map((task) => task.id)).toEqual(
      tasks.map((task) => task.id).toReversed(),
    );
    expect(second.nextPageToken).toBe('');
    expect(
      await rejectionOf(agent.requestHandler.listTasks(listRequest({ pageSize: 101 }), alice())),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('filters by contextId', async () => {
    const { agent, tasks } = await threeTasks();

    const listed = await agent.requestHandler.listTasks(listRequest({ contextId: 'b' }), alice());

    expect(listed.tasks.map((task) => task.id)).toEqual([tasks[2]?.id ?? 'missing']);
    expect(listed.totalSize).toBe(1);
  });

  test('applies historyLength and leaves artifacts out unless includeArtifacts is true', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: echoWorkflow.name });
    await startTask(agent, alice());

    const bare = await agent.requestHandler.listTasks(listRequest({ historyLength: 0 }), alice());
    const unset = await agent.requestHandler.listTasks(listRequest(), alice());
    const full = await agent.requestHandler.listTasks(
      listRequest({ includeArtifacts: true, historyLength: 1 }),
      alice(),
    );

    expect(bare.tasks[0]?.history).toEqual([]);
    expect(bare.tasks[0]?.artifacts).toEqual([]);
    expect(unset.tasks[0]?.artifacts).toEqual([]);
    expect(full.tasks[0]?.artifacts).toHaveLength(1);
    expect(full.tasks[0]?.history).toHaveLength(1);
  });

  test('reconciles every task from its workflow before filtering by status', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    // Complete the workflow with no handler following the engine, as if it were down.
    agent[Symbol.dispose]();
    await engine.signal(task.id, 'input', 'while away');
    await engine.getHandle(task.id).result();

    const completed = await agent.requestHandler.listTasks(
      listRequest({ status: TaskState.TASK_STATE_COMPLETED }),
      alice(),
    );

    expect(completed.tasks.map((listed) => [listed.id, listed.status?.state])).toEqual([
      [task.id, TaskState.TASK_STATE_COMPLETED],
    ]);
    expect(completed.totalSize).toBe(1);
  });
});

describe('the unused agent executor', () => {
  test('refuses to execute or cancel, because the handler serves both itself', async () => {
    expect(
      await rejectionOf(workflowAgentUnusedExecutor.execute({} as never, {} as never)),
    ).toBeInstanceOf(UnsupportedOperationError);
    expect(
      await rejectionOf(workflowAgentUnusedExecutor.cancelTask('task', {} as never)),
    ).toBeInstanceOf(UnsupportedOperationError);
  });
});
