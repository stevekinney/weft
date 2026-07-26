import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { faultToHttpResponse } from '../fault-to-http.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { anonymousPrincipal } from '../principal.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './bulk-cancel-workflows.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './bulk-delete-workflows.ts';
import {
  bulkOperationOptionsFromInput,
  listFilterFromBulkInput,
  parseBulkOperationControlFromBody,
  parseRequiredBulkListFilter,
} from './bulk-filter-helpers.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './bulk-mutate-workflow-tags.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './bulk-signal-workflows.ts';
import { forkWorkflowRestBinding } from './fork-workflow.ts';
import { getRetentionOverviewRestBinding } from './get-retention-overview.ts';
import { getStreamChunksOperation, getStreamChunksRestBinding } from './get-stream-chunks.ts';
import { getUpdateResultRestBinding } from './get-update-result.ts';
import { listCheckpointsRestBinding } from './list-checkpoints.ts';
import { listReviewsRestBinding } from './list-reviews.ts';
import { listWorkflowsOperation, listWorkflowsRestBinding } from './list-workflows.ts';
import { invalidParamsFault } from './operation-helpers.ts';
import { purgeWorkflowsOperation } from './purge-workflows.ts';
import { recoverAllRestBinding } from './recover-all.ts';
import { resumeWorkflowRestBinding } from './resume-workflow.ts';
import {
  setWorkflowAttributesOperation,
  setWorkflowAttributesRestBinding,
} from './set-workflow-attributes.ts';
import { startWorkflowRestBinding } from './start-workflow.ts';
import { streamWorkflowSseOperation, streamWorkflowSseRestBinding } from './stream-workflow-sse.ts';
import { timeoutWorkflowRestBinding } from './timeout-workflow.ts';
import { updateWorkflowRestBinding } from './update-workflow.ts';

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

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function expectJsonError(
  response: Response,
  status: number,
  error: string,
  data?: Readonly<Record<string, unknown>>,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json');
  await expect(response.json()).resolves.toEqual(data === undefined ? { error } : { error, data });
}

