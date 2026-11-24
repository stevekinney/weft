import { describe, expect, it } from 'bun:test';

import { TaskState } from '@a2a-js/sdk';
import { toJsonRpcError } from '@a2a-js/sdk/errors';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  a2aStoreBackends,
  callContext,
  interposedStorage,
  overwriteRecord,
  pushConfigFixture,
  storedKeys,
  storedText,
  taskFixture,
  useBackendStorage,
} from './a2a-store.test-support.ts';
import { createWeftPushNotificationStore } from './push-notification-store.ts';
import { A2AStoreConflictError, A2AStoreRecordVersionError } from './store-errors.ts';
import { createWeftA2ATaskStore, DEFAULT_A2A_TERMINAL_RETENTION_MS } from './task-store.ts';

const ALICE = callContext({ user: 'alice' });

describe('createWeftA2ATaskStore', () => {
  it('refuses a storage adapter without conditional batches', () => {
    const storage = new MemoryStorage();
    const withoutCas = new Proxy(storage, {
      get(target, property) {
        if (property === 'capabilities') {
          return () => ({ ...target.capabilities(), conditionalBatch: false });
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => createWeftA2ATaskStore({ storage: withoutCas, namespace: 'agent' })).toThrow(
      'requires storage capability "conditionalBatch"',
    );
  });

  it('runs every store suite on the memory and SQLite adapters', () => {
    expect(a2aStoreBackends.map((backend) => backend.name)).toEqual([
      'MemoryStorage',
      'BunSQLiteStorage',
    ]);
  });

  it('keeps terminal tasks for thirty days by default', () => {
    expect(DEFAULT_A2A_TERMINAL_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

for (const backend of a2aStoreBackends) {
  describe(`createWeftA2ATaskStore [${backend.name}]`, () => {
    const openStorage = useBackendStorage(backend);

    it('loads a saved task, and a later save overwrites it', async () => {
      const store = createWeftA2ATaskStore({ storage: openStorage(), namespace: 'agent' });
      await store.save(taskFixture('task-1'), ALICE);
      await store.save(
        taskFixture('task-1', { state: TaskState.TASK_STATE_COMPLETED, contextId: 'context-2' }),
        ALICE,
      );
      const loaded = await store.load('task-1', ALICE);
      expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(loaded?.contextId).toBe('context-2');
      expect(await store.load('task-missing', ALICE)).toBeUndefined();
    });

    it('persists every record with recordVersion 1', async () => {
      const storage = openStorage();
      const store = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      await store.save(taskFixture('task-1'), ALICE);
      const [record] = await storedText(storage);
      expect(JSON.parse(record ?? '{}')).toMatchObject({ recordVersion: 1 });
    });

    it('hides a task from a different user', async () => {
      const store = createWeftA2ATaskStore({ storage: openStorage(), namespace: 'agent' });
      await store.save(taskFixture('task-1'), ALICE);
      const bob = callContext({ user: 'bob' });
      expect(await store.load('task-1', bob)).toBeUndefined();
      expect(await store.list({ ...listAll() }, bob)).toMatchObject({ tasks: [] });
      // The anonymous caller is its own owner, distinct from every named user.
      expect(await store.load('task-1', callContext())).toBeUndefined();
    });

    it('hides a task from a different tenant', async () => {
      const store = createWeftA2ATaskStore({ storage: openStorage(), namespace: 'agent' });
      const acme = callContext({ user: 'alice', tenant: 'acme' });
      await store.save(taskFixture('task-1'), acme);
      const globex = callContext({ user: 'alice', tenant: 'globex' });
      expect(await store.load('task-1', globex)).toBeUndefined();
      expect(await store.list(listAll(), globex)).toMatchObject({ tasks: [] });
      // An absent tenant is the empty tenant, not a wildcard.
      expect(await store.load('task-1', ALICE)).toBeUndefined();
      expect(await store.load('task-1', acme)).toMatchObject({ id: 'task-1' });
    });

    it('hides a task from a different namespace', async () => {
      const storage = openStorage();
      const support = createWeftA2ATaskStore({ storage, namespace: 'support' });
      const billing = createWeftA2ATaskStore({ storage, namespace: 'billing' });
      await support.save(taskFixture('task-1'), ALICE);
      expect(await billing.load('task-1', ALICE)).toBeUndefined();
      expect(await billing.list(listAll(), ALICE)).toMatchObject({ tasks: [] });
    });

    it('keeps a caller-supplied separator from reaching another scope', async () => {
      const storage = openStorage();
      const store = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      await store.save(taskFixture('task-1'), callContext({ user: 'a:b', tenant: 'c' }));
      expect(await store.load('task-1', callContext({ user: 'b', tenant: 'c:user:a' }))).toBe(
        undefined,
      );
      const [key] = await storedKeys(storage);
      expect(key).toBe('a2a:task:agent:c:user%3Aa%3Ab:task-1');
    });

    it('fails a read of a record with an unknown recordVersion', async () => {
      const storage = openStorage();
      const store = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      await store.save(taskFixture('task-1'), ALICE);
      const [key] = await storedKeys(storage);
      await overwriteRecord(storage, key ?? '', { recordVersion: 2, task: {} });
      const failure = await store.load('task-1', ALICE).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(A2AStoreRecordVersionError);
      expect(failure).toMatchObject({ key, recordVersion: 2 });
      expect(await rejectionOf(store.list(listAll(), ALICE))).toBeInstanceOf(
        A2AStoreRecordVersionError,
      );
      // A save never downgrades a record this release cannot read.
      expect(await rejectionOf(store.save(taskFixture('task-1'), ALICE))).toBeInstanceOf(
        A2AStoreRecordVersionError,
      );
      await overwriteRecord(storage, key ?? '', ['not', 'a', 'record']);
      expect(await rejectionOf(store.load('task-1', ALICE))).toMatchObject({
        recordVersion: undefined,
      });
    });

    it('retries a save that loses its compare-and-swap, so two racing saves both land', async () => {
      const base = openStorage();
      let rivalSave: Promise<void> | undefined;
      const { storage, outcomes } = interposedStorage(base, async () => {
        // The first save to reach its batch lets a rival save commit first.
        if (rivalSave === undefined) {
          rivalSave = rival.save(taskFixture('task-1', { contextId: 'rival' }), ALICE);
          await rivalSave;
        }
        return undefined;
      });
      const store = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      const rival = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      await store.save(taskFixture('task-1', { contextId: 'winner' }), ALICE);
      // The rival commits, the first save loses once, retries, and commits.
      expect(outcomes).toEqual([true, false, true]);
      expect(await store.load('task-1', ALICE)).toMatchObject({ contextId: 'winner' });
    });

    it('throws a typed conflict after five retries', async () => {
      const { storage, outcomes } = interposedStorage(openStorage(), () => false);
      const store = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      const failure = await store
        .save(taskFixture('task-1'), ALICE)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(A2AStoreConflictError);
      expect(failure).toMatchObject({ attempts: 6 });
      expect(outcomes).toEqual([false, false, false, false, false, false]);
      // A conflict is a server fault, not the caller's malformed request.
      expect(toJsonRpcError(failure).code).toBe(-32603);
    });

    it('prunes terminal tasks older than the retention period', async () => {
      const storage = openStorage();
      let clock = 1_000_000;
      const store = createWeftA2ATaskStore({
        storage,
        namespace: 'agent',
        terminalRetentionMs: 1_000,
        now: () => clock,
      });
      const other = createWeftA2ATaskStore({ storage, namespace: 'other', now: () => 0 });
      const acme = callContext({ user: 'bob', tenant: 'acme' });
      await store.save(taskFixture('completed', { state: TaskState.TASK_STATE_COMPLETED }), ALICE);
      await store.save(taskFixture('failed', { state: TaskState.TASK_STATE_FAILED }), acme);
      await store.save(taskFixture('canceled', { state: TaskState.TASK_STATE_CANCELED }), ALICE);
      await store.save(taskFixture('rejected', { state: TaskState.TASK_STATE_REJECTED }), ALICE);
      await store.save(taskFixture('working', { state: TaskState.TASK_STATE_WORKING }), ALICE);
      await other.save(taskFixture('elsewhere', { state: TaskState.TASK_STATE_COMPLETED }), ALICE);
      clock += 500;
      await store.save(taskFixture('recent', { state: TaskState.TASK_STATE_COMPLETED }), ALICE);

      // At exactly the retention period a task is not yet older than it.
      clock += 500;
      expect(await store.prune()).toBe(0);
      clock += 1;
      expect(await store.prune()).toBe(4);

      expect(await store.load('completed', ALICE)).toBeUndefined();
      expect(await store.load('failed', acme)).toBeUndefined();
      expect(await store.load('canceled', ALICE)).toBeUndefined();
      expect(await store.load('rejected', ALICE)).toBeUndefined();
      expect(await store.load('working', ALICE)).toMatchObject({ id: 'working' });
      expect(await store.load('recent', ALICE)).toMatchObject({ id: 'recent' });
      // Pruning one namespace leaves another's tasks alone.
      expect(await other.load('elsewhere', ALICE)).toMatchObject({ id: 'elsewhere' });
    });

    // Once a task is gone, no protocol route reaches its push configurations, so a
    // prune that left them would keep their credentials in storage indefinitely.
    it('removes the push configurations of every task it prunes', async () => {
      const storage = openStorage();
      let clock = 0;
      const options = { storage, namespace: 'agent', now: () => clock };
      const store = createWeftA2ATaskStore({ ...options, terminalRetentionMs: 10 });
      const pushStore = createWeftPushNotificationStore(options);
      const otherPushStore = createWeftPushNotificationStore({ ...options, namespace: 'other' });
      const acme = callContext({ user: 'bob', tenant: 'acme' });
      await store.save(taskFixture('done', { state: TaskState.TASK_STATE_COMPLETED }), acme);
      await store.save(taskFixture('working'), acme);
      const secret = pushConfigFixture('done', {
        url: 'https://hooks.example.com/pruned',
        token: 'pruned-token',
        authentication: { scheme: 'Bearer', credentials: 'pruned-credential' },
      });
      const deleted = await pushStore.create('done', acme, pushConfigFixture('done'));
      await pushStore.delete('done', acme, deleted.id);
      await pushStore.create('done', acme, secret);
      await pushStore.create('working', acme, pushConfigFixture('working'));
      await otherPushStore.create('done', acme, pushConfigFixture('done'));

      clock = 100;
      expect(await store.prune()).toBe(1);

      expect(await pushStore.load('done', acme)).toEqual([]);
      expect(await storedKeys(storage, 'a2a:push')).toEqual([
        'a2a:push-head:agent:acme:user%3Abob:working',
        'a2a:push-head:other:acme:user%3Abob:done',
        expect.stringMatching(/^a2a:push:agent:acme:user%3Abob:working:/),
        expect.stringMatching(/^a2a:push:other:acme:user%3Abob:done:/),
      ]);
      for (const text of await storedText(storage)) {
        expect(text).not.toContain('pruned');
      }
      expect(await pushStore.load('working', acme)).toHaveLength(1);
      expect(await otherPushStore.load('done', acme)).toHaveLength(1);
    });

    it('removes a push configuration created while the prune runs', async () => {
      const base = openStorage();
      let clock = 0;
      let created = false;
      const { storage, outcomes } = interposedStorage(base, async (_conditions, operations) => {
        if (!created && operations[0]?.type === 'delete') {
          created = true;
          await pushStore.create('task-1', ALICE, pushConfigFixture('task-1'));
        }
        return undefined;
      });
      const options = { storage, namespace: 'agent', now: () => clock };
      const store = createWeftA2ATaskStore({ ...options, terminalRetentionMs: 10 });
      const pushStore = createWeftPushNotificationStore(options);
      await store.save(taskFixture('task-1', { state: TaskState.TASK_STATE_COMPLETED }), ALICE);
      clock = 100;
      expect(await store.prune()).toBe(1);
      // The create's head bump fails the first delete, and the retry includes it.
      expect(outcomes.slice(-2)).toEqual([false, true]);
      expect(await storedKeys(storage)).toEqual([]);
    });

    it('keeps a terminal task that is saved again while the prune runs', async () => {
      const base = openStorage();
      let clock = 0;
      let resaved = false;
      const { storage } = interposedStorage(base, async (_conditions, operations) => {
        if (!resaved && operations[0]?.type === 'delete') {
          resaved = true;
          await writer.save(
            taskFixture('task-1', { state: TaskState.TASK_STATE_COMPLETED }),
            ALICE,
          );
        }
        return undefined;
      });
      const options = { storage, namespace: 'agent', terminalRetentionMs: 10, now: () => clock };
      const store = createWeftA2ATaskStore(options);
      const writer = createWeftA2ATaskStore(options);
      await store.save(taskFixture('task-1', { state: TaskState.TASK_STATE_COMPLETED }), ALICE);
      clock = 100;
      expect(await store.prune()).toBe(0);
      expect(await store.load('task-1', ALICE)).toMatchObject({ id: 'task-1' });
    });
  });
}

function listAll(): Parameters<ReturnType<typeof createWeftA2ATaskStore>['list']>[0] {
  return {
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
  };
}
