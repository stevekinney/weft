import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface';
import { MemoryStorage } from '../storage/memory';
import { decode, encode } from './codec';
import { UpdateCoordinator, UpdateTimeoutError } from './updates';

describe('UpdateCoordinator', () => {
  let storage: MemoryStorage;
  let coordinator: UpdateCoordinator;

  beforeEach(() => {
    storage = new MemoryStorage();
    coordinator = new UpdateCoordinator(storage);
  });

  afterEach(() => {
    storage.clear();
  });

  describe('createRequest', () => {
    it('writes to storage at the correct key', async () => {
      const updateId = await coordinator.createRequest('wf-1', 'myUpdate', { value: 42 });

      const raw = await storage.get(`upd:wf-1:${updateId}`);
      expect(raw).not.toBeNull();

      const stored = decode(raw!) as {
        updateId: string;
        workflowId: string;
        name: string;
        payload: unknown;
        createdAt: number;
      };
      expect(stored.workflowId).toBe('wf-1');
      expect(stored.name).toBe('myUpdate');
      expect(stored.payload).toEqual({ value: 42 });
    });

    it('returns a UUID', async () => {
      const updateId = await coordinator.createRequest('wf-1', 'myUpdate', null);

      // UUID v4 pattern: 8-4-4-4-12 hex characters
      expect(updateId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    });
  });

  describe('getPendingUpdates', () => {
    it('returns pending requests for a workflow', async () => {
      const id1 = await coordinator.createRequest('wf-1', 'update-a', 'payload-a');
      const id2 = await coordinator.createRequest('wf-1', 'update-b', 'payload-b');

      const pending = await coordinator.getPendingUpdates('wf-1');

      expect(pending).toHaveLength(2);
      const ids = pending.map((request) => request.updateId);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    it('returns empty array when none exist', async () => {
      const pending = await coordinator.getPendingUpdates('wf-nonexistent');
      expect(pending).toEqual([]);
    });

    it('returns pending requests for workflow ids that require key encoding', async () => {
      const workflowId = 'wf:updates/with spaces';
      await coordinator.createRequest(workflowId, 'update-a', 'payload-a');
      await coordinator.createRequest(workflowId, 'update-b', 'payload-b');

      const pending = await coordinator.getPendingUpdates(workflowId);

      expect(pending).toHaveLength(2);
      expect(await storage.get(KEYS.update(workflowId, pending[0]!.updateId))).not.toBeNull();
      expect(await storage.get(KEYS.update(workflowId, pending[1]!.updateId))).not.toBeNull();
    });
  });

  describe('buildResponseOperations', () => {
    it('returns correct batch operations (DELETE request + PUT response)', () => {
      const operations = coordinator.buildResponseOperations('upd-1', 'wf-1', { answer: 42 });

      expect(operations).toHaveLength(2);

      const deleteOperation = operations.find((operation) => operation.type === 'delete');
      expect(deleteOperation).toBeDefined();
      expect(deleteOperation!.key).toBe('upd:wf-1:upd-1');

      const putOperation = operations.find((operation) => operation.type === 'put');
      expect(putOperation).toBeDefined();
      expect(putOperation!.key).toBe('upr:upd-1');

      const decoded = decode(
        (putOperation as { type: 'put'; key: string; value: Uint8Array }).value,
      ) as {
        updateId: string;
        result: unknown;
      };
      expect(decoded.updateId).toBe('upd-1');
      expect(decoded.result).toEqual({ answer: 42 });
    });

    it('includes idempotency key mapping when provided', () => {
      const operations = coordinator.buildResponseOperations(
        'upd-1',
        'wf-1',
        'result',
        undefined,
        'idem-key-1',
      );

      expect(operations).toHaveLength(3);

      const idempotencyPut = operations.find(
        (operation) => operation.type === 'put' && operation.key === 'upk:wf-1:idem-key-1',
      );
      expect(idempotencyPut).toBeDefined();

      const decoded = decode(
        (idempotencyPut as { type: 'put'; key: string; value: Uint8Array }).value,
      ) as { updateId: string };
      expect(decoded.updateId).toBe('upd-1');
    });
  });

  describe('getResponse', () => {
    it('returns stored response', async () => {
      const response = { updateId: 'upd-1', result: 'hello', createdAt: Date.now() };
      await storage.put('upr:upd-1', encode(response));

      const retrieved = await coordinator.getResponse('upd-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.updateId).toBe('upd-1');
      expect(retrieved!.result).toBe('hello');
    });

    it('returns null for non-existent', async () => {
      const retrieved = await coordinator.getResponse('nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  describe('checkIdempotency', () => {
    it('returns null for new key', async () => {
      const result = await coordinator.checkIdempotency('wf-1', 'new-key');
      expect(result).toBeNull();
    });

    it('returns existing response for duplicate key', async () => {
      // Simulate a completed update with idempotency key
      const response = { updateId: 'upd-1', result: 'cached-result', createdAt: Date.now() };
      await storage.put('upr:upd-1', encode(response));
      await storage.put('upk:wf-1:idem-key', encode({ updateId: 'upd-1' }));

      const result = await coordinator.checkIdempotency('wf-1', 'idem-key');

      expect(result).not.toBeNull();
      expect(result!.updateId).toBe('upd-1');
      expect(result!.result).toBe('cached-result');
    });
  });

  describe('waitForResponse', () => {
    it('resolves when response appears', async () => {
      // Write the response after a short delay
      setTimeout(async () => {
        const response = { updateId: 'upd-1', result: 'done', createdAt: Date.now() };
        await storage.put('upr:upd-1', encode(response));
      }, 80);

      const response = await coordinator.waitForResponse('upd-1', 2000);

      expect(response.updateId).toBe('upd-1');
      expect(response.result).toBe('done');
    });

    it('rejects with UpdateTimeoutError after timeout', async () => {
      try {
        await coordinator.waitForResponse('upd-nonexistent', 120);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UpdateTimeoutError);
        expect((error as UpdateTimeoutError).updateId).toBe('upd-nonexistent');
        expect((error as UpdateTimeoutError).message).toContain('120');
      }
    });
  });

  describe('UpdateTimeoutError', () => {
    it('has correct updateId', () => {
      const error = new UpdateTimeoutError('upd-42', 5000);
      expect(error.updateId).toBe('upd-42');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('UpdateTimeoutError');
      expect(error.message).toContain('upd-42');
      expect(error.message).toContain('5000');
    });
  });

  describe('cleanupExpiredResponses', () => {
    it('removes old responses', async () => {
      const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      const recentTimestamp = Date.now();

      await storage.put(
        'upr:old-1',
        encode({ updateId: 'old-1', result: 'old', createdAt: oldTimestamp }),
      );
      await storage.put(
        'upr:recent-1',
        encode({ updateId: 'recent-1', result: 'recent', createdAt: recentTimestamp }),
      );

      const cleaned = await coordinator.cleanupExpiredResponses(60 * 60 * 1000); // 1 hour TTL

      expect(cleaned).toBe(1);
      expect(await storage.get('upr:old-1')).toBeNull();
      expect(await storage.get('upr:recent-1')).not.toBeNull();
    });

    it('removes orphaned idempotency mappings for expired responses', async () => {
      const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      const recentTimestamp = Date.now();

      // Expired response with an idempotency mapping
      await storage.put(
        'upr:old-1',
        encode({ updateId: 'old-1', result: 'old', createdAt: oldTimestamp }),
      );
      await storage.put('upk:wf-1:idem-old', encode({ updateId: 'old-1' }));

      // Recent response with an idempotency mapping (should be kept)
      await storage.put(
        'upr:recent-1',
        encode({ updateId: 'recent-1', result: 'recent', createdAt: recentTimestamp }),
      );
      await storage.put('upk:wf-1:idem-recent', encode({ updateId: 'recent-1' }));

      const cleaned = await coordinator.cleanupExpiredResponses(60 * 60 * 1000);

      expect(cleaned).toBe(1);
      expect(await storage.get('upr:old-1')).toBeNull();
      expect(await storage.get('upk:wf-1:idem-old')).toBeNull();
      expect(await storage.get('upr:recent-1')).not.toBeNull();
      expect(await storage.get('upk:wf-1:idem-recent')).not.toBeNull();
    });

    it('removes orphaned idempotency mappings across different workflows', async () => {
      const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

      // wf-1: expired response with its idempotency mapping
      await storage.put(
        'upr:upd-wf1',
        encode({ updateId: 'upd-wf1', result: 'result-wf1', createdAt: oldTimestamp }),
      );
      await storage.put('upk:wf-1:idem-wf1', encode({ updateId: 'upd-wf1' }));

      // wf-2: expired response with its idempotency mapping
      await storage.put(
        'upr:upd-wf2',
        encode({ updateId: 'upd-wf2', result: 'result-wf2', createdAt: oldTimestamp }),
      );
      await storage.put('upk:wf-2:idem-wf2', encode({ updateId: 'upd-wf2' }));

      const cleaned = await coordinator.cleanupExpiredResponses(60 * 60 * 1000); // 1 hour TTL

      expect(cleaned).toBe(2);
      expect(await storage.get('upr:upd-wf1')).toBeNull();
      expect(await storage.get('upk:wf-1:idem-wf1')).toBeNull();
      expect(await storage.get('upr:upd-wf2')).toBeNull();
      expect(await storage.get('upk:wf-2:idem-wf2')).toBeNull();
    });

    it('returns zero when no responses are expired', async () => {
      const recentTimestamp = Date.now();

      await storage.put(
        'upr:recent-1',
        encode({ updateId: 'recent-1', result: 'recent', createdAt: recentTimestamp }),
      );
      await storage.put('upk:wf-1:idem-recent', encode({ updateId: 'recent-1' }));

      const cleaned = await coordinator.cleanupExpiredResponses(60 * 60 * 1000);

      expect(cleaned).toBe(0);
      expect(await storage.get('upr:recent-1')).not.toBeNull();
      expect(await storage.get('upk:wf-1:idem-recent')).not.toBeNull();
    });
  });

  describe('multiple updates', () => {
    it('multiple updates to same workflow coexist', async () => {
      const id1 = await coordinator.createRequest('wf-1', 'update-a', 'payload-a');
      const id2 = await coordinator.createRequest('wf-1', 'update-b', 'payload-b');

      expect(id1).not.toBe(id2);

      const pending = await coordinator.getPendingUpdates('wf-1');
      expect(pending).toHaveLength(2);

      // Complete one update
      const operations = coordinator.buildResponseOperations(id1, 'wf-1', 'result-a');
      await storage.batch(operations);

      // The other should still be pending
      const remaining = await coordinator.getPendingUpdates('wf-1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.updateId).toBe(id2);

      // Both responses accessible independently
      const response1 = await coordinator.getResponse(id1);
      expect(response1).not.toBeNull();
      expect(response1!.result).toBe('result-a');
    });
  });
});
