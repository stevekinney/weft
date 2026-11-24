/**
 * `weft.workflows.purge` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import {
  type OperationFault,
  defineOperation,
  principalFromApiKey,
} from "../../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  handleJsonRpcHttpRequest,
} from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/keys.ts';
import { startAndSettle } from '../../testing/run-observation.test-support.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { purgeWorkflowsOperation, purgeWorkflowsRestBinding } from './purge-workflows.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  yield* [];
  return input;
});

/** Refuses the commit that deletes one run, once armed, as a storage that fails for that run alone would. */
class PurgeFailingStorage extends MemoryStorage {
  failingWorkflowId: string | undefined;

  override conditionalBatch(
    ...[conditions, operations]: Parameters<MemoryStorage['conditionalBatch']>
  ): ReturnType<MemoryStorage['conditionalBatch']> {
    const failingKey =
      this.failingWorkflowId === undefined ? undefined : KEYS.workflow(this.failingWorkflowId);
    if (failingKey !== undefined && conditions.some((condition) => condition.key === failingKey)) {
      return Promise.reject(new Error('disk full'));
    }
    return super.conditionalBatch(conditions, operations);
  }
}

function createEngine(storage: MemoryStorage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

function request(body?: unknown): Request {
  return new Request('http://localhost/v1/workflows/purge', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([purgeWorkflowsOperation]);
const bindings = [purgeWorkflowsRestBinding];

/** Purge the way the server requires it: a dry run of `body`, then a commit with its token. */
async function purgeWithPreview(engine: Engine, body: Record<string, unknown>): Promise<Response> {
  const previewResponse = await handleRequest(request({ ...body, dryRun: true }), engine, {
    operationRegistry: registry,
    restBindings: bindings,
  });
  const preview = (await previewResponse.json()) as { confirmationToken: string };
  return handleRequest(request({ ...body, confirmationToken: preview.confirmationToken }), engine, {
    operationRegistry: registry,
    restBindings: bindings,
  });
}

type PurgeJsonRpcAnswer = {
  result?: { confirmationToken: string };
  error?: { code: number; message: string; data: { weftCode: string; httpStatus: number } };
};

/** Calls `weft.workflows.purge` over JSON-RPC HTTP as a `workflows:admin` operator. */
function jsonRpcPurge(engine: Engine) {
  const principal = principalFromApiKey({ subject: 'purge-admin', scopes: ['workflows:admin'] });
  return async (params: unknown, id: number): Promise<PurgeJsonRpcAnswer> => {
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'weft.workflows.purge', params, id }),
      }),
      { registry, host: engine, principal },
    );
    return (await response.json()) as PurgeJsonRpcAnswer;
  };
}

