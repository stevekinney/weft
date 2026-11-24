import { describe, expect, it } from 'bun:test';

import { RequestMalformedError, toJsonRpcError } from '@a2a-js/sdk/errors';

import { MemoryStorage, type Storage, type StorageCapabilities } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  a2aStoreBackends,
  callContext,
  interposedStorage,
  overwriteRecord,
  pushConfigFixture,
  storedKeys,
  storedText,
  useBackendStorage,
} from './a2a-store.test-support.ts';
import {
  createWeftPushNotificationStore,
  type WeftPushNotificationStore,
} from './push-notification-store.ts';
import { A2APushConfigurationConflictError, A2AStoreRecordVersionError } from './store-errors.ts';

const ALICE = callContext({ user: 'alice' });

/** A memory storage that reports `overrides` in place of its own capabilities. */
function storageReporting(overrides: Partial<StorageCapabilities>): Storage {
  const storage = new MemoryStorage();
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'capabilities') return () => ({ ...target.capabilities(), ...overrides });
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('createWeftPushNotificationStore', () => {
  it('checks a create without writing, and refuses what the create would refuse', async () => {
    const storage = new MemoryStorage();
    const store = createWeftPushNotificationStore({ storage, namespace: 'agent' });
    const config = pushConfigFixture('task-1', { id: 'config-1', url: 'https://hook.example/a' });

    expect(await store.check('task-1', ALICE, config)).toBeUndefined();
    expect(await store.get('task-1', 'config-1', ALICE)).toBeUndefined();

    const created = await store.create('task-1', ALICE, config);
    expect(await store.check('task-1', ALICE, config)).toEqual(created);
    const different = { ...config, url: 'https://hook.example/b' };
    expect(await rejectionOf(store.check('task-1', ALICE, different))).toBeInstanceOf(
      A2APushConfigurationConflictError,
    );

    await store.delete('task-1', ALICE, 'config-1');
    expect(await rejectionOf(store.check('task-1', ALICE, config))).toBeInstanceOf(
      A2APushConfigurationConflictError,
    );
  });

  it('refuses a storage adapter without conditional batches', () => {
    expect(() =>
      createWeftPushNotificationStore({
        storage: storageReporting({ conditionalBatch: false }),
        namespace: 'agent',
      }),
    ).toThrow('requires storage capability "conditionalBatch"');
  });

  // A create's scan decides whether a webhook is new, and its compare-and-swap fences
  // only the head it read, so a lagging read or scan could store a duplicate webhook.
  it.each([
    [{ readAfterWrite: 'session' }, '"session" reads and "snapshot" scans'],
    [{ readAfterWrite: 'eventual' }, '"eventual" reads and "snapshot" scans'],
    [{ scanConsistency: 'best-effort' }, '"linearizable" reads and "best-effort" scans'],
  ] satisfies Array<[Partial<StorageCapabilities>, string]>)(
    'refuses storage reporting %o',
    (overrides, reported) => {
      expect(() =>
        createWeftPushNotificationStore({
          storage: storageReporting(overrides),
          namespace: 'agent',
        }),
      ).toThrow(
        `requires storage with linearizable read-after-write and snapshot scans, but this storage backend reports ${reported}`,
      );
    },
  );
});

