/**
 * `weft.workflows.events.list` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { EventLog } from '../../core/event-log.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getWorkflowEventsOperation, getWorkflowEventsRestBinding } from './get-workflow-events.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return { engine, storage };
}

const registry = createOperationRegistry([getWorkflowEventsOperation]);
const bindings = [getWorkflowEventsRestBinding];

describe('weft.workflows.events.list', () => {
  it('returns the workflow events on the happy path', async () => {
    const { engine, storage } = createEngineWithStorage();
    const handle = await engine.start('echo', 'hello', { id: 'workflow-events-success' });
    await waitForWorkflowStatus(engine, handle.id, 'completed');

    const eventLog = new EventLog(storage, handle.id);
    await eventLog.append({ type: 'workflow:started', payload: { workflowId: handle.id } });
    await eventLog.append({ type: 'workflow:completed', payload: { workflowId: handle.id } });

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/events`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ events: await engine.getEvents(handle.id) });
  });

  it('returns 404 with the canonical error body when the workflow does not exist', async () => {
    const { engine } = createEngineWithStorage();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/does-not-exist/events', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Workflow "does-not-exist" not found' });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const { engine } = createEngineWithStorage();
    const failingOperation = {
      ...getWorkflowEventsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/whatever/events', { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
