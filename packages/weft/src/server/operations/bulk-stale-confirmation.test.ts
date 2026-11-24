/**
 * A stale bulk confirmation token answers `Conflict` on every bulk operation that checks one, over
 * REST and over JSON-RPC, and a commit with no token stays `InvalidParams`. The operations share
 * `staleConfirmationFault`; this suite pins that each of them routes through it and declares the
 * fault, so a new bulk operation that maps the engine's error differently fails here.
 * (`weft.workflows.purge` is covered in `purge-workflows.test.ts`.)
 */

import { describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  handleJsonRpcHttpRequest,
} from "../../embedded/backchannel/src/internals.ts";
import type { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { handleRequest } from '../handler.ts';
import { createJsonRequest } from '../http-request.test-support.ts';
import { waitForStatus } from '../workflow-status.test-support.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './bulk-cancel-workflows.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './bulk-delete-workflows.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './bulk-mutate-workflow-tags.ts';
import {
  createBulkTestEngine,
  bulkAdminHandlerOptions as makeBulkAdminHandlerOptions,
} from './bulk-operation.test-support.ts';
import {
  bulkRetryFailedWorkflowsOperation,
  bulkRetryFailedWorkflowsRestBinding,
} from './bulk-retry-failed-workflows.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './bulk-signal-workflows.ts';

type SubjectMode = 'wait' | 'done' | 'fail';

/** One workflow type whose input picks how it settles, so each operation can find the state it acts on. */
const subjectWorkflow = workflow({ name: 'subject' }).execute(async function* (
  ctx: WorkflowContext,
  mode: SubjectMode,
) {
  if (mode === 'fail') throw new Error('failed on purpose');
  if (mode === 'wait') yield* ctx.waitForSignal('continue');
  return mode;
});

const operations = [
  bulkCancelWorkflowsOperation,
  bulkDeleteWorkflowsOperation,
  bulkMutateWorkflowTagsOperation,
  bulkRetryFailedWorkflowsOperation,
  bulkSignalWorkflowsOperation,
];
const bindings = [
  bulkCancelWorkflowsRestBinding,
  bulkDeleteWorkflowsRestBinding,
  bulkMutateWorkflowTagsRestBinding,
  bulkRetryFailedWorkflowsRestBinding,
  bulkSignalWorkflowsRestBinding,
];
const registry = createOperationRegistry(operations);

type BulkCase = {
  readonly operationName: string;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** How the workflows the operation acts on settle before the preview. */
  readonly mode: SubjectMode;
  readonly status: 'running' | 'completed' | 'failed';
  /** The operation's own fields beside the filter. */
  readonly fields: Record<string, unknown>;
};

/** What a workflow shows after a refused commit: gone, or its status and tags. */
const stateOf = async (engine: Engine, workflowId: string) => {
  const state = await engine.get(workflowId);
  return state === null ? null : { status: state.status, tags: state.tags };
};

const cases: readonly BulkCase[] = [
  {
    operationName: 'weft.workflows.bulk.cancel',
    method: 'POST',
    path: '/v1/workflows/bulk/cancel',
    mode: 'wait',
    status: 'running',
    fields: {},
  },
  {
    operationName: 'weft.workflows.bulk.delete',
    method: 'DELETE',
    path: '/v1/workflows/bulk',
    mode: 'done',
    status: 'completed',
    fields: {},
  },
  {
    operationName: 'weft.workflows.bulk.tags',
    method: 'PATCH',
    path: '/v1/workflows/bulk/tags',
    mode: 'done',
    status: 'completed',
    fields: { tags: ['added'], operation: 'add' },
  },
  {
    operationName: 'weft.workflows.bulk.retryfailed',
    method: 'POST',
    path: '/v1/workflows/bulk/retry-failed',
    mode: 'fail',
    status: 'failed',
    fields: {},
  },
  {
    operationName: 'weft.workflows.bulk.signal',
    method: 'POST',
    path: '/v1/workflows/bulk/signal',
    mode: 'wait',
    status: 'running',
    fields: { name: 'continue' },
  },
];

/** The REST body nests the filter; JSON-RPC params carry its fields beside the operation's own. */
function restBody(bulkCase: BulkCase, tag: string, controls: Record<string, unknown>) {
  return { filter: { tags: [tag] }, ...bulkCase.fields, ...controls };
}

function jsonRpcParams(bulkCase: BulkCase, tag: string, controls: Record<string, unknown>) {
  // The tag-mutation operation takes its filter as a nested `filter`; the rest are flat.
  const isTagMutation = bulkCase.operationName === 'weft.workflows.bulk.tags';
  return isTagMutation
    ? { filter: { tags: [tag] }, ...bulkCase.fields, ...controls }
    : { tags: [tag], ...bulkCase.fields, ...controls };
}

async function seed(engine: Engine, bulkCase: BulkCase, tag: string, workflowId: string) {
  await engine.start('subject', bulkCase.mode, { id: workflowId, tags: [tag] });
  await waitForStatus(engine, workflowId, bulkCase.status);
}

type RpcAnswer = {
  result?: { confirmationToken: string };
  error?: {
    code: number;
    message: string;
    data: { weftCode: string; httpStatus: number; remediation?: string };
  };
};

function callJsonRpc(engine: Engine, operationName: string) {
  const principal = principalFromApiKey({
    subject: 'bulk-admin-operator',
    scopes: ['workflows:admin'],
  });
  return async (params: unknown, id: number): Promise<RpcAnswer> => {
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: operationName, params, id }),
      }),
      { registry, host: engine, principal },
    );
    return (await response.json()) as RpcAnswer;
  };
}