for (const backend of a2aStoreBackends) {
  describe(`createWeftPushNotificationStore [${backend.name}]`, () => {
    const openStorage = useBackendStorage(backend);

    function openStore(storage = openStorage()): WeftPushNotificationStore {
      let clock = 0;
      return createWeftPushNotificationStore({ storage, namespace: 'agent', now: () => ++clock });
    }

    async function liveIds(store: WeftPushNotificationStore, context = ALICE, taskId = 'task-1') {
      const configs = await store.load(taskId, context);
      return configs.map((config) => config.id);
    }

    it('creates a configuration, assigning an identifier when the request names none', async () => {
      const store = openStore();
      const created = await store.create('task-1', ALICE, pushConfigFixture('ignored-task-id'));
      expect(created.id).not.toBe('');
      expect(created.taskId).toBe('task-1');
      const named = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { id: 'named', url: 'https://hooks.example.com/b' }),
      );
      expect(named.id).toBe('named');
      expect(await liveIds(store)).toEqual([created.id, 'named']);
    });

    it('assigns the identifier in place when the SDK saves a configuration', async () => {
      const store = openStore();
      const config = pushConfigFixture('task-1');
      await store.save('task-1', ALICE, config);
      expect(config.id).not.toBe('');
      expect(await liveIds(store)).toEqual([config.id]);
      const repeat = pushConfigFixture('task-1');
      await store.save('task-1', ALICE, repeat);
      expect(repeat.id).toBe(config.id);
    });

    it('gets one configuration with its credentials unredacted', async () => {
      const store = openStore();
      const created = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      const loaded = await store.get('task-1', created.id, ALICE);
      expect(loaded).toEqual(created);
      expect(loaded?.authentication?.credentials).toBe('secret-credential');
      expect(await store.get('task-1', 'missing', ALICE)).toBeUndefined();
      expect(await store.get('task-2', created.id, ALICE)).toBeUndefined();
    });

    it('lists the configurations of one task', async () => {
      const store = openStore();
      const first = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      await store.create('task-2', ALICE, pushConfigFixture('task-2'));
      const response = await store.list({ taskId: 'task-1' }, ALICE);
      expect(response.configs).toEqual([first]);
      expect(response.nextPageToken).toBe('');
      const stored = await store.loadWithMetadata('task-1', ALICE);
      expect(stored.map((entry) => entry.config)).toEqual([first]);
    });

    it('records the A2A wire version each configuration was registered over', async () => {
      const store = openStore();
      await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      const legacy = callContext({ user: 'alice', requestedVersion: '0.3' });
      await store.create(
        'task-1',
        legacy,
        pushConfigFixture('task-1', { url: 'https://legacy.example.com' }),
      );
      const stored = await store.loadWithMetadata('task-1', ALICE);
      expect(stored.map((entry) => entry.wireVersion)).toEqual(['1.0', '0.3']);
    });

    it('deletes a configuration, defaulting the identifier to the task identifier', async () => {
      const store = openStore();
      const kept = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { id: 'task-1', url: 'https://hooks.example.com/b' }),
      );
      await store.delete('task-1', ALICE);
      expect(await liveIds(store)).toEqual([kept.id]);
      await store.delete('task-1', ALICE, kept.id);
      expect(await liveIds(store)).toEqual([]);
      // Deleting a missing or already-deleted configuration does nothing.
      await store.delete('task-1', ALICE, kept.id);
      await store.delete('task-1', ALICE, 'never-created');
      expect(await liveIds(store)).toEqual([]);
    });

    it('scopes configurations by user', async () => {
      const store = openStore();
      const created = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      const bob = callContext({ user: 'bob' });
      expect(await store.get('task-1', created.id, bob)).toBeUndefined();
      expect(await liveIds(store, bob)).toEqual([]);
      expect(await store.list({ taskId: 'task-1' }, bob)).toMatchObject({ configs: [] });
      await store.delete('task-1', bob, created.id);
      expect(await liveIds(store)).toEqual([created.id]);
    });

    it('scopes configurations by tenant', async () => {
      const store = openStore();
      const acme = callContext({ user: 'alice', tenant: 'acme' });
      const created = await store.create('task-1', acme, pushConfigFixture('task-1'));
      const globex = callContext({ user: 'alice', tenant: 'globex' });
      expect(await store.get('task-1', created.id, globex)).toBeUndefined();
      expect(await liveIds(store, globex)).toEqual([]);
      expect(await liveIds(store, ALICE)).toEqual([]);
      expect(await liveIds(store, acme)).toEqual([created.id]);
    });

    it('scopes configurations by namespace', async () => {
      const storage = openStorage();
      const support = createWeftPushNotificationStore({ storage, namespace: 'support' });
      const billing = createWeftPushNotificationStore({ storage, namespace: 'billing' });
      const created = await support.create('task-1', ALICE, pushConfigFixture('task-1'));
      expect(await billing.get('task-1', created.id, ALICE)).toBeUndefined();
      expect(await billing.load('task-1', ALICE)).toEqual([]);
    });

    it('returns the existing configuration for a create naming its id with the same webhook', async () => {
      const store = openStore();
      const created = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { id: 'hook' }),
      );
      const repeated = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { id: 'hook' }),
      );
      expect(repeated).toEqual(created);
      expect(await liveIds(store)).toEqual(['hook']);
    });

    it('returns the existing configuration for a create without an id repeating a webhook', async () => {
      const store = openStore();
      const created = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      const repeated = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      expect(repeated).toEqual(created);
      expect(await liveIds(store)).toEqual([created.id]);
      const unauthenticated = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { authentication: undefined }),
      );
      expect(unauthenticated.id).not.toBe(created.id);
      expect(
        await store.create(
          'task-1',
          ALICE,
          pushConfigFixture('task-1', { authentication: undefined }),
        ),
      ).toMatchObject({ id: unauthenticated.id });
    });

    it('creates a second configuration for a different URL', async () => {
      const store = openStore();
      const first = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      const second = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { url: 'https://other.example.com' }),
      );
      expect(second.id).not.toBe(first.id);
      expect(await liveIds(store)).toEqual([first.id, second.id]);
    });

    it('creates a second configuration for a rotated token', async () => {
      const store = openStore();
      const first = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      const second = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { token: 'token-2' }),
      );
      expect(second.id).not.toBe(first.id);
      expect(await liveIds(store)).toEqual([first.id, second.id]);
    });

    it('throws a typed conflict for a create reusing an id with a different URL, token, or authentication', async () => {
      const store = openStore();
      await store.create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook' }));
      for (const change of [
        { url: 'https://other.example.com' },
        { token: 'token-2' },
        { authentication: { scheme: 'Bearer', credentials: 'other-credential' } },
        { authentication: { scheme: 'Basic', credentials: 'secret-credential' } },
        { authentication: undefined },
      ]) {
        const failure = await store
          .create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook', ...change }))
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(A2APushConfigurationConflictError);
        expect(failure).toMatchObject({
          taskId: 'task-1',
          configId: 'hook',
          conflict: 'different',
        });
      }
      expect(await liveIds(store)).toEqual(['hook']);
    });

    it('answers a conflict as JSON-RPC invalid params', async () => {
      const store = openStore();
      await store.create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook' }));
      const failure = await store
        .create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook', token: 'token-2' }))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RequestMalformedError);
      expect(toJsonRpcError(failure).code).toBe(-32602);
    });

    it('never matches a deleted configuration for a create without an id', async () => {
      const store = openStore();
      const created = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      await store.delete('task-1', ALICE, created.id);
      const recreated = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      expect(recreated.id).not.toBe(created.id);
      expect(await liveIds(store)).toEqual([recreated.id]);
    });

    it('throws a typed conflict for a create naming a deleted configuration id', async () => {
      const store = openStore();
      await store.create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook' }));
      await store.delete('task-1', ALICE, 'hook');
      const failure = await store
        .create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook' }))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(A2APushConfigurationConflictError);
      expect(failure).toMatchObject({ configId: 'hook', conflict: 'deleted' });
      expect(await liveIds(store)).toEqual([]);
    });

    it('compares authentication scheme names case-insensitively', async () => {
      const store = openStore();
      const created = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { id: 'hook' }),
      );
      const lower = { scheme: 'bearer', credentials: 'secret-credential' };
      expect(
        await store.create(
          'task-1',
          ALICE,
          pushConfigFixture('task-1', { id: 'hook', authentication: lower }),
        ),
      ).toEqual(created);
      expect(
        await store.create('task-1', ALICE, pushConfigFixture('task-1', { authentication: lower })),
      ).toEqual(created);
      expect(created.authentication?.scheme).toBe('Bearer');
      expect(await liveIds(store)).toEqual(['hook']);
    });

    it('keeps only a secret-free tombstone for a deleted configuration', async () => {
      const storage = openStorage();
      const store = openStore(storage);
      const created = await store.create(
        'task-1',
        ALICE,
        pushConfigFixture('task-1', { id: 'hook' }),
      );
      await store.delete('task-1', ALICE, created.id);
      expect(await store.get('task-1', 'hook', ALICE)).toBeUndefined();
      expect(await store.list({ taskId: 'task-1' }, ALICE)).toMatchObject({ configs: [] });
      const stored = await storedText(storage, 'a2a:push:');
      expect(stored).toHaveLength(1);
      expect(JSON.parse(stored[0] ?? '{}')).toEqual({
        recordVersion: 1,
        state: 'deleted',
        id: 'hook',
        deletionFence: 2,
      });
      for (const text of await storedText(storage)) {
        expect(text).not.toContain('secret-credential');
        expect(text).not.toContain('token-1');
        expect(text).not.toContain('hooks.example.com');
      }
    });

    it('persists every record with recordVersion 1 and fails a read of an unknown one', async () => {
      const storage = openStorage();
      const store = openStore(storage);
      await store.create('task-1', ALICE, pushConfigFixture('task-1', { id: 'hook' }));
      for (const text of await storedText(storage)) {
        expect(JSON.parse(text)).toMatchObject({ recordVersion: 1 });
      }
      const [headKey, configKey] = await storedKeys(storage);
      expect(headKey).toBe('a2a:push-head:agent::user%3Aalice:task-1');
      expect(configKey).toBe('a2a:push:agent::user%3Aalice:task-1:hook');
      await overwriteRecord(storage, configKey ?? '', { recordVersion: 7 });
      expect(await rejectionOf(store.get('task-1', 'hook', ALICE))).toBeInstanceOf(
        A2AStoreRecordVersionError,
      );
      expect(await rejectionOf(store.load('task-1', ALICE))).toBeInstanceOf(
        A2AStoreRecordVersionError,
      );
      await overwriteRecord(storage, headKey ?? '', { sequence: 1 });
      expect(
        await rejectionOf(store.create('task-1', ALICE, pushConfigFixture('task-1'))),
      ).toMatchObject({ key: headKey, recordVersion: undefined });
    });

    it('stores one configuration when two creates of the same webhook race', async () => {
      const base = openStorage();
      let rivalCreate: Promise<unknown> | undefined;
      const { storage, outcomes } = interposedStorage(base, async () => {
        if (rivalCreate === undefined) {
          rivalCreate = rival.create('task-1', ALICE, pushConfigFixture('task-1'));
          await rivalCreate;
        }
        return undefined;
      });
      const store = openStore(storage);
      const rival = openStore(storage);
      const created = await store.create('task-1', ALICE, pushConfigFixture('task-1'));
      // The rival commits; the first create loses, retries, and finds the rival's.
      expect(outcomes).toEqual([true, false]);
      expect(created).toEqual((await rivalCreate) as typeof created);
      expect(await liveIds(store)).toEqual([created.id]);
    });
  });
}