describe('operation coverage regressions', () => {
  it('covers the bulk filter invalid-params wrapper', () => {
    expect(() => parseRequiredBulkListFilter({ filter: {} })).toThrow(
      invalidParamsFault(
        'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
      ).message,
    );
  });

  it('rejects unknown failure categories in bulk filters', () => {
    expect(() =>
      parseRequiredBulkListFilter({
        filter: { status: 'failed', failureCategory: 'planning' },
      }),
    ).toThrow(
      invalidParamsFault(
        'Field "filter.failureCategory" must be one of application, timeout, cancellation, resource, system',
      ).message,
    );
  });

  it('maps complete bulk filters and rejects malformed control inputs', () => {
    expect(
      listFilterFromBulkInput({
        status: ['running'],
        type: 'checkout',
        tags: ['nightly'],
        attributes: [{ key: 'amount', value: 2, gt: 1, lt: 5 }],
        limit: 20,
        offset: 3,
        scheduleId: 'schedule-1',
        parentWorkflowId: 'parent-id',
        parentWorkflowExecutionToken: 'parent-token',
        idPrefix: 'checkout-',
        failureCategory: 'application',
        createdAt: { gte: 2, lte: 4 },
        updatedAt: { gte: 6 },
        executionDeadline: { lte: 10 },
      }),
    ).toEqual({
      status: ['running'],
      type: 'checkout',
      tags: ['nightly'],
      attributes: [{ key: 'amount', value: 2, gt: 1, lt: 5 }],
      limit: 20,
      offset: 3,
      scheduleId: 'schedule-1',
      parentWorkflowId: 'parent-id',
      parentWorkflowExecutionToken: 'parent-token',
      idPrefix: 'checkout-',
      failureCategory: 'application',
      createdAt: { gte: 2, lte: 4 },
      updatedAt: { gte: 6 },
      executionDeadline: { lte: 10 },
    });

    expect(() =>
      parseRequiredBulkListFilter({
        filter: { attributes: [{ key: 'amount', gt: ['low', 'high'] }] },
      }),
    ).toThrow('Field "filter.attributes[0].gt" must be a string, number, or boolean');
    expect(() =>
      Reflect.apply(listFilterFromBulkInput, undefined, [
        { attributes: [{ key: 'amount', gt: ['low', 'high'] }] },
      ]),
    ).toThrow('Field "filter.attributes[].gt" must be a string, number, or boolean');

    expect(parseBulkOperationControlFromBody(undefined)).toEqual({});
    expect(() => parseBulkOperationControlFromBody(null)).toThrow(
      'Request body must be a JSON object',
    );
    expect(() => parseBulkOperationControlFromBody([])).toThrow(
      'Request body must be a JSON object',
    );
    expect(() => parseBulkOperationControlFromBody({ dryRun: 'yes' })).toThrow(
      'Field "dryRun" must be a boolean',
    );
    expect(() => parseBulkOperationControlFromBody({ bulkConcurrency: 0 })).toThrow(
      'Field "bulkConcurrency" must be a positive integer',
    );
    expect(() => parseBulkOperationControlFromBody({ confirmationToken: '' })).toThrow(
      'Field "confirmationToken" must be a non-empty string',
    );
    expect(bulkOperationOptionsFromInput({ dryRun: true }, anonymousPrincipal())).toEqual({
      dryRun: true,
      principal: { method: 'unauthenticated' },
    });
  });

  it('rejects invalid filter tags across bulk operations', async () => {
    const engine = createEngine();

    let response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/bulk/cancel', { filter: { tags: [''] } }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkCancelWorkflowsOperation]),
        restBindings: [bulkCancelWorkflowsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter.tags" must not contain empty tags');

    response = await handleRequest(
      jsonRequest('DELETE', '/v1/workflows/bulk', { filter: { tags: [''] } }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkDeleteWorkflowsOperation]),
        restBindings: [bulkDeleteWorkflowsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter.tags" must not contain empty tags');

    response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/bulk/signal', {
        filter: { tags: [''] },
        name: 'continue',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkSignalWorkflowsOperation]),
        restBindings: [bulkSignalWorkflowsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter.tags" must not contain empty tags');

    response = await handleRequest(
      jsonRequest('PATCH', '/v1/workflows/bulk/tags', {
        filter: { tags: [''] },
        tags: ['selected'],
        operation: 'add',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkMutateWorkflowTagsOperation]),
        restBindings: [bulkMutateWorkflowTagsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter.tags" must not contain empty tags');

    response = await handleRequest(
      jsonRequest('PATCH', '/v1/workflows/bulk/tags', {
        filter: { tags: ['selected'] },
        tags: [''],
        operation: 'add',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkMutateWorkflowTagsOperation]),
        restBindings: [bulkMutateWorkflowTagsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "tags" must not contain empty tags');

    engine[Symbol.dispose]();
  });

  it('rejects invalid filter tags in direct bulk-operation invokes', async () => {
    const context = {
      engine: createEngine() as never,
      principal: anonymousPrincipal(),
      transport: 'jsonRpcHttp' as const,
    };

    await expect(
      bulkCancelWorkflowsOperation.invoke({
        ...context,
        input: { tags: [''] },
      }),
    ).rejects.toMatchObject({ code: 'InvalidParams' });

    await expect(
      bulkDeleteWorkflowsOperation.invoke({
        ...context,
        input: { tags: [''] },
      }),
    ).rejects.toMatchObject({ code: 'InvalidParams' });

    await expect(
      bulkSignalWorkflowsOperation.invoke({
        ...context,
        input: { tags: [''], name: 'continue' },
      }),
    ).rejects.toMatchObject({ code: 'InvalidParams' });

    await expect(
      bulkMutateWorkflowTagsOperation.invoke({
        ...context,
        input: { filter: { tags: [''] }, tags: ['selected'], operation: 'add' },
      }),
    ).rejects.toMatchObject({ code: 'InvalidParams' });

    await expect(
      bulkMutateWorkflowTagsOperation.invoke({
        ...context,
        input: { filter: { tags: ['selected'] }, tags: [''], operation: 'add' },
      }),
    ).rejects.toMatchObject({ code: 'InvalidParams' });

    await expect(
      purgeWorkflowsOperation.invoke({
        ...context,
        input: { tags: [''] },
      }),
    ).rejects.toMatchObject({ code: 'InvalidParams' });
  });

  it('rejects invalid filter objects in bulk delete, bulk signal, and bulk tag mutation routes', async () => {
    const engine = createEngine();

    let response = await handleRequest(
      jsonRequest('DELETE', '/v1/workflows/bulk', { filter: 'bad' }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkDeleteWorkflowsOperation]),
        restBindings: [bulkDeleteWorkflowsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter" must be an object');

    response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/bulk/signal', {
        filter: 'bad',
        name: 'continue',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkSignalWorkflowsOperation]),
        restBindings: [bulkSignalWorkflowsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter" must be an object');

    response = await handleRequest(
      jsonRequest('PATCH', '/v1/workflows/bulk/tags', {
        filter: 'bad',
        tags: ['selected'],
        operation: 'add',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([bulkMutateWorkflowTagsOperation]),
        restBindings: [bulkMutateWorkflowTagsRestBinding],
      },
    );
    await expectJsonError(response, 400, 'Field "filter" must be an object');

    engine[Symbol.dispose]();
  });

  it('rejects null JSON bodies for workflow attribute updates', async () => {
    const engine = createEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-attributes/attributes', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([setWorkflowAttributesOperation]),
        restBindings: [setWorkflowAttributesRestBinding],
      },
    );

    await expectJsonError(response, 400, 'Invalid JSON body');
    engine[Symbol.dispose]();
  });

  it('accepts numeric cursors for stream replay operations invoked outside REST', async () => {
    let capturedAfter: number | undefined;
    const engine = {
      async getStreamChunks(_workflowId: string, _key: string, options?: { after?: number }) {
        capturedAfter = options?.after;
        return [];
      },
      async get(_workflowId: string) {
        return { status: 'running' };
      },
    };

    await expect(
      getStreamChunksOperation.invoke({
        input: { workflowId: 'wf-stream', key: 'tokens', after: 7 },
        engine: engine as never,
        principal: anonymousPrincipal(),
        transport: 'jsonRpcHttp',
      }),
    ).resolves.toEqual({ chunks: [] });
    expect(capturedAfter).toBe(7);

    await expect(
      streamWorkflowSseOperation.invoke({
        input: { workflowId: 'wf-stream', after: 9 },
        engine: engine as never,
        principal: anonymousPrincipal(),
        transport: 'jsonRpcHttp',
      }),
    ).resolves.toEqual({ chunks: [] });
    expect(capturedAfter).toBe(9);
  });

  it('accepts scalar and string-array search attribute values in workflow listing input', () => {
    expect(
      listWorkflowsOperation.inputSchema.safeParse({
        attributes: [
          { key: 'active', value: true },
          { key: 'priority', value: ['high', 'urgent'] },
        ],
      }).success,
    ).toBe(true);
  });

  it('maps fallback faults on REST bindings to their HTTP status codes', async () => {
    const fallbackFault: OperationFault = {
      code: 'NotFound',
      message: 'missing resource',
      data: { resource: 'workflow', identifier: 'wf-missing' },
    };

    const workflowConflictFault: OperationFault = {
      code: 'Conflict',
      message: 'workflow is busy',
      data: { reason: 'workflow is busy' },
    };

    const bindings = [
      getRetentionOverviewRestBinding,
      getUpdateResultRestBinding,
      listCheckpointsRestBinding,
      listReviewsRestBinding,
      listWorkflowsRestBinding,
      setWorkflowAttributesRestBinding,
      forkWorkflowRestBinding,
      recoverAllRestBinding,
      resumeWorkflowRestBinding,
      startWorkflowRestBinding,
      timeoutWorkflowRestBinding,
      updateWorkflowRestBinding,
      getStreamChunksRestBinding,
      streamWorkflowSseRestBinding,
    ] as const;

    for (const binding of bindings) {
      const usesConflictFault =
        binding === getStreamChunksRestBinding || binding === streamWorkflowSseRestBinding;
      const fault = usesConflictFault ? workflowConflictFault : fallbackFault;
      const response = binding.shapeFault?.(fault) ?? faultToHttpResponse(fault);
      expect(response).toBeDefined();

      const expectedStatus = usesConflictFault ? 409 : 404;
      const expectedMessage = usesConflictFault ? 'workflow is busy' : 'missing resource';

      await expectJsonError(
        response,
        expectedStatus,
        expectedMessage,
        usesConflictFault ? undefined : { resource: 'workflow', identifier: 'wf-missing' },
      );
    }
  });
});
