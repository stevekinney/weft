import { describe, expect, it } from 'bun:test';

import { toJsonRpcError } from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  a2aStoreBackends,
  callContext,
  pushConfigFixture,
  useBackendStorage,
} from './a2a-store.test-support.ts';
import {
  createWeftPushNotificationStore,
  type WeftPushNotificationStore,
} from './push-notification-store.ts';
import { A2AStorePageSizeError, A2AStorePageTokenError } from './store-errors.ts';

const ALICE = callContext({ user: 'alice' });

for (const backend of a2aStoreBackends) {
  describe(`WeftPushNotificationStore.list [${backend.name}]`, () => {
    const openStorage = useBackendStorage(backend);
    let clock = 0;

    function openStore(): WeftPushNotificationStore {
      clock = 0;
      return createWeftPushNotificationStore({
        storage: openStorage(),
        namespace: 'agent',
        now: () => clock,
      });
    }

    async function createHooks(
      store: WeftPushNotificationStore,
      ids: readonly string[],
      taskId = 'task-1',
    ): Promise<void> {
      for (const id of ids) {
        await store.create(
          taskId,
          ALICE,
          pushConfigFixture(taskId, { id, url: `https://hooks.example.com/${id}` }),
        );
      }
    }

    it('orders a task’s configurations by creation time, then identifier', async () => {
      const store = openStore();
      clock = 20;
      await createHooks(store, ['late']);
      clock = 10;
      await createHooks(store, ['tie-b', 'tie-a']);
      const response = await store.list({ taskId: 'task-1' }, ALICE);
      expect(response.configs.map((config) => config.id)).toEqual(['tie-a', 'tie-b', 'late']);
    });

    it('defaults pageSize to 50, including the protobuf default of 0', async () => {
      const store = openStore();
      await createHooks(
        store,
        Array.from({ length: 51 }, (_, index) => `hook-${String(index).padStart(2, '0')}`),
      );
      for (const pageSize of [undefined, 0]) {
        const response = await store.list({ taskId: 'task-1', pageSize }, ALICE);
        expect(response.configs).toHaveLength(50);
        expect(response.nextPageToken).not.toBe('');
      }
    });

    it('honors a pageSize from 1 to 100 and rejects any other', async () => {
      const store = openStore();
      await createHooks(store, ['a', 'b']);
      const one = await store.list({ taskId: 'task-1', pageSize: 1 }, ALICE);
      expect(one.configs).toHaveLength(1);
      const all = await store.list({ taskId: 'task-1', pageSize: 100 }, ALICE);
      expect(all.configs).toHaveLength(2);
      for (const pageSize of [101, -1, 2.5]) {
        const failure = await store
          .list({ taskId: 'task-1', pageSize }, ALICE)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(A2AStorePageSizeError);
        expect(toJsonRpcError(failure).code).toBe(-32602);
      }
    });

    it('pages with an opaque token bound to the caller and the task', async () => {
      const store = openStore();
      await createHooks(store, ['a', 'b', 'c']);
      await createHooks(store, ['x', 'y'], 'task-2');
      const first = await store.list({ taskId: 'task-1', pageSize: 2 }, ALICE);
      expect(first.configs.map((config) => config.id)).toEqual(['a', 'b']);
      const { nextPageToken: pageToken } = first;
      const second = await store.list({ taskId: 'task-1', pageSize: 2, pageToken }, ALICE);
      expect(second.configs.map((config) => config.id)).toEqual(['c']);
      expect(
        await rejectionOf(
          store.list({ taskId: 'task-1', pageToken }, callContext({ user: 'bob' })),
        ),
      ).toBeInstanceOf(A2AStorePageTokenError);
      expect(
        await rejectionOf(
          store.list(
            { taskId: 'task-1', pageToken },
            callContext({ user: 'alice', tenant: 'acme' }),
          ),
        ),
      ).toBeInstanceOf(A2AStorePageTokenError);
      expect(await rejectionOf(store.list({ taskId: 'task-2', pageToken }, ALICE))).toBeInstanceOf(
        A2AStorePageTokenError,
      );
      expect(
        await rejectionOf(store.list({ taskId: 'task-1', pageToken: 'not-a-token' }, ALICE)),
      ).toBeInstanceOf(A2AStorePageTokenError);
    });

    it('returns an empty nextPageToken on the last page', async () => {
      const store = openStore();
      await createHooks(store, ['a', 'b']);
      const first = await store.list({ taskId: 'task-1', pageSize: 1 }, ALICE);
      expect(first.nextPageToken).not.toBe('');
      const last = await store.list(
        { taskId: 'task-1', pageSize: 1, pageToken: first.nextPageToken },
        ALICE,
      );
      expect(last.configs.map((config) => config.id)).toEqual(['b']);
      expect(last.nextPageToken).toBe('');
      expect(await store.list({ taskId: 'task-1', pageSize: 2 }, ALICE)).toMatchObject({
        nextPageToken: '',
      });
      expect(await store.list({ taskId: 'empty' }, ALICE)).toMatchObject({ nextPageToken: '' });
    });
  });
}
