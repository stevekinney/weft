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
 *   3. Pipeline activation — spy operation proves the via-execute-
 *      operation path actually runs (not a silent fallback to legacy).
 */

import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { assertFingerprintsMatch, runParity } from '../parity-harness.ts';
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

const parityOptions = {
  registry: createOperationRegistry([getWorkflowOperation]),
  bindings: [getWorkflowRestBinding],
};

describe('weft.workflows.get — REST parity diff (Phase 15c)', () => {
  it('happy path: existing workflow returns identical response across both dispatch modes', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForStatus(engine, handle.id, 'running');

    const request = new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'GET' });
    const { legacy, viaExecuteOperation } = await runParity(engine, request, parityOptions);

    assertFingerprintsMatch(viaExecuteOperation, legacy, 'weft.workflows.get (happy path)');
    expect(legacy.status).toBe(200);
  });

  it('not-found: nonexistent workflow returns identical 404 across both dispatch modes', async () => {
    const engine = createEngine();

    const request = new Request('http://localhost/v1/workflows/does-not-exist', { method: 'GET' });
    const { legacy, viaExecuteOperation } = await runParity(engine, request, parityOptions);

    assertFingerprintsMatch(viaExecuteOperation, legacy, 'weft.workflows.get (not-found)');
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

    // A spy registry whose `weft.workflows.get` returns a sentinel
    // state. If the pipeline path is active, the spy runs; if the
    // handler silently falls back to legacy, the spy does not run.
    let spyCalled = false;
    const spyOperation = {
      ...getWorkflowOperation,
      invoke: async ({ input }: { input: { workflowId: string } }) => {
        spyCalled = true;
        return { id: input.workflowId, status: 'spy-sentinel' } as never;
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
