/**
 * Cross-transport coverage for schedule mutations over JSON-RPC.
 *
 * The REST path is exercised in `handler.test.ts` and the colocated
 * operation tests. The three mutation operations also declare JSON-RPC
 * transports, so this suite dispatches pause/resume/cancel through
 * `dispatchJsonRpc` to pin that they succeed on the happy path and surface a
 * NotFound error for a missing schedule.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { cancelScheduleOperation } from './operations/cancel-schedule.ts';
import { pauseScheduleOperation } from './operations/pause-schedule.ts';
import { resumeScheduleOperation } from './operations/resume-schedule.ts';
import { principalFromApiKey } from './principal.ts';

// JSON-RPC error codes (src/server/operation-fault.ts).
const NOT_FOUND_CODE = -32020;

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([
  pauseScheduleOperation,
  resumeScheduleOperation,
  cancelScheduleOperation,
]);

function call(engine: Engine, method: string, scheduleId: string) {
  const principal = principalFromApiKey({ subject: 'svc', scopes: [] });
  return dispatchJsonRpc(
    JSON.stringify({ jsonrpc: '2.0', method, params: { scheduleId }, id: 1 }),
    { principal, engine, transport: 'jsonRpcHttp', registry },
  );
}

describe('schedule mutations over JSON-RPC', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('pauses/resumes/cancels schedules on the happy path', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'schedule-1' });
    await engine.schedule('echo', {}, '0 * * * *', { id: 'schedule-cancel' });

    const paused = await call(engine, 'weft.schedules.pause', 'schedule-1');
    if (paused.kind !== 'single' || 'error' in paused.response) {
      throw new Error('expected pause success');
    }
    expect(await engine.getSchedule('schedule-1')).toEqual(
      expect.objectContaining({ status: 'paused' }),
    );

    const resumed = await call(engine, 'weft.schedules.resume', 'schedule-1');
    if (resumed.kind !== 'single' || 'error' in resumed.response) {
      throw new Error('expected resume success');
    }
    expect(await engine.getSchedule('schedule-1')).toEqual(
      expect.objectContaining({ status: 'active' }),
    );

    const cancelled = await call(engine, 'weft.schedules.cancel', 'schedule-cancel');
    if (cancelled.kind !== 'single' || 'error' in cancelled.response) {
      throw new Error('expected cancel success');
    }
    expect(await engine.getSchedule('schedule-cancel')).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('returns NotFound for a missing schedule', async () => {
    engine = createEngine();

    for (const method of [
      'weft.schedules.pause',
      'weft.schedules.resume',
      'weft.schedules.cancel',
    ]) {
      const result = await call(engine, method, 'does-not-exist');
      if (result.kind !== 'single' || !('error' in result.response)) {
        throw new Error(`expected error response for ${method}`);
      }
      expect(result.response.error.code).toBe(NOT_FOUND_CODE);
      expect(result.response.error.message).toBe('Schedule "does-not-exist" not found');
    }
  });
});