describe('a stale bulk confirmation token', () => {
  for (const bulkCase of cases) {
    describe(bulkCase.operationName, () => {
      it('declares Conflict as a producible fault', () => {
        const operation = operations.find(({ name }) => name === bulkCase.operationName);
        expect(operation?.producibleFaults).toContain('Conflict');
      });

      it('answers Conflict over REST, tells the caller to preview again, and changes nothing', async () => {
        await using engine = createBulkTestEngine(subjectWorkflow);
        const tag = 'stale-rest';
        await seed(engine, bulkCase, tag, 'stale-rest-first');
        const send = (body: unknown) =>
          handleRequest(
            createJsonRequest({ method: bulkCase.method, path: bulkCase.path, body }),
            engine,
            makeBulkAdminHandlerOptions({ registry, bindings }),
          );

        const preview = await send(restBody(bulkCase, tag, { dryRun: true }));
        expect(preview.status).toBe(200);
        const { confirmationToken } = (await preview.json()) as { confirmationToken: string };
        const before = await stateOf(engine, 'stale-rest-first');

        // A workflow that joins the filter after the preview was not named by it.
        await seed(engine, bulkCase, tag, 'stale-rest-late');
        const lateBefore = await stateOf(engine, 'stale-rest-late');
        const stale = await send(restBody(bulkCase, tag, { confirmationToken }));

        expect(stale.status).toBe(409);
        const body = (await stale.json()) as {
          error: string;
          retryable: boolean;
          remediation?: string;
        };
        expect(body.error).toContain('Run the preview again');
        expect(body.retryable).toBe(false);
        expect(body.remediation).toContain('Run the preview again');
        expect(await stateOf(engine, 'stale-rest-first')).toEqual(before);
        expect(await stateOf(engine, 'stale-rest-late')).toEqual(lateBefore);

        // Input the caller got wrong stays a 400, so the two never share a code.
        const missingToken = await send(restBody(bulkCase, tag, {}));
        expect(missingToken.status).toBe(400);
      });

      it('answers Conflict over JSON-RPC, apart from a missing token, and changes nothing', async () => {
        await using engine = createBulkTestEngine(subjectWorkflow);
        const tag = 'stale-rpc';
        await seed(engine, bulkCase, tag, 'stale-rpc-first');
        const call = callJsonRpc(engine, bulkCase.operationName);

        const preview = await call(jsonRpcParams(bulkCase, tag, { dryRun: true }), 1);
        const before = await stateOf(engine, 'stale-rpc-first');
        await seed(engine, bulkCase, tag, 'stale-rpc-late');
        const lateBefore = await stateOf(engine, 'stale-rpc-late');
        const stale = await call(
          jsonRpcParams(bulkCase, tag, { confirmationToken: preview.result?.confirmationToken }),
          2,
        );

        expect(stale.error?.code).toBe(-32021);
        expect(stale.error?.data).toMatchObject({
          weftCode: 'Conflict',
          httpStatus: 409,
          retryable: false,
        });
        expect(stale.error?.data.remediation).toContain('Run the preview again');
        expect(stale.error?.message).toContain('Run the preview again');
        expect(await stateOf(engine, 'stale-rpc-first')).toEqual(before);
        expect(await stateOf(engine, 'stale-rpc-late')).toEqual(lateBefore);

        const missingToken = await call(jsonRpcParams(bulkCase, tag, {}), 3);
        expect(missingToken.error?.data.weftCode).toBe('InvalidParams');
      });
    });
  }
});
