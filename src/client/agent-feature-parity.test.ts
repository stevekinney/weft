import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * Agent feature parity tests.
 *
 * Proves that streaming and human review features work identically
 * through both {@link LocalClient} (library mode) and {@link HttpClient}
 * (server mode). No agent capability is server-only or library-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { StreamReference } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import { ReviewCoordinator } from '../core/review/index.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { handleRequest } from '../server/handler.ts';
import { principalFromApiKey } from '../server/principal.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { HttpClient } from './index.ts';
import type { WeftClient } from './interface.ts';
import { LocalClient } from './local.ts';

// ---------------------------------------------------------------------------
// Test workflows
// ---------------------------------------------------------------------------

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

const streamingWorkflow = workflow({ name: 'streaming' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  const c = ctx;
  const reference = yield* c.stream('report', async function* () {
    yield { row: 1, data: 'alpha' };
    yield { row: 2, data: 'bravo' };
    yield { row: 3, data: 'charlie' };
  });
  // Block until a caller signals us: stream chunks are cleaned up on terminal
  // state, so tests need the workflow to stay in `running` while they read.
  yield* c.waitForSignal('finish-streaming');
  return reference;
});

// ---------------------------------------------------------------------------
// Shared test suite — runs against both LocalClient and HttpClient
// ---------------------------------------------------------------------------

function agentFeatureTests(getClient: () => WeftClient, getEngine: () => Engine, label: string) {
  describe(`${label}: human review`, () => {
    it('listReviews returns reviews created via ReviewCoordinator', async () => {
      const client = getClient();
      const engine = getEngine();

      // Create a review directly through the coordinator (simulating a workflow)
      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview('test-workflow', {
        artifact: { code: 'console.log("hello")' },
        reviewType: 'code',
        reviewers: ['alice@example.com'],
      });

      const reviews = await client.listReviews();
      expect(reviews.length).toBeGreaterThanOrEqual(1);

      const found = reviews.find((r) => r['reviewId'] === review.reviewId);
      expect(found).toBeDefined();
      expect(found!['workflowId']).toBe('test-workflow');
      expect(found!['reviewType']).toBe('code');
    });

    it('submitReview removes the review from pending list', async () => {
      const client = getClient();
      const engine = getEngine();

      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview(`${label}-submit-wf`, {
        artifact: 'some artifact',
        reviewType: 'design',
        reviewers: ['bob@example.com'],
      });

      // Verify it shows up
      const before = await client.listReviews();
      const found = before.find((r) => r['reviewId'] === review.reviewId);
      expect(found).toBeDefined();

      // Submit the decision
      await client.submitReview(review.reviewId, {
        decision: 'approved',
        reviewer: 'bob@example.com',
        feedback: 'Looks good!',
        workflowId: `${label}-submit-wf`,
      });

      // Verify it's gone from pending
      const after = await client.listReviews();
      const stillThere = after.find((r) => r['reviewId'] === review.reviewId);
      expect(stillThere).toBeUndefined();
    });

    it('listReviews can request completed reviews via a status filter', async () => {
      const client = getClient();
      const engine = getEngine();

      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview(`${label}-completed-wf`, {
        artifact: 'some artifact',
        reviewType: 'security',
        reviewers: ['casey@example.com'],
      });

      await client.submitReview(review.reviewId, {
        decision: 'approved',
        reviewer: 'casey@example.com',
        workflowId: `${label}-completed-wf`,
      });

      const completed = await client.listReviews({ status: 'completed' });
      const found = completed.find((entry) => entry['reviewId'] === review.reviewId);
      expect(found).toBeDefined();
      expect(found!['status']).toBe('completed');
      expect(found!['reviewType']).toBe('security');
    });
  });

  describe(`${label}: streaming`, () => {
    it('getStreamChunks reads back data written by ctx.stream()', async () => {
      const client = getClient();

      const handle = await client.start('streaming', null);
      // Workflow pauses on a signal after streaming so chunks are still in
      // storage (cleanup runs on terminal state).
      await sleepForTesting(20);

      const chunks = await client.getStreamChunks(handle.id, 'report');
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ sequence: 0, value: { row: 1, data: 'alpha' } });
      expect(chunks[1]).toEqual({ sequence: 1, value: { row: 2, data: 'bravo' } });
      expect(chunks[2]).toEqual({ sequence: 2, value: { row: 3, data: 'charlie' } });

      // Unblock the workflow so its resources get released.
      await client.signal(handle.id, 'finish-streaming');
      const result = (await handle.result()) as StreamReference;
      expect(result.key).toBe('report');
      expect(result.chunkCount).toBe(3);
    });

    it('getStreamChunks returns empty array for unknown key', async () => {
      const client = getClient();

      const handle = await client.start('echo', 'data');
      await handle.result();

      const chunks = await client.getStreamChunks(handle.id, 'nonexistent');
      expect(chunks).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Interface completeness check — shared across both clients
// ---------------------------------------------------------------------------

const AGENT_METHODS = ['listReviews', 'submitReview', 'getStreamChunks'] as const;

function interfaceCompletenessTests(getClient: () => WeftClient, label: string) {
  describe(`${label}: interface completeness`, () => {
    for (const method of AGENT_METHODS) {
      it(`exposes ${method}()`, () => {
        const client = getClient();
        expect(typeof client[method]).toBe('function');
      });
    }
  });
}

// ---------------------------------------------------------------------------
// LocalClient suite
// ---------------------------------------------------------------------------

describe('Agent feature parity: LocalClient (library mode)', () => {
  let engine: Engine;
  let client: WeftClient;

  beforeAll(() => {
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(echoWorkflow);
    engine.register(streamingWorkflow);
    client = new LocalClient(engine);
  });

  afterAll(async () => {
    await engine[Symbol.asyncDispose]();
  });

  interfaceCompletenessTests(() => client, 'LocalClient');
  agentFeatureTests(
    () => client,
    () => engine,
    'local',
  );
});

// ---------------------------------------------------------------------------
// HttpClient suite
// ---------------------------------------------------------------------------

describe('Agent feature parity: HttpClient (server mode)', () => {
  let engine: Engine;
  let server: ReturnType<typeof Bun.serve>;
  let client: WeftClient;

  beforeAll(() => {
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(echoWorkflow);
    engine.register(streamingWorkflow);

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        return handleRequest(request, engine, {
          authContext: {
            method: 'api-key',
            principal: principalFromApiKey({
              subject: 'agent-feature-parity',
              scopes: ['reviews:read'],
            }),
          },
        });
      },
    });

    client = new HttpClient({ baseUrl: `http://localhost:${server.port}` });
  });

  afterAll(async () => {
    server.stop(true);
    await engine[Symbol.asyncDispose]();
  });

  interfaceCompletenessTests(() => client, 'HttpClient');
  agentFeatureTests(
    () => client,
    () => engine,
    'http',
  );
});

// ---------------------------------------------------------------------------
// Cross-mode equivalence
// ---------------------------------------------------------------------------

describe('Agent feature parity: cross-mode equivalence', () => {
  it('LocalClient and HttpClient expose the same agent methods', () => {
    const localEngine = new Engine({ storage: new MemoryStorage() });
    const local = new LocalClient(localEngine);
    const remote = new HttpClient({ baseUrl: 'http://localhost:0' });

    for (const method of AGENT_METHODS) {
      expect(typeof local[method]).toBe('function');
      expect(typeof remote[method]).toBe('function');
    }

    localEngine[Symbol.dispose]();
  });
});
