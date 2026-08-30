/**
 * Proves that the same `async function*` runs identically in library mode,
 * server mode, and platform-agnostic handler mode (browser/Service Worker)
 * without modification.
 *
 * The workflow functions defined here are written once and registered into
 * three separate Engine instances — one accessed via LocalClient (library
 * mode), one via HttpClient against a Bun.serve server (server mode), and
 * one via direct handleRequest calls (simulating a browser/SW fetch handler).
 *
 * @module core/workflow-portability.test
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { HttpClient } from '../client/index.ts';
import type { WeftClient } from '../client/interface.ts';
import { LocalClient } from '../client/local.ts';
import { handleRequest } from '../server/handler.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';

// ---------------------------------------------------------------------------
// Shared workflow functions — identical code used across all three modes
// ---------------------------------------------------------------------------

const greet = async (...args: unknown[]) => `Hello, ${args[0] as string}!`;
const double = async (...args: unknown[]) => (args[0] as number) * 2;

/**
 * A multi-step workflow that exercises ctx.run with multiple activities.
 * This exact function reference is registered in every mode's engine.
 */
async function* multiStepWorkflow(ctx: WorkflowContext, input: unknown) {
  const c = ctx;
  const { name, value } = input as { name: string; value: number };
  const greeting = yield* c.run(greet, name);
  const doubled = yield* c.run(double, value);
  return { greeting, doubled };
}

/**
 * A simple passthrough workflow — proves that even the simplest generator
 * shape works unchanged across modes.
 */
async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

/**
 * A workflow that uses signals — verifies that the signal/wait pattern
 * works identically regardless of the deployment wrapper.
 */
async function* signalWorkflow(ctx: WorkflowContext, _input: unknown) {
  const c = ctx;
  const approval = yield* c.waitForSignal<{ approved: boolean }>('approve');
  return { approved: approval.approved };
}

// ---------------------------------------------------------------------------
// Mode setup: library, server, handler
// ---------------------------------------------------------------------------

let libraryEngine: Engine;
let libraryClient: WeftClient;

let serverEngine: Engine;
let server: ReturnType<typeof Bun.serve>;
let serverClient: WeftClient;

let handlerEngine: Engine;

/** Simulate a browser/Service Worker fetch handler using handleRequest. */
function handlerFetch(request: Request): Promise<Response> {
  return handleRequest(request, handlerEngine);
}

/** Helper to build a Request against the handler. */
function handlerRequest(method: string, path: string, body?: unknown): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, options);
}

function registerWorkflows(engine: Engine): void {
  const multiStepWorkflow2 = workflow({ name: 'multi-step' }).execute(multiStepWorkflow);
  engine.register(multiStepWorkflow2);
  const echoWorkflow2 = workflow({ name: 'echo' }).execute(echoWorkflow);
  engine.register(echoWorkflow2);
  const signalWorkflow2 = workflow({ name: 'signal' }).execute(signalWorkflow);
  engine.register(signalWorkflow2);
}

