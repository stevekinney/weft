import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { cancelScheduleOperation, cancelScheduleRestBinding } from './cancel-schedule.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([cancelScheduleOperation]);
const bindings = [cancelScheduleRestBinding];

describe('weft.schedules.cancel', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('cancels a schedule and returns 204', async () => {
    engine = createEngine();
    await engine.schedule('echo', 'payload', '0 * * * *', { id: 'schedule-cancel-success' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-cancel-success', {
        method: 'DELETE',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    expect(await engine.getSchedule('schedule-cancel-success')).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('returns 404 when the schedule does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist', { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Schedule "does-not-exist" not found',
      data: { resource: 'schedule', identifier: 'does-not-exist' },
    });
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    engine = createEngine();
    const originalCancelSchedule = engine.cancelSchedule.bind(engine);
    engine.cancelSchedule = async () => {
      throw new Error('exploded');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.cancelSchedule = originalCancelSchedule;
    }
  });
});
