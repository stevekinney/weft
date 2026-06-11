/**
 * Characterization tests for `validateListSchedulesQuery` (extracted from
 * `listSchedulesOperation.invoke`).
 *
 * Field-validation order in source (lines 74–149):
 *   1. status         — must be one of active|paused|cancelled per entry
 *   2. workflowType   — must be a string when provided
 *   3. limit          — must be a positive integer when provided
 *   4. offset         — must be a non-negative integer when provided
 *
 * Adjacent-pair tests assert that when two consecutive fields are invalid the
 * error for the earlier-listed field surfaces first. The all-bad test passes
 * every validatable field with an invalid value and asserts the first error wins.
 *
 * The operation has `access: { kind: 'authenticated' }`, so all requests are
 * issued with an api-key principal to pass the authentication gate.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import {
  createListSchedulesApiKeyAuthContext,
  createListSchedulesTestEngine,
  listSchedulesTestRegistry,
  listSchedulesTestRestBindings,
} from './list-schedules.test-support.ts';

function getRequest(query: string): Request {
  return new Request(`http://localhost/v1/schedules?${query}`, { method: 'GET' });
}

describe('list-schedules — validation precedence', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  // --- adjacent pair: status before limit ---
  // workflowType always arrives as a string from the query string, so pairing
  // status with limit is the next meaningful multi-field invalid scenario.
  it('reports status error before limit error when both are invalid', async () => {
    engine = createListSchedulesTestEngine();
    const response = await handleRequest(getRequest('status=bad-status&limit=-1'), engine, {
      operationRegistry: listSchedulesTestRegistry,
      restBindings: listSchedulesTestRestBindings,
      ...createListSchedulesApiKeyAuthContext(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "status" must be one of active, paused, cancelled',
    });
  });

  // --- adjacent pair: limit before offset ---
  it('reports limit error before offset error when both are invalid', async () => {
    engine = createListSchedulesTestEngine();
    const response = await handleRequest(getRequest('limit=0&offset=-1'), engine, {
      operationRegistry: listSchedulesTestRegistry,
      restBindings: listSchedulesTestRestBindings,
      ...createListSchedulesApiKeyAuthContext(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "limit" must be a positive integer',
    });
  });

  // --- offset validated alone ---
  it('reports offset error for a negative offset', async () => {
    engine = createListSchedulesTestEngine();
    const response = await handleRequest(getRequest('offset=-1'), engine, {
      operationRegistry: listSchedulesTestRegistry,
      restBindings: listSchedulesTestRestBindings,
      ...createListSchedulesApiKeyAuthContext(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "offset" must be a non-negative integer',
    });
  });

  // --- all-bad: status (first validatable field) wins ---
  it('reports status error when status and limit and offset are all invalid', async () => {
    engine = createListSchedulesTestEngine();
    const response = await handleRequest(getRequest('status=invalid&limit=0&offset=-1'), engine, {
      operationRegistry: listSchedulesTestRegistry,
      restBindings: listSchedulesTestRestBindings,
      ...createListSchedulesApiKeyAuthContext(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "status" must be one of active, paused, cancelled',
    });
  });
});
