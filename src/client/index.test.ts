import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { handleRequest } from '../server/handler.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { HttpClient } from './index.ts';
import type { WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

let engine: Engine;
let server: ReturnType<typeof Bun.serve>;
let client: WeftClient;

beforeAll(() => {
  engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', echoWorkflow);

  server = Bun.serve({
    port: 0, // random available port
    async fetch(request) {
      return handleRequest(request, engine);
    },
  });

  client = new HttpClient({ baseUrl: `http://localhost:${server.port}` });
});

afterAll(async () => {
  server.stop(true);
  await engine[Symbol.asyncDispose]();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpClient', () => {
  it('implements WeftClient', () => {
    expect(client.start).toBeFunction();
    expect(client.get).toBeFunction();
    expect(client.list).toBeFunction();
    expect(client.cancel).toBeFunction();
    expect(client.signal).toBeFunction();
    expect(client.query).toBeFunction();
    expect(client.update).toBeFunction();
    expect(client.resume).toBeFunction();
    expect(client.recoverAll).toBeFunction();
    expect(client.timeout).toBeFunction();
    expect(client.getAttributes).toBeFunction();
    expect(client.setAttributes).toBeFunction();
    expect(client.getEvents).toBeFunction();
    expect(client.listReviews).toBeFunction();
    expect(client.submitReview).toBeFunction();
    expect(client.setBudgetPolicy).toBeFunction();
    expect(client.submitCoordinatedUpdate).toBeFunction();
    expect(client.getUpdateResult).toBeFunction();
  });

  describe('start', () => {
    it('starts a workflow and returns a handle with a workflow id', async () => {
      const handle = await client.start('echo', 'hello');
      expect(handle.id).toBeString();
      expect(handle.id.length).toBeGreaterThan(0);
    });

    it('respects a custom id in start options', async () => {
      const handle = await client.start('echo', 'hello', { id: 'http-custom-id' });
      expect(handle.id).toBe('http-custom-id');
    });

    it('returns a handle whose result() resolves with the workflow output', async () => {
      const handle = await client.start('echo', 42);
      const result = await handle.result();
      expect(result).toBe(42);
    });
  });

  describe('get', () => {
    it('returns the workflow state for a known workflow', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-get-test' });
      await handle.result();

      const state = await client.get('http-get-test');
      expect(state).not.toBeNull();
      expect(state!.id).toBe('http-get-test');
      expect(state!.type).toBe('echo');
      expect(state!.status).toBe('completed');
    });

    it('returns null for an unknown workflow', async () => {
      const state = await client.get('nonexistent');
      expect(state).toBeNull();
    });
  });

  describe('list', () => {
    it('lists workflows', async () => {
      const result = await client.list();
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const result = await client.list({ status: 'completed' });
      expect(result.items.every((item) => item.status === 'completed')).toBe(true);
    });
  });

  describe('cancel', () => {
    it('cancels a workflow via the client', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-cancel-test' });
      await handle.result();
      // Cancelling a completed workflow — should not error
      await client.cancel('http-cancel-test');
    });
  });

  describe('handle.cancel', () => {
    it('delegates to client.cancel', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-handle-cancel' });
      await handle.result();
      await handle.cancel();
    });
  });

  describe('handle.signal', () => {
    it('delegates to client.signal', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-handle-signal' });
      await handle.result();
      await handle.signal('test-signal', { key: 'value' });
    });
  });

  describe('getEvents', () => {
    it('returns event history for a workflow', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-events-test' });
      await handle.result();

      const events = await client.getEvents('http-events-test');
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('getAttributes / setAttributes', () => {
    it('round-trips search attributes', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-attrs-test' });
      await handle.result();

      await client.setAttributes('http-attrs-test', { priority: 'high' });
      const attributes = await client.getAttributes('http-attrs-test');
      expect(attributes).not.toBeNull();
      expect(attributes!['priority']).toBe('high');
    });
  });

  describe('listReviews', () => {
    it('returns an array', async () => {
      const reviews = await client.listReviews();
      expect(Array.isArray(reviews)).toBe(true);
    });
  });

  describe('getUpdateResult', () => {
    it('returns null for an unknown update', async () => {
      const result = await client.getUpdateResult('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('same interface as LocalClient', () => {
    it('both export WeftClient-compatible classes', async () => {
      const { LocalClient } = await import('./local.ts');
      const localEngine = new Engine({ storage: new MemoryStorage() });
      localEngine.register('echo', echoWorkflow);

      const local: WeftClient = new LocalClient(localEngine);
      const remote: WeftClient = client;

      // Both should have the same set of methods
      const clientMethods = [
        'start',
        'get',
        'list',
        'cancel',
        'signal',
        'query',
        'update',
        'resume',
        'recoverAll',
        'timeout',
        'getAttributes',
        'setAttributes',
        'getEvents',
        'listReviews',
        'submitReview',
        'setBudgetPolicy',
        'submitCoordinatedUpdate',
        'getUpdateResult',
      ] as const;

      for (const method of clientMethods) {
        expect(typeof local[method]).toBe('function');
        expect(typeof remote[method]).toBe('function');
      }

      await localEngine[Symbol.asyncDispose]();
    });
  });
});
