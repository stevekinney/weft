/**
 * Characterization tests for `validateCreateScheduleInput` (extracted from
 * `createScheduleOperation.invoke`).
 *
 * Field-validation order in source (lines 62–93):
 *   1. type          — must be a non-empty string
 *   2. cronExpression — must be a non-empty string
 *   3. id            — must be a non-empty string when provided
 *   4. overlap       — must be one of the valid overlap policies
 *   5. backfill      — must be a boolean when provided
 *   6. jitter        — must be a duration string or number when provided
 *
 * Adjacent-pair tests assert that when two consecutive fields are invalid the
 * error for the earlier-listed field surfaces first.  The all-bad test passes
 * every field with an invalid value and asserts the first error wins.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { createScheduleOperation, createScheduleRestBinding } from './create-schedule.ts';
import { jsonRequest } from './operation-test-helpers.test-support.ts';

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

const registry = createOperationRegistry([createScheduleOperation]);
const bindings = [createScheduleRestBinding];

describe('create-schedule — validation precedence', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  // --- adjacent pair: type before cronExpression ---
  it('reports type error before cronExpression error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', { type: '', cronExpression: '' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });

  // --- adjacent pair: cronExpression before id ---
  it('reports cronExpression error before id error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', { type: 'echo', cronExpression: '', id: '' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required field: cronExpression or every',
    });
  });

  // --- adjacent pair: id before overlap ---
  it('reports id error before overlap error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        id: '',
        overlap: 'bad-policy',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Field "id" must be a non-empty string' });
  });

  // --- adjacent pair: overlap before backfill ---
  it('reports overlap error before backfill error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        overlap: 'bad-policy',
        backfill: 'yes',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "overlap" must be one of skip, queue, cancel-running, allow',
    });
  });

  // --- adjacent pair: backfill before jitter ---
  it('reports backfill error before jitter error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        backfill: 'yes',
        jitter: false,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Field "backfill" must be a boolean' });
  });

  // --- engine-level interval validation reaches the REST boundary as 400 ---
  it('returns 400 when the interval expression is syntactically invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        every: 'not-a-duration',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('interval'),
    });
  });

  // --- all-bad: first field (type) wins ---
  it('reports type error when all fields are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: '',
        cronExpression: '',
        id: '',
        overlap: 'bad-policy',
        backfill: 'yes',
        jitter: false,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });
});
