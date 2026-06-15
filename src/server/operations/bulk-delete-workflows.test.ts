/**
 * `weft.workflows.bulk.delete` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { handleRequest } from '../handler.ts';
import { createJsonRequest } from '../http-request.test-support.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { waitForStatus } from '../workflow-status.test-support.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './bulk-delete-workflows.ts';
import {
  createBulkTestEngine,
  bulkAdminHandlerOptions as makeBulkAdminHandlerOptions,
} from './bulk-operation.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});
const waitingWorkflow = workflow({ name: 'waiting' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal('release');
});

function createEngine(): Engine {
  return createBulkTestEngine(echoWorkflow, waitingWorkflow);
}

function request(body?: unknown): Request {
  return createJsonRequest({ method: 'DELETE', path: '/v1/workflows/bulk', body });
}

const registry = createOperationRegistry([bulkDeleteWorkflowsOperation]);
const bindings = [bulkDeleteWorkflowsRestBinding];

function bulkAdminHandlerOptions(customRegistry = registry) {
  return makeBulkAdminHandlerOptions({ registry: customRegistry, bindings });
}

describe('weft.workflows.bulk.delete', () => {
  it('deletes matching terminal workflows', async () => {
    using engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', {
      id: 'bulk-delete-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('echo', 'second', {
      id: 'bulk-delete-selected-b',
      tags: ['selected'],
    });
    await firstHandle.result();
    await secondHandle.result();

    const previewResponse = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        dryRun: true,
        requestId: 'bulk-delete-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'delete',
        matched: 2,
        requestId: 'bulk-delete-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );
    expect(await engine.get('bulk-delete-selected-a')).not.toBeNull();
    expect(await engine.get('bulk-delete-selected-b')).not.toBeNull();

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        confirmationToken: preview.confirmationToken,
        requestId: 'bulk-delete-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      deleted: 2,
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'delete',
        affectedCount: 2,
        requestId: 'bulk-delete-request',
      }),
    });
    expect(await engine.get('bulk-delete-selected-a')).toBeNull();
    expect(await engine.get('bulk-delete-selected-b')).toBeNull();
  });

  it('surfaces skippedTeardownPending in the transport response (#446 cross-transport parity)', async () => {
    // A workflow that owes a finalizer teardown must be SKIPPED by bulk delete, and the
    // skip must be VISIBLE on the wire (not silent) so an operator does not assume the
    // run was deleted. `weft.workflows.bulk.delete` shapes the engine result through
    // `shapeBulkJsonSuccess` (a transparent JSON.stringify over `z.unknown()`), so the
    // engine's `skippedTeardownPending` field reaches REST and JSON-RPC identically.
    // (junior MF4.) We seed the durable `owed` marker directly — the finalizer mechanics
    // themselves are covered in finalizer-teardown.test.ts.
    using engine = createEngine();

    const handle = await engine.start('echo', 'owes-teardown', {
      id: 'bulk-delete-teardown-owed',
      tags: ['selected'],
    });
    await handle.result();
    // Mark the (terminal) workflow as owing a finalizer teardown.
    await engine.storage.put(
      KEYS.teardownOwed('bulk-delete-teardown-owed'),
      encode({ status: 'owed', attempts: 0, token: 'tok-parity' }),
    );

    const previewResponse = await handleRequest(
      request({ filter: { tags: ['selected'] }, dryRun: true }),
      engine,
      bulkAdminHandlerOptions(),
    );
    const preview = await previewResponse.json();

    const response = await handleRequest(
      request({ filter: { tags: ['selected'] }, confirmationToken: preview.confirmationToken }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // The teardown-owing workflow was skipped and reported on the wire; nothing deleted.
    expect(body.deleted).toBe(0);
    expect(body.skippedTeardownPending).toEqual(['bulk-delete-teardown-owed']);
    expect(await engine.get('bulk-delete-teardown-owed')).not.toBeNull();
  });

  it('requires a confirmation token before deleting matching terminal workflows', async () => {
    using engine = createEngine();

    const handle = await engine.start('echo', 'first', {
      id: 'bulk-delete-token-required',
      tags: ['selected'],
    });
    await handle.result();

    const response = await handleRequest(request({ filter: { tags: ['selected'] } }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "confirmationToken" is required after a dry run',
    });
    expect(await engine.get('bulk-delete-token-required')).not.toBeNull();
  });

  it('returns 422 when the filter matches non-terminal workflows', async () => {
    using engine = createEngine();

    const completedHandle = await engine.start('echo', 'done', {
      id: 'bulk-delete-completed',
      tags: ['mixed'],
    });
    await completedHandle.result();

    await engine.start('waiting', undefined, {
      id: 'bulk-delete-running',
      tags: ['mixed'],
    });
    await waitForStatus(engine, 'bulk-delete-running', 'running');

    const response = await handleRequest(
      request({ filter: { tags: ['mixed'] }, dryRun: true }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Bulk delete matches non-terminal workflows',
    });

    await engine.cancel('bulk-delete-running');
  });

  it('returns 400 when the bulk filter is unscoped', async () => {
    using engine = createEngine();

    const response = await handleRequest(request({ filter: {} }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });
  });

  it('returns 400 with the "Field \\"filter.tags\\"" label when filter tags contain an empty string', async () => {
    using engine = createEngine();

    const response = await handleRequest(request({ filter: { tags: [''] } }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "filter.tags" must not contain empty tags',
    });
  });

  it('returns 400 when a filter time-range bound is not a finite number', async () => {
    using engine = createEngine();

    const response = await handleRequest(
      request({ filter: { tags: ['selected'], createdAt: { gt: 'not-a-number' } } }),
      engine,
      { ...bulkAdminHandlerOptions() },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Time-range bound "gt" must be a finite number',
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    using engine = createEngine();
    const failingOperation = {
      ...bulkDeleteWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'delete failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(request({ filter: { tags: ['selected'] } }), engine, {
      ...bulkAdminHandlerOptions(failingRegistry),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
