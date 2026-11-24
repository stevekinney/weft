import { describe, expect, it } from 'bun:test';

import { type ListTasksRequest, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError, toJsonRpcError } from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  a2aStoreBackends,
  artifactFixture,
  callContext,
  messageFixture,
  taskFixture,
  useBackendStorage,
} from './a2a-store.test-support.ts';
import { A2AStorePageSizeError, A2AStorePageTokenError } from './store-errors.ts';
import { createWeftA2ATaskStore, type WeftA2ATaskStore } from './task-store.ts';

const ALICE = callContext({ user: 'alice' });

function listRequest(overrides: Partial<ListTasksRequest> = {}): ListTasksRequest {
  return {
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
    ...overrides,
  };
}

function minute(value: number): string {
  return `2026-10-17T12:${String(value).padStart(2, '0')}:00.000Z`;
}

async function listIds(
  store: WeftA2ATaskStore,
  overrides: Partial<ListTasksRequest> = {},
): Promise<string[]> {
  const { tasks } = await store.list(listRequest(overrides), ALICE);
  return tasks.map((task) => task.id);
}

for (const backend of a2aStoreBackends) {
  describe(`WeftA2ATaskStore.list [${backend.name}]`, () => {
    const openStorage = useBackendStorage(backend);

    function openStore(): WeftA2ATaskStore {
      return createWeftA2ATaskStore({ storage: openStorage(), namespace: 'agent' });
    }

    it('filters by contextId', async () => {
      const store = openStore();
      await store.save(taskFixture('a', { contextId: 'one' }), ALICE);
      await store.save(taskFixture('b', { contextId: 'two' }), ALICE);
      expect(await listIds(store, { contextId: 'two' })).toEqual(['b']);
    });

    it('filters by status', async () => {
      const store = openStore();
      await store.save(taskFixture('a', { state: TaskState.TASK_STATE_WORKING }), ALICE);
      await store.save(taskFixture('b', { state: TaskState.TASK_STATE_COMPLETED }), ALICE);
      expect(await listIds(store, { status: TaskState.TASK_STATE_COMPLETED })).toEqual(['b']);
    });

    it('filters by statusTimestampAfter, inclusive of the boundary', async () => {
      const store = openStore();
      await store.save(taskFixture('early', { timestamp: minute(1) }), ALICE);
      await store.save(taskFixture('boundary', { timestamp: minute(2) }), ALICE);
      await store.save(taskFixture('late', { timestamp: '2026-10-17T13:03:00+01:00' }), ALICE);
      await store.save(taskFixture('unstamped', { timestamp: '' }), ALICE);
      expect(await listIds(store, { statusTimestampAfter: minute(2) })).toEqual([
        'late',
        'boundary',
      ]);
    });

    it('applies historyLength', async () => {
      const store = openStore();
      const history = ['m1', 'm2', 'm3'].map(messageFixture);
      await store.save(taskFixture('a', { history }), ALICE);
      const historyOf = async (historyLength: number | undefined) => {
        const { tasks } = await store.list(listRequest({ historyLength }), ALICE);
        return tasks[0]?.history.map((message) => message.messageId);
      };
      expect(await historyOf(2)).toEqual(['m2', 'm3']);
      expect(await historyOf(0)).toEqual([]);
      expect(await historyOf(undefined)).toEqual(['m1', 'm2', 'm3']);
    });

    it('applies includeArtifacts, leaving artifacts out by default', async () => {
      const store = openStore();
      await store.save(taskFixture('a', { artifacts: [artifactFixture('report')] }), ALICE);
      const artifactsOf = async (includeArtifacts: boolean | undefined) => {
        const { tasks } = await store.list(listRequest({ includeArtifacts }), ALICE);
        return tasks[0]?.artifacts.map((artifact) => artifact.artifactId);
      };
      expect(await artifactsOf(undefined)).toEqual([]);
      expect(await artifactsOf(false)).toEqual([]);
      expect(await artifactsOf(true)).toEqual(['report']);
    });

    it('sorts by status timestamp descending, then task identifier', async () => {
      const store = openStore();
      await store.save(taskFixture('unstamped', { timestamp: '' }), ALICE);
      await store.save(taskFixture('b', { timestamp: minute(5) }), ALICE);
      await store.save(taskFixture('oldest', { timestamp: minute(1) }), ALICE);
      await store.save(taskFixture('a', { timestamp: minute(5) }), ALICE);
      await store.save(taskFixture('newest', { timestamp: minute(9) }), ALICE);
      expect(await listIds(store)).toEqual(['newest', 'a', 'b', 'oldest', 'unstamped']);
    });

    it('defaults pageSize to 50', async () => {
      const store = openStore();
      for (let index = 0; index < 51; index += 1) {
        await store.save(taskFixture(`task-${String(index).padStart(2, '0')}`), ALICE);
      }
      const response = await store.list(listRequest(), ALICE);
      expect(response.pageSize).toBe(50);
      expect(response.tasks).toHaveLength(50);
      expect(response.nextPageToken).not.toBe('');
    });

    it('rejects a pageSize outside 1 to 100', async () => {
      const store = openStore();
      for (const pageSize of [0, 101, -1, 1.5]) {
        const failure = await store
          .list(listRequest({ pageSize }), ALICE)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(A2AStorePageSizeError);
        expect(failure).toBeInstanceOf(RequestMalformedError);
        expect(failure).toMatchObject({ pageSize });
        expect(toJsonRpcError(failure).code).toBe(-32602);
      }
      expect(await store.list(listRequest({ pageSize: 100 }), ALICE)).toMatchObject({
        pageSize: 100,
      });
      expect(await store.list(listRequest({ pageSize: 1 }), ALICE)).toMatchObject({ pageSize: 1 });
    });

    it('returns an opaque nextPageToken carrying the status timestamp and task identifier', async () => {
      const store = openStore();
      await store.save(taskFixture('a', { timestamp: minute(2) }), ALICE);
      await store.save(taskFixture('b', { timestamp: minute(1) }), ALICE);
      const first = await store.list(listRequest({ pageSize: 1 }), ALICE);
      expect(first.tasks.map((task) => task.id)).toEqual(['a']);
      expect(first.nextPageToken).toMatch(/^[\w-]+$/);
      const decoded: unknown = JSON.parse(
        atob(first.nextPageToken.replaceAll('-', '+').replaceAll('_', '/')),
      );
      expect(decoded).toMatchObject({ s: Date.parse(minute(2)), i: 'a' });
      const second = await store.list(
        listRequest({ pageSize: 1, pageToken: first.nextPageToken }),
        ALICE,
      );
      expect(second.tasks.map((task) => task.id)).toEqual(['b']);
    });

    it('returns an empty nextPageToken on the last page', async () => {
      const store = openStore();
      await store.save(taskFixture('a'), ALICE);
      await store.save(taskFixture('b'), ALICE);
      expect(await store.list(listRequest({ pageSize: 2 }), ALICE)).toMatchObject({
        nextPageToken: '',
      });
      expect(await store.list(listRequest({ pageSize: 3 }), ALICE)).toMatchObject({
        nextPageToken: '',
      });
      expect(await store.list(listRequest(), ALICE)).toMatchObject({ nextPageToken: '' });
    });

    it('reports totalSize before pagination, after filtering', async () => {
      const store = openStore();
      for (const id of ['a', 'b', 'c'])
        await store.save(taskFixture(id, { contextId: 'one' }), ALICE);
      await store.save(taskFixture('d', { contextId: 'two' }), ALICE);
      const response = await store.list(listRequest({ pageSize: 1, contextId: 'one' }), ALICE);
      expect(response.tasks).toHaveLength(1);
      expect(response.totalSize).toBe(3);
    });

    it('returns two tasks sharing a status timestamp across a page boundary exactly once, in identifier order', async () => {
      const store = openStore();
      await store.save(taskFixture('newer', { timestamp: minute(9) }), ALICE);
      await store.save(taskFixture('tie-b', { timestamp: minute(5) }), ALICE);
      await store.save(taskFixture('tie-a', { timestamp: minute(5) }), ALICE);
      const seen: string[] = [];
      let pageToken = '';
      do {
        const response = await store.list(listRequest({ pageSize: 2, pageToken }), ALICE);
        seen.push(...response.tasks.map((task) => task.id));
        ({ nextPageToken: pageToken } = response);
      } while (pageToken !== '');
      expect(seen).toEqual(['newer', 'tie-a', 'tie-b']);
    });

    it('rejects a page token minted for another user, tenant, or filter set', async () => {
      const store = openStore();
      await store.save(taskFixture('a', { contextId: 'one' }), ALICE);
      await store.save(taskFixture('b', { contextId: 'one' }), ALICE);
      const { nextPageToken } = await store.list(
        listRequest({ pageSize: 1, contextId: 'one' }),
        ALICE,
      );
      const reuse = (request: Partial<ListTasksRequest>, context = ALICE) =>
        store.list(listRequest({ pageSize: 1, pageToken: nextPageToken, ...request }), context);
      expect(
        await rejectionOf(reuse({ contextId: 'one' }, callContext({ user: 'bob' }))),
      ).toBeInstanceOf(A2AStorePageTokenError);
      expect(
        await rejectionOf(
          reuse({ contextId: 'one' }, callContext({ user: 'alice', tenant: 'acme' })),
        ),
      ).toBeInstanceOf(A2AStorePageTokenError);
      expect(await rejectionOf(reuse({ contextId: 'two' }))).toBeInstanceOf(A2AStorePageTokenError);
      expect(
        await rejectionOf(reuse({ contextId: 'one', status: TaskState.TASK_STATE_WORKING })),
      ).toBeInstanceOf(A2AStorePageTokenError);
      expect(
        await rejectionOf(reuse({ contextId: 'one', statusTimestampAfter: minute(0) })),
      ).toBeInstanceOf(A2AStorePageTokenError);
      const { tasks } = await reuse({ contextId: 'one' });
      expect(tasks.map((task) => task.id)).toEqual(['b']);
    });

    it('rejects a malformed page token as invalid params', async () => {
      const store = openStore();
      for (const pageToken of ['%%%', 'bm90IGpzb24', btoa('{"b":"x","i":1}')]) {
        const failure = await store
          .list(listRequest({ pageToken }), ALICE)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(A2AStorePageTokenError);
        expect(toJsonRpcError(failure).code).toBe(-32602);
      }
    });
  });
}