describe('weft.workflows.purge', () => {
  it('purges terminal workflows that match the provided filter', async () => {
    await using engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', { id: 'purge-selected-a' });
    const secondHandle = await engine.start('echo', 'second', { id: 'purge-selected-b' });
    const otherHandle = await engine.start('echo', 'other', { id: 'purge-other' });
    await firstHandle.result();
    await secondHandle.result();
    await otherHandle.result();

    await engine.setAttributes('purge-selected-a', { bucket: 'target' });
    await engine.setAttributes('purge-selected-b', { bucket: 'target' });
    await engine.setAttributes('purge-other', { bucket: 'other' });

    const response = await purgeWithPreview(engine, {
      filter: {
        status: 'completed',
        attributes: [{ key: 'bucket', value: 'target' }],
        offset: 1,
        limit: 1,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expect.objectContaining({ deleted: 1 }));
    expect(await engine.get('purge-selected-a')).not.toBeNull();
    expect(await engine.get('purge-selected-b')).toBeNull();
    expect(await engine.get('purge-other')).not.toBeNull();
  });

  it('treats an omitted filter as unfiltered', async () => {
    await using engine = createEngine();

    const handle = await engine.start('echo', 'delete-me', { id: 'purge-unfiltered' });
    await handle.result();

    const response = await purgeWithPreview(engine, { note: 'ignored' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expect.objectContaining({ deleted: 1 }));
    expect(await engine.get('purge-unfiltered')).toBeNull();
  });

  it('previews without deleting, and the commit deletes only what the preview named', async () => {
    await using engine = createEngine();

    for (const id of ['purge-named-a', 'purge-named-b']) {
      await startAndSettle(engine, 'echo', id, id);
    }
    const stores = async () => [
      await engine.get('purge-named-a'),
      await engine.get('purge-named-b'),
    ];
    const before = await stores();

    const preview = await handleRequest(
      request({ filter: { status: 'completed' }, dryRun: true }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    const previewBody = (await preview.json()) as {
      dryRun: boolean;
      action: string;
      matched: number;
      sampleWorkflowIds: string[];
      confirmationToken: string;
    };

    expect(previewBody).toMatchObject({
      dryRun: true,
      action: 'purge',
      matched: 2,
      sampleWorkflowIds: ['purge-named-a', 'purge-named-b'],
    });
    // A dry run writes nothing: both runs read back exactly as before.
    expect(await stores()).toEqual(before);

    // A run that finishes after the preview was not named by it, so the token no longer matches.
    await startAndSettle(engine, 'echo', 'late', 'purge-named-late');
    const stale = await handleRequest(
      request({
        filter: { status: 'completed' },
        confirmationToken: previewBody.confirmationToken,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    // A stale token is a conflict with the state the preview described, not malformed input.
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: string };
    expect(staleBody.error).toContain('Run the preview again');
    expect(await stores()).toEqual(before);
    expect(await engine.get('purge-named-late')).not.toBeNull();
  });

  it('answers a stale confirmation token over JSON-RPC as Conflict, apart from invalid input, and deletes nothing', async () => {
    await using engine = createEngine();
    await startAndSettle(engine, 'echo', 'keep', 'purge-rpc-a');
    const call = jsonRpcPurge(engine);

    const preview = await call({ status: 'completed', dryRun: true }, 1);
    await startAndSettle(engine, 'echo', 'late', 'purge-rpc-late');
    const stale = await call(
      { status: 'completed', confirmationToken: preview.result?.confirmationToken },
      2,
    );

    expect(stale.error?.code).toBe(-32021);
    expect(stale.error?.data).toMatchObject({ weftCode: 'Conflict', httpStatus: 409 });
    expect(stale.error?.message).toContain('Run the preview again');
    expect(await engine.get('purge-rpc-a')).not.toBeNull();
    expect(await engine.get('purge-rpc-late')).not.toBeNull();

    // Input a caller got wrong stays InvalidParams, so the two never share a code.
    const missingToken = await call({ status: 'completed' }, 3);
    expect(missingToken.error?.data.weftCode).toBe('InvalidParams');
  });

  it('a purge that fails part-way tells the JSON-RPC caller how many workflows it deleted and how many it failed for', async () => {
    const storage = new PurgeFailingStorage();
    await using engine = createEngine(storage);
    await startAndSettle(engine, 'echo', 'one', 'purge-partial-a');
    await startAndSettle(engine, 'echo', 'two', 'purge-partial-b');
    const call = jsonRpcPurge(engine);

    const preview = await call({ status: 'completed', dryRun: true }, 1);
    storage.failingWorkflowId = 'purge-partial-b';
    const failed = await call(
      { status: 'completed', confirmationToken: preview.result?.confirmationToken },
      2,
    );

    expect(failed.error?.data.weftCode).toBe('EngineFailure');
    // The message is what the caller shows: it says what was deleted, not "internal error".
    expect(failed.error?.message).toBe('Purge deleted 1 workflow and failed for 1.');
    expect(await engine.get('purge-partial-a')).toBeNull();
    expect(await engine.get('purge-partial-b')).not.toBeNull();
  });

  it('a failure that deleted nothing says so', async () => {
    const storage = new PurgeFailingStorage();
    await using engine = createEngine(storage);
    await startAndSettle(engine, 'echo', 'one', 'purge-none-a');
    const call = jsonRpcPurge(engine);

    const preview = await call({ status: 'completed', dryRun: true }, 1);
    storage.failingWorkflowId = 'purge-none-a';
    const failed = await call(
      { status: 'completed', confirmationToken: preview.result?.confirmationToken },
      2,
    );

    expect(failed.error?.message).toBe('Purge deleted 0 workflows and failed for 1.');
    expect(await engine.get('purge-none-a')).not.toBeNull();
  });

  it('refuses a commit that carries no confirmation token', async () => {
    await using engine = createEngine();
    await startAndSettle(engine, 'echo', 'keep', 'purge-no-token');

    const response = await handleRequest(request({ filter: { status: 'completed' } }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await engine.get('purge-no-token')).not.toBeNull();
  });

  it('returns 400 for invalid filter bodies', async () => {
    await using engine = createEngine();

    let response = await handleRequest(
      request({
        filter: {
          attributes: [{ key: '' }],
        },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "filter.attributes[0].key" must be a non-empty string',
      retryable: false,
    });

    response = await handleRequest(request(['not-an-object']), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "filter" must be an object',
      retryable: false,
    });
  });

  it('maps EngineFailure faults to a 500 response', async () => {
    await using engine = createEngine();
    const failingOperation = defineOperation({
      ...purgeWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'purge failed',
          data: {},
        };
        throw fault;
      },
    });
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(request({ dryRun: true }), engine, {
      operationRegistry: failingRegistry,
      restBindings: bindings,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
  });
});
