import { describe, expect, it } from 'bun:test';

import { AsyncActivityTokenNotFoundError, Engine } from '../../core/engine.ts';
import type { ActivityContext, WorkflowContext } from '../../core/types.ts';
import { activity, workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { nextAsyncPendingToken } from '../../testing/async-activity.test-support.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  completeAsyncActivityOperation,
  completeAsyncActivityRestBinding,
  failAsyncActivityOperation,
  failAsyncActivityRestBinding,
} from './async-activity.ts';

const awaitCallback = activity({
  name: 'awaitCallback',
  execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
});

const deferringWorkflow = workflow({ name: 'deferring' })
  .activities({ awaitCallback })
  .execute(async function* (ctx: WorkflowContext, input: unknown) {
    const resolved = yield* ctx.run(awaitCallback);
    return { input, resolved };
  });

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(deferringWorkflow);
  return engine;
}

const registry = createOperationRegistry([
  completeAsyncActivityOperation,
  failAsyncActivityOperation,
]);
const bindings = [completeAsyncActivityRestBinding, failAsyncActivityRestBinding];

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

describe('weft.activities.complete', () => {
  it('completes a deferred activity by token and resumes the workflow', async () => {
    await using engine = createEngine();
    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'order-1');
    const token = await tokenPromise;

    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    const response = await handleRequest(
      request('POST', '/v1/activities/complete', { token, result: { decision: 'approved' } }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.result()).toEqual({
      input: 'order-1',
      resolved: { decision: 'approved' },
    });
  });

  it('treats result as optional, resuming the workflow with undefined', async () => {
    await using engine = createEngine();
    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'order-no-result');
    const token = await tokenPromise;

    const response = await handleRequest(
      request('POST', '/v1/activities/complete', { token }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await handle.result()).toEqual({ input: 'order-no-result', resolved: undefined });
  });

  it('returns 404 NotFound for an unknown token', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/activities/complete', {
        token: 'async-act:v1:does-not-exist:0:1',
        result: 'value',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('No pending async activity'),
    });
  });

  it('returns 404 when the single-use token is replayed after completion', async () => {
    await using engine = createEngine();
    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'order-replay');
    const token = await tokenPromise;

    const first = await handleRequest(
      request('POST', '/v1/activities/complete', { token, result: 'first' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(first.status).toBe(200);
    await handle.result();

    const replay = await handleRequest(
      request('POST', '/v1/activities/complete', { token, result: 'second' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(replay.status).toBe(404);
  });

  it('rejects a non-object body with 400', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/activities/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"a string is not an object"',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON bodies with 400', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/activities/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"token":',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
  });

  it('masks an unexpected engine failure to a 500 generic body', async () => {
    await using engine = createEngine();
    const original = engine.completeAsyncActivity.bind(engine);
    engine.completeAsyncActivity = async () => {
      throw new Error('unexpected completion error');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/activities/complete', { token: 'async-act:v1:x:0:1', result: 1 }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.completeAsyncActivity = original;
    }
  });
});

describe('weft.activities.fail', () => {
  it('fails a deferred activity by token, throwing into the parked workflow', async () => {
    await using engine = createEngine();
    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'order-fail');
    const token = await tokenPromise;

    const response = await handleRequest(
      request('POST', '/v1/activities/fail', {
        token,
        error: { message: 'reviewer rejected', name: 'ReviewError' },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const settled = await handle
      .result()
      .then(() => ({ kind: 'resolved' as const }))
      .catch((error: unknown) => ({ kind: 'rejected' as const, error }));
    expect(settled.kind).toBe('rejected');
    if (settled.kind === 'rejected') {
      const message =
        settled.error instanceof Error ? settled.error.message : String(settled.error);
      expect(message).toContain('reviewer rejected');
    }
  });

  it('returns 404 NotFound for an unknown token', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/activities/fail', {
        token: 'async-act:v1:nope:0:1',
        error: { message: 'whatever' },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
  });

  it('rejects a malformed error payload with 400', async () => {
    await using engine = createEngine();
    const tokenPromise = nextAsyncPendingToken(engine);
    await engine.start('deferring', 'order-bad-error');
    const token = await tokenPromise;

    // `error` must be `{ message: string; name?: string }`; a bare string fails schema.
    const response = await handleRequest(
      request('POST', '/v1/activities/fail', { token, error: 'not-an-object' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
  });

  it('masks an unexpected engine failure to a 500 generic body', async () => {
    await using engine = createEngine();
    const original = engine.failAsyncActivity.bind(engine);
    engine.failAsyncActivity = async () => {
      throw new Error('unexpected failure error');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/activities/fail', {
          token: 'async-act:v1:x:0:1',
          error: { message: 'boom' },
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.failAsyncActivity = original;
    }
  });
});

describe('async activity payload-size enforcement', () => {
  it('rejects an oversized completion result before it resumes the workflow', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      payloadSize: { maxBytes: 64 },
    });
    engine.register(deferringWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'oversize');
    const token = await tokenPromise;

    const oversized = { blob: 'x'.repeat(200) };

    const settled = await engine
      .completeAsyncActivity(token, oversized)
      .then(() => ({ kind: 'resolved' as const }))
      .catch((error: unknown) => ({ kind: 'rejected' as const, error }));

    // The cap must hold: completion is rejected and the workflow stays parked
    // (not completed with an oversized value persisted). Mirrors signal, which
    // enforces payload size via `encodePayloadWithinLimit`.
    expect(settled.kind).toBe('rejected');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    // The single-use token must survive the rejection: a within-limit retry
    // still completes the activity. (The cap is checked before token consumption.)
    await engine.completeAsyncActivity(token, { ok: true });
    expect(await handle.result()).toEqual({ input: 'oversize', resolved: { ok: true } });
  });

  it('shapes an oversized REST completion as 400 InvalidParams, not a masked 500', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      payloadSize: { maxBytes: 64 },
    });
    engine.register(deferringWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'oversize-rest');
    const token = await tokenPromise;

    const response = await handleRequest(
      request('POST', '/v1/activities/complete', { token, result: { blob: 'x'.repeat(200) } }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    // A caller-input size violation is a 400, mirroring how signal rejects an
    // oversize signalId — not a masked 500 EngineFailure.
    expect(response.status).toBe(400);
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });
  });

  it('rejects an oversized failure message before it resumes the workflow', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      payloadSize: { maxBytes: 64 },
    });
    engine.register(deferringWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'oversize-fail');
    const token = await tokenPromise;

    // The failure message is caller-supplied and persisted, so it is capped too.
    const settled = await engine
      .failAsyncActivity(token, new Error('y'.repeat(200)))
      .then(() => ({ kind: 'resolved' as const }))
      .catch((error: unknown) => ({ kind: 'rejected' as const, error }));

    expect(settled.kind).toBe('rejected');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    // Token survived: a within-limit failure still fails the workflow.
    await engine.failAsyncActivity(token, new Error('rejected'));
    const result = await handle
      .result()
      .then(() => 'resolved')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(result).toContain('rejected');
  });

  it('shapes an oversized REST failure message as 400 InvalidParams', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      payloadSize: { maxBytes: 64 },
    });
    engine.register(deferringWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'oversize-fail-rest');
    const token = await tokenPromise;

    const response = await handleRequest(
      request('POST', '/v1/activities/fail', { token, error: { message: 'z'.repeat(200) } }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });
  });
});

describe('async activity single-use token under concurrency', () => {
  it('two concurrent completions for one token: exactly one wins, the other rejects', async () => {
    await using engine = createEngine();
    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferring', 'concurrent');
    const token = await tokenPromise;

    // Fire both without awaiting between them so they race the single-use token.
    // The synchronous in-memory claim in consumePendingAsyncActivity must let
    // exactly one through; the loser sees the token already gone (NotFound). A
    // regression that double-drives the workflow generator would fulfill both.
    const [first, second] = await Promise.allSettled([
      engine.completeAsyncActivity(token, { winner: 'a' }),
      engine.completeAsyncActivity(token, { winner: 'b' }),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AsyncActivityTokenNotFoundError,
    );

    // The workflow completed once, with whichever result won the race.
    const result = (await handle.result()) as { resolved: { winner: string } };
    expect(['a', 'b']).toContain(result.resolved.winner);
  });
});
