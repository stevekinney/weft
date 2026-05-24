import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { pauseScheduleOperation, pauseScheduleRestBinding } from './pause-schedule.ts';

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

const registry = createOperationRegistry([pauseScheduleOperation]);
const bindings = [pauseScheduleRestBinding];

describe('weft.schedules.pause', () => {
  it('pauses a schedule and returns 204', async () => {
    const engine = createEngine();
    await engine.schedule('echo', 'payload', '0 * * * *', { id: 'schedule-pause-success' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-pause-success/pause', {
        method: 'POST',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    expect(await engine.getSchedule('schedule-pause-success')).toEqual(
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('returns 404 when the schedule does not exist', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist/pause', { method: 'POST' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "does-not-exist" not found' });
  });

  it('maps schedule validation messages to 400', async () => {
    const engine = createEngine();
    const originalPauseSchedule = engine.pauseSchedule.bind(engine);
    engine.pauseSchedule = async () => {
      throw new Error('No workflow registered for schedule');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1/pause', { method: 'POST' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'No workflow registered for schedule' });
    } finally {
      engine.pauseSchedule = originalPauseSchedule;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalPauseSchedule = engine.pauseSchedule.bind(engine);
    engine.pauseSchedule = async () => {
      throw new Error('exploded');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1/pause', { method: 'POST' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.pauseSchedule = originalPauseSchedule;
    }
  });
});
