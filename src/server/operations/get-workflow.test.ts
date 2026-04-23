/**
 * Phase 15c — Parity diff test for the `weft.workflows.get` migration.
 *
 * Runs the same request through both dispatch paths and asserts
 * byte-for-byte equivalence on status, headers, and body:
 *
 *   - Legacy path: `handleRequest(request, engine)` with no
 *     `restDispatchMode` override (defaults to 'legacy').
 *   - Pipeline path: `handleRequest(request, engine, { restDispatchMode:
 *     'via-execute-operation' })` — the REST router sees the binding
 *     for `weft.workflows.get` and dispatches via `executeOperation`
 *     through its `shapeSuccess` / `shapeFault` mappers.
 *
 * Cases:
 *   1. Happy path — existing workflow returns its state.
 *   2. Not-found path — nonexistent id returns 404 with the legacy
 *      error-body shape (`{ error: "Workflow \"X\" not found" }`).
 */

import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './get-workflow.ts';

/** An engine whose only workflow blocks on a signal — keeps state frozen across reads. */
function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await Bun.sleep(5);
  }
  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

async function responseFingerprint(response: Response): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

async function runBoth(
  engine: Engine,
  path: string,
): Promise<{
  readonly legacy: Awaited<ReturnType<typeof responseFingerprint>>;
  readonly viaExecuteOperation: Awaited<ReturnType<typeof responseFingerprint>>;
}> {
  const registry = createOperationRegistry([getWorkflowOperation]);

  const legacyRequest = new Request(`http://localhost${path}`, { method: 'GET' });
  const legacyResponse = await handleRequest(legacyRequest, engine);
  const legacy = await responseFingerprint(legacyResponse);

  const newRequest = new Request(`http://localhost${path}`, { method: 'GET' });
  const newResponse = await handleRequest(newRequest, engine, {
    restDispatchMode: 'via-execute-operation',
    operationRegistry: registry,
    restBindings: [getWorkflowRestBinding],
  });
  const viaExecuteOperation = await responseFingerprint(newResponse);

  return { legacy, viaExecuteOperation };
}

describe('weft.workflows.get — REST parity diff (Phase 15c)', () => {
  it('happy path: existing workflow returns identical response across both dispatch modes', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    // Wait for a stable state — 'hold' blocks on a signal, so the
    // engine won't advance while the two back-to-back GETs happen.
    await waitForStatus(engine, handle.id, 'running');

    const { legacy, viaExecuteOperation } = await runBoth(engine, `/v1/workflows/${handle.id}`);

    expect(viaExecuteOperation.status).toBe(legacy.status);
    expect(viaExecuteOperation.contentType).toBe(legacy.contentType);
    expect(viaExecuteOperation.body).toBe(legacy.body);
    expect(legacy.status).toBe(200);
  });

  it('not-found: nonexistent workflow returns identical 404 across both dispatch modes', async () => {
    const engine = createEngine();

    const { legacy, viaExecuteOperation } = await runBoth(engine, '/v1/workflows/does-not-exist');

    expect(viaExecuteOperation.status).toBe(legacy.status);
    expect(viaExecuteOperation.contentType).toBe(legacy.contentType);
    expect(viaExecuteOperation.body).toBe(legacy.body);
    expect(legacy.status).toBe(404);
    // Verify the legacy error-body shape is preserved by the binding's
    // shapeFault — if this drifts to the canonical fault shape before
    // Milestone 2, the parity contract is broken.
    expect(JSON.parse(legacy.body)).toEqual({ error: 'Workflow "does-not-exist" not found' });
  });

  it('pipeline path is active: operation invoke is actually called under via-execute-operation', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    // Construct a registry whose `weft.workflows.get` is a spy that
    // returns a sentinel state. If the pipeline path is active, the
    // spy runs; if handler falls back to legacy, the spy does not run
    // and the test response carries the engine's real state.
    let spyCalled = false;
    const spyOperation = {
      ...getWorkflowOperation,
      invoke: async ({ input }: { input: { workflowId: string } }) => {
        spyCalled = true;
        return {
          id: input.workflowId,
          status: 'spy-sentinel',
        } as never;
      },
    };
    const spyRegistry = createOperationRegistry([spyOperation]);

    const request = new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'GET' });
    const response = await handleRequest(request, engine, {
      restDispatchMode: 'via-execute-operation',
      operationRegistry: spyRegistry,
      restBindings: [getWorkflowRestBinding],
    });

    expect(spyCalled).toBe(true);
    const body = (await response.json()) as { status?: string };
    expect(body.status).toBe('spy-sentinel');
  });
});
