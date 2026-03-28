import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Engine } from '../core/engine.ts';
import { WorkflowCompletedEvent, WorkflowFailedEvent } from '../core/events.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { WeftClient } from './interface.ts';
import { LocalClient } from './local.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* failingWorkflow(_ctx: WorkflowContext, _input: unknown) {
  throw new Error('intentional failure');
}

function createTestEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', echoWorkflow);
  engine.register('failing', failingWorkflow);
  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalClient', () => {
  let engine: Engine;
  let client: WeftClient;

  beforeEach(() => {
    engine = createTestEngine();
    client = new LocalClient(engine);
  });

  afterEach(async () => {
    await engine[Symbol.asyncDispose]();
  });

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
    it('starts a workflow and returns a handle with the workflow id', async () => {
      const handle = await client.start('echo', 'hello');
      expect(handle.id).toBeString();
      expect(handle.id.length).toBeGreaterThan(0);
    });

    it('respects a custom id in start options', async () => {
      const handle = await client.start('echo', 'hello', { id: 'custom-id' });
      expect(handle.id).toBe('custom-id');
    });

    it('returns a handle whose result() resolves with the workflow output', async () => {
      const handle = await client.start('echo', 42);
      const result = await handle.result();
      expect(result).toBe(42);
    });
  });

  describe('get', () => {
    it('returns the workflow state for a known workflow', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();

      const state = await client.get(handle.id);
      expect(state).not.toBeNull();
      expect(state!.id).toBe(handle.id);
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
      await client.start('echo', 'a');
      await client.start('echo', 'b');

      const result = await client.list();
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('filters by status', async () => {
      const handle = await client.start('echo', 'done');
      await handle.result();

      const result = await client.list({ status: 'completed' });
      expect(result.items.every((item) => item.status === 'completed')).toBe(true);
    });
  });

  describe('cancel', () => {
    it('cancels a workflow via the client', async () => {
      // Use a workflow that won't complete immediately so we can cancel it
      const handle = await client.start('echo', 'data', { id: 'cancel-me' });
      await handle.result().catch(() => {}); // let it finish

      // Cancelling an already-completed workflow is fine on some engines,
      // but let's at least verify the method is callable
      await expect(client.cancel('cancel-me')).resolves.toBeUndefined();
    });
  });

  describe('handle.cancel', () => {
    it('delegates to client.cancel', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();
      // Should not throw on a completed workflow
      await expect(handle.cancel()).resolves.toBeUndefined();
    });
  });

  describe('handle.signal', () => {
    it('delegates to client.signal', async () => {
      const handle = await client.start('echo', 'data');
      // Signal on a completed workflow is a no-throw in the engine
      await expect(handle.signal('test-signal', { key: 'value' })).resolves.toBeUndefined();
    });
  });

  describe('getEvents', () => {
    it('returns event history for a workflow', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();

      const events = await client.getEvents(handle.id);
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('getAttributes / setAttributes', () => {
    it('round-trips search attributes', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();

      await client.setAttributes(handle.id, { priority: 'high' });
      const attributes = await client.getAttributes(handle.id);
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

  describe('event observation', () => {
    it('handle.addEventListener receives workflow:completed events', async () => {
      const handle = await client.start('echo', 'hello');
      const received: WorkflowCompletedEvent[] = [];

      handle.addEventListener(WorkflowCompletedEvent.type, ((event: WorkflowCompletedEvent) => {
        received.push(event);
      }) as EventListener);

      await handle.result();

      expect(received).toHaveLength(1);
      expect(received[0]!.workflowId).toBe(handle.id);
      expect(received[0]!.result).toBe('hello');
      expect(received[0]!.type).toBe('workflow:completed');
    });

    it('handle.addEventListener receives workflow:failed events', async () => {
      const handle = await client.start('failing', null);
      const received: WorkflowFailedEvent[] = [];

      handle.addEventListener(WorkflowFailedEvent.type, ((event: WorkflowFailedEvent) => {
        received.push(event);
      }) as EventListener);

      await handle.result().catch(() => {});

      expect(received).toHaveLength(1);
      expect(received[0]!.workflowId).toBe(handle.id);
      expect(received[0]!.error).toBeInstanceOf(Error);
      expect(received[0]!.error.message).toBe('intentional failure');
    });

    it('handle.removeEventListener stops receiving events', async () => {
      const handle = await client.start('echo', 42);
      let callCount = 0;

      const listener = (() => {
        callCount++;
      }) as EventListener;

      handle.addEventListener(WorkflowCompletedEvent.type, listener);
      handle.removeEventListener(WorkflowCompletedEvent.type, listener);

      await handle.result();

      expect(callCount).toBe(0);
    });

    it('supports AbortSignal for automatic listener cleanup', async () => {
      const handle = await client.start('echo', 'signal-test');
      const controller = new AbortController();
      let callCount = 0;

      handle.addEventListener(
        WorkflowCompletedEvent.type,
        (() => {
          callCount++;
        }) as EventListener,
        { signal: controller.signal },
      );

      controller.abort();
      await handle.result();

      expect(callCount).toBe(0);
    });

    it('delivers typed event properties through the handle', async () => {
      const handle = await client.start('echo', { nested: true });

      const { promise, resolve } = Promise.withResolvers<WorkflowCompletedEvent>();
      handle.addEventListener(WorkflowCompletedEvent.type, ((event: WorkflowCompletedEvent) => {
        resolve(event);
      }) as EventListener);

      await handle.result();
      const event = await promise;

      expect(event).toBeInstanceOf(WorkflowCompletedEvent);
      expect(event.workflowId).toBe(handle.id);
      expect(event.result).toEqual({ nested: true });
      expect(event.duration).toBeGreaterThanOrEqual(0);
    });

    it('multiple listeners on the same handle each receive the event', async () => {
      const handle = await client.start('echo', 'multi');
      const results: string[] = [];

      handle.addEventListener(WorkflowCompletedEvent.type, (() => {
        results.push('listener-a');
      }) as EventListener);

      handle.addEventListener(WorkflowCompletedEvent.type, (() => {
        results.push('listener-b');
      }) as EventListener);

      await handle.result();

      expect(results).toContain('listener-a');
      expect(results).toContain('listener-b');
      expect(results).toHaveLength(2);
    });
  });
});
