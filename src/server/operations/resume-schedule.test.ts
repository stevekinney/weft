import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { resumeScheduleOperation, resumeScheduleRestBinding } from './resume-schedule.ts';

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

const registry = createOperationRegistry([resumeScheduleOperation]);
const bindings = [resumeScheduleRestBinding];

describe('weft.schedules.resume', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('resumes a paused schedule and returns 204', async () => {
    engine = createEngine();
    await engine.schedule('echo', 'payload', '0 * * * *', { id: 'schedule-resume-success' });
    await engine.pauseSchedule('schedule-resume-success');

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-resume-success/resume', {
        method: 'POST',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    expect(await engine.getSchedule('schedule-resume-success')).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('returns 404 when the schedule does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist/resume', { method: 'POST' }),
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

  it('maps resumability conflicts to 409', async () => {
    engine = createEngine();
    const originalResumeSchedule = engine.resumeSchedule.bind(engine);
    engine.resumeSchedule = async () => {
      throw new Error('Schedule cannot be resumed after cancellation');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1/resume', { method: 'POST' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Schedule cannot be resumed after cancellation',
      });
    } finally {
      engine.resumeSchedule = originalResumeSchedule;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    engine = createEngine();
    const originalResumeSchedule = engine.resumeSchedule.bind(engine);
    engine.resumeSchedule = async () => {
      throw new Error('exploded');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1/resume', { method: 'POST' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.resumeSchedule = originalResumeSchedule;
    }
  });
});
