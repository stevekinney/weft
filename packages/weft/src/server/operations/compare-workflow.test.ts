/**
 * `weft.workflows.compare` and `weft.workflows.fork` with `dryRun: true` (COR-2536), over REST.
 */
import { describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { workflow, type WorkflowContext } from '../../core/types.ts';
import { startAndSettle } from '../../testing/run-observation.test-support.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from '../rest-bindings.ts';
import {
  compareWorkflowOperation,
  compareWorkflowRestBinding,
  createCompareWorkflowOperation,
  type WorkflowReadAuthorizer,
} from './compare-workflow.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './fork-workflow.ts';

const registry = createOperationRegistry([compareWorkflowOperation, forkWorkflowOperation]);
const bindings = [compareWorkflowRestBinding, forkWorkflowRestBinding];
const options = { operationRegistry: registry, restBindings: bindings };

const stepper = workflow({ name: 'stepper' }).execute(async function* (
  ctx: WorkflowContext,
  count: unknown,
) {
  for (let index = 0; index < Number(count); index += 1) {
    yield* ctx.run(async (input: unknown) => input, { index });
  }
  return 'done';
});

async function engineWithRun(steps: number, id = 'source') {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(stepper);
  await startAndSettle(engine, 'stepper', steps, id);
  return engine;
}

function compareRequest(id: string, query = ''): Request {
  return new Request(`http://localhost/v1/workflows/${id}/compare${query}`);
}

describe('weft.workflows.compare', () => {
  it('answers the source, the fork point and the aligned steps of a fork', async () => {
    await using engine = await engineWithRun(5);
    const fork = await engine.fork('source', { fromStep: 3 });
    await fork.result();

    const response = await handleRequest(compareRequest(fork.id), engine, options);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflowId: string;
      sourceWorkflowId: string;
      forkPoint: number;
      steps: {
        index: number;
        shared: boolean;
        source?: { input: string };
        fork?: { input: string };
      }[];
    };
    expect(body).toMatchObject({ workflowId: fork.id, sourceWorkflowId: 'source', forkPoint: 3 });
    expect(body.steps.map((step) => [step.index, step.shared])).toEqual([
      [0, true],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
    expect(body.steps[2]?.source?.input).toBe('{"index":2}');
    expect(body.steps[2]?.fork?.input).toBe('{"index":2}');
  });

  it('pages with limit and cursor query parameters', async () => {
    await using engine = await engineWithRun(250);
    const fork = await engine.fork('source');
    await fork.result();

    const pages: { steps: unknown[]; nextCursor?: string }[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const response = await handleRequest(compareRequest(fork.id, query), engine, options);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { steps: unknown[]; nextCursor?: string };
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(pages.map((page) => page.steps.length)).toEqual([100, 100, 50]);

    const small = await handleRequest(compareRequest(fork.id, '?limit=7'), engine, options);
    expect(((await small.json()) as { steps: unknown[] }).steps).toHaveLength(7);
  });

  it('answers 422 naming what to do for a run that is not a fork', async () => {
    await using engine = await engineWithRun(2);

    const response = await handleRequest(compareRequest('source'), engine, options);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('is not a fork');
    expect(body.error).toContain('weft.workflows.fork');
  });

  it('answers 404 for an unknown fork, and 404 naming the source when the source is gone', async () => {
    await using engine = await engineWithRun(3);
    const missing = await handleRequest(compareRequest('missing'), engine, options);
    expect(missing.status).toBe(404);

    const fork = await engine.fork('source', { fromStep: 2 });
    await fork.result();
    await engine.purgeById('source');
    const response = await handleRequest(compareRequest(fork.id), engine, options);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain('source');
  });

  describe('with an authorizeWorkflowRead hook', () => {
    function optionsWithHook(authorizeWorkflowRead?: WorkflowReadAuthorizer) {
      const operation = createCompareWorkflowOperation({ authorizeWorkflowRead });
      return {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [compareWorkflowRestBinding],
      };
    }

    async function forkOfSource(engine: Awaited<ReturnType<typeof engineWithRun>>) {
      const fork = await engine.fork('source', { fromStep: 2 });
      await fork.result();
      return fork.id;
    }

    it('answers NotFound, naming only the fork, when the hook allows the fork but not its source', async () => {
      await using engine = await engineWithRun(3);
      const forkId = await forkOfSource(engine);
      const asked: { workflowId: string; method: string }[] = [];

      const response = await handleRequest(
        compareRequest(forkId),
        engine,
        optionsWithHook(({ principal, workflowId }) => {
          asked.push({ workflowId, method: principal.method });
          return workflowId === forkId;
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe(`Workflow "${forkId}" not found`);
      expect(body.error).not.toContain('source');
      expect(asked.map((entry) => entry.workflowId)).toEqual([forkId, 'source']);
      expect(asked[0]?.method).toBe('unauthenticated-local');
    });

    it('answers the same NotFound when the hook denies the fork, and never asks about the source', async () => {
      await using engine = await engineWithRun(3);
      const forkId = await forkOfSource(engine);
      const asked: string[] = [];

      const response = await handleRequest(
        compareRequest(forkId),
        engine,
        optionsWithHook(({ workflowId }) => {
          asked.push(workflowId);
          return false;
        }),
      );

      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toBe(
        `Workflow "${forkId}" not found`,
      );
      expect(asked).toEqual([forkId]);
    });

    it('does not tell a denied caller that a run is not a fork', async () => {
      await using engine = await engineWithRun(2);

      const response = await handleRequest(
        compareRequest('source'),
        engine,
        optionsWithHook(() => false),
      );

      expect(response.status).toBe(404);
    });

    it('compares when the hook allows the fork and its source', async () => {
      await using engine = await engineWithRun(3);
      const forkId = await forkOfSource(engine);

      const response = await handleRequest(
        compareRequest(forkId),
        engine,
        optionsWithHook(async () => true),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        workflowId: forkId,
        sourceWorkflowId: 'source',
      });
    });

    it('is wired from the live registry serve() builds, so the option reaches the operation', async () => {
      await using engine = await engineWithRun(3);
      const forkId = await forkOfSource(engine);

      const response = await handleRequest(compareRequest(forkId), engine, {
        operationRegistry: createLiveOperationRegistry({
          authorizeWorkflowRead: ({ workflowId }) => workflowId === forkId,
        }),
        restBindings: createLiveRestBindings(),
      });

      expect(response.status).toBe(404);
    });

    it('stays scope-only, so a comparison succeeds, when no hook is configured', async () => {
      await using engine = await engineWithRun(3);
      const forkId = await forkOfSource(engine);

      const response = await handleRequest(compareRequest(forkId), engine, optionsWithHook());

      expect(response.status).toBe(200);
    });
  });

  it('answers 400 for a limit or cursor it cannot use', async () => {
    await using engine = await engineWithRun(3);
    const fork = await engine.fork('source', { fromStep: 2 });
    await fork.result();

    for (const query of [
      '?limit=0',
      '?limit=1001',
      '?limit=many',
      '?cursor=elsewhere',
      '?cursor=step:-1',
    ]) {
      const response = await handleRequest(compareRequest(fork.id, query), engine, options);
      expect(response.status, query).toBe(400);
    }
  });
});

describe('weft.workflows.fork with dryRun', () => {
  function forkRequest(id: string, body: unknown): Request {
    return new Request(`http://localhost/v1/workflows/${id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers what the fork would keep and run again, and starts no run', async () => {
    await using engine = await engineWithRun(5);
    const listedBefore = await engine.list();
    const before = listedBefore.items.length;

    const response = await handleRequest(
      forkRequest('source', { fromStep: 3, dryRun: true }),
      engine,
      options,
    );

    // The published spec lists one status for the operation, so a dry run answers the fork's 201.
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      dryRun: boolean;
      forkPoint: number;
      keptSteps: unknown[];
      rerunSteps: unknown[];
      revisionWouldChange: boolean;
    };
    expect(body).toMatchObject({ dryRun: true, forkPoint: 3, revisionWouldChange: false });
    expect(body.keptSteps).toHaveLength(2);
    expect(body.rerunSteps).toHaveLength(3);
    const listedAfter = await engine.list();
    expect(listedAfter.items).toHaveLength(before);
  });

  it('still forks when dryRun is absent or false', async () => {
    await using engine = await engineWithRun(3);
    const response = await handleRequest(forkRequest('source', { dryRun: false }), engine, options);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBeString();
  });

  it('answers 404 for an unknown source, as the fork does', async () => {
    await using engine = await engineWithRun(1);
    const response = await handleRequest(forkRequest('nothing', { dryRun: true }), engine, options);
    expect(response.status).toBe(404);
  });
});