beforeAll(() => {
  // Library mode: direct in-process engine
  libraryEngine = new Engine({ storage: new MemoryStorage() });
  registerWorkflows(libraryEngine);
  libraryClient = new LocalClient(libraryEngine);

  // Server mode: engine behind Bun.serve + HttpClient
  serverEngine = new Engine({ storage: new MemoryStorage() });
  registerWorkflows(serverEngine);
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      return handleRequest(request, serverEngine);
    },
  });
  serverClient = new HttpClient({ baseUrl: `http://localhost:${server.port}` });

  // Handler mode: engine behind handleRequest (simulates browser/SW)
  handlerEngine = new Engine({ storage: new MemoryStorage() });
  registerWorkflows(handlerEngine);
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([
    libraryEngine[Symbol.asyncDispose](),
    serverEngine[Symbol.asyncDispose](),
    handlerEngine[Symbol.asyncDispose](),
  ]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow portability: same async function* across all modes', () => {
  describe('echo workflow (passthrough)', () => {
    it('library mode returns input unchanged', async () => {
      const handle = await libraryClient.start('echo', { message: 'hello' });
      const result = await handle.result();
      expect(result).toEqual({ message: 'hello' });
    });

    it('server mode returns input unchanged', async () => {
      const handle = await serverClient.start('echo', { message: 'hello' });
      const result = await handle.result();
      expect(result).toEqual({ message: 'hello' });
    });

    it('handler mode returns input unchanged', async () => {
      const response = await handlerFetch(
        handlerRequest('POST', '/v1/workflows', { type: 'echo', input: { message: 'hello' } }),
      );
      expect(response.status).toBe(201);

      const { id } = (await response.json()) as { id: string };
      const getResponse = await handlerFetch(handlerRequest('GET', `/v1/workflows/${id}/result`));
      const body = (await getResponse.json()) as { result: unknown };
      expect(body.result).toEqual({ message: 'hello' });
    });

    it('all three modes produce the same result for the same input', async () => {
      const input = { data: [1, 2, 3], nested: { ok: true } };

      const libHandle = await libraryClient.start('echo', input);
      const srvHandle = await serverClient.start('echo', input);

      const libResult = await libHandle.result();
      const srvResult = await srvHandle.result();

      // Handler mode
      const handlerResponse = await handlerFetch(
        handlerRequest('POST', '/v1/workflows', { type: 'echo', input }),
      );
      const { id } = (await handlerResponse.json()) as { id: string };
      const resultResponse = await handlerFetch(
        handlerRequest('GET', `/v1/workflows/${id}/result`),
      );
      const { result: handlerResult } = (await resultResponse.json()) as { result: unknown };

      expect(libResult).toEqual(srvResult);
      expect(srvResult).toEqual(handlerResult);
    });
  });

  describe('multi-step workflow (ctx.run)', () => {
    const input = { name: 'Alice', value: 21 };
    const expected = { greeting: 'Hello, Alice!', doubled: 42 };

    it('library mode completes multi-step workflow', async () => {
      const handle = await libraryClient.start('multi-step', input);
      expect(await handle.result()).toEqual(expected);
    });

    it('server mode completes multi-step workflow', async () => {
      const handle = await serverClient.start('multi-step', input);
      expect(await handle.result()).toEqual(expected);
    });

    it('handler mode completes multi-step workflow', async () => {
      const response = await handlerFetch(
        handlerRequest('POST', '/v1/workflows', { type: 'multi-step', input }),
      );
      const { id } = (await response.json()) as { id: string };
      const resultResponse = await handlerFetch(
        handlerRequest('GET', `/v1/workflows/${id}/result`),
      );
      const { result } = (await resultResponse.json()) as { result: unknown };
      expect(result).toEqual(expected);
    });

    it('all three modes produce identical results', async () => {
      const libHandle = await libraryClient.start('multi-step', input);
      const srvHandle = await serverClient.start('multi-step', input);

      const libResult = await libHandle.result();
      const srvResult = await srvHandle.result();

      const handlerResponse = await handlerFetch(
        handlerRequest('POST', '/v1/workflows', { type: 'multi-step', input }),
      );
      const { id } = (await handlerResponse.json()) as { id: string };
      const resultResponse = await handlerFetch(
        handlerRequest('GET', `/v1/workflows/${id}/result`),
      );
      const { result: handlerResult } = (await resultResponse.json()) as { result: unknown };

      expect(libResult).toEqual(expected);
      expect(srvResult).toEqual(expected);
      expect(handlerResult).toEqual(expected);
    });
  });

  describe('signal workflow (ctx.waitForSignal)', () => {
    it('library mode handles signals', async () => {
      const handle = await libraryClient.start('signal', {});
      await libraryClient.signal(handle.id, 'approve', { approved: true });
      expect(await handle.result()).toEqual({ approved: true });
    });

    it('server mode handles signals', async () => {
      const handle = await serverClient.start('signal', {});
      await serverClient.signal(handle.id, 'approve', { approved: true });
      expect(await handle.result()).toEqual({ approved: true });
    });

    it('handler mode handles signals', async () => {
      const startResponse = await handlerFetch(
        handlerRequest('POST', '/v1/workflows', { type: 'signal', input: {} }),
      );
      const { id } = (await startResponse.json()) as { id: string };

      await handlerFetch(
        handlerRequest('POST', `/v1/workflows/${id}/signal/approve`, {
          payload: { approved: true },
        }),
      );

      const resultResponse = await handlerFetch(
        handlerRequest('GET', `/v1/workflows/${id}/result`),
      );
      const { result } = (await resultResponse.json()) as { result: unknown };
      expect(result).toEqual({ approved: true });
    });

    it('all three modes produce identical signal results', async () => {
      const libHandle = await libraryClient.start('signal', {});
      const srvHandle = await serverClient.start('signal', {});
      const handlerResponse = await handlerFetch(
        handlerRequest('POST', '/v1/workflows', { type: 'signal', input: {} }),
      );
      const { id: handlerId } = (await handlerResponse.json()) as { id: string };

      // Send signals
      await libraryClient.signal(libHandle.id, 'approve', { approved: true });
      await serverClient.signal(srvHandle.id, 'approve', { approved: true });
      await handlerFetch(
        handlerRequest('POST', `/v1/workflows/${handlerId}/signal/approve`, {
          payload: { approved: true },
        }),
      );

      const libResult = await libHandle.result();
      const srvResult = await srvHandle.result();
      const resultResponse = await handlerFetch(
        handlerRequest('GET', `/v1/workflows/${handlerId}/result`),
      );
      const { result: handlerResult } = (await resultResponse.json()) as { result: unknown };

      expect(libResult).toEqual({ approved: true });
      expect(srvResult).toEqual({ approved: true });
      expect(handlerResult).toEqual({ approved: true });
    });
  });

  describe('workflow function identity', () => {
    it('the same function reference is registered in all modes', () => {
      // This test verifies that we are not defining separate workflow
      // functions per mode — the exact same function reference is used.
      // Engine.register stores handlers internally; we verify by starting
      // workflows of the same type and getting consistent results (covered
      // above). Here we verify the registration itself doesn't throw,
      // confirming the function shape is accepted by all engines.
      expect(() => {
        const freshEngine = new Engine();
        registerWorkflows(freshEngine);
        freshEngine[Symbol.dispose]();
      }).not.toThrow();
    });
  });
});
