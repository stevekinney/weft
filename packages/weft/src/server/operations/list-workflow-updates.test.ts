import { afterEach, describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry, dispatchJsonRpc } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { sleepForTesting } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { Engine } from '../../core/engine.ts';
import { UpdateCoordinator } from '../../core/updates.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import {
  listWorkflowUpdatesOperation,
  listWorkflowUpdatesRestBinding,
} from './list-workflow-updates.ts';

const registry = createOperationRegistry([listWorkflowUpdatesOperation]);
const options = { operationRegistry: registry, restBindings: [listWorkflowUpdatesRestBinding] };

type Page = {
  items: Array<{ updateId: string; name: string; outcome: string; error?: string }>;
  nextCursor?: string;
};

describe('weft.workflows.updates.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  /** Three updates: a pending one, a completed one, and a failed one. */
  async function seed(): Promise<{ storage: MemoryStorage; ids: string[] }> {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    const coordinator = new UpdateCoordinator(storage);
    const ids: string[] = [];
    for (const name of ['pending-one', 'completed-one', 'failed-one']) {
      const request = await coordinator.submitRequest('wf-updates', name, { name });
      ids.push(request.updateId);
      if (name === 'completed-one') {
        await storage.batch(
          coordinator.buildResponseOperations(
            request.updateId,
            'wf-updates',
            'ok',
            undefined,
            undefined,
            { name, receivedAt: request.createdAt },
          ),
        );
      }
      if (name === 'failed-one') {
        await storage.batch(
          coordinator.buildResponseOperations(
            request.updateId,
            'wf-updates',
            undefined,
            'the handler refused',
            undefined,
            { name, receivedAt: request.createdAt },
          ),
        );
      }
      // Entries are ordered by the millisecond they were received.
      await sleepForTesting(2);
    }
    return { storage, ids };
  }

  it('lists the updates newest first with their outcomes and no payload or result', async () => {
    await seed();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-updates/updates'),
      engine!,
      options,
    );

    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    expect(page.items.map((entry) => [entry.name, entry.outcome])).toEqual([
      ['failed-one', 'failed'],
      ['completed-one', 'completed'],
      ['pending-one', 'pending'],
    ]);
    expect(page.items[0]!.error).toBe('the handler refused');
    expect(page.nextCursor).toBeUndefined();
    for (const entry of page.items) {
      expect(Object.keys(entry)).not.toContain('payload');
      expect(Object.keys(entry)).not.toContain('result');
    }
  });

  async function getPage(query: string): Promise<Page> {
    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/wf-updates/updates${query}`),
      engine!,
      options,
    );
    return (await response.json()) as Page;
  }

  it('pages through the history with the cursor it returns', async () => {
    await seed();

    const first = await getPage('?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await getPage(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((entry) => entry.name)).toEqual(['pending-one']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('refuses a malformed cursor and an out-of-range limit as invalid parameters', async () => {
    await seed();

    const badCursor = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-updates/updates?cursor=not-a-cursor'),
      engine!,
      options,
    );
    expect(badCursor.status).toBe(400);

    const badLimit = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-updates/updates?limit=0'),
      engine!,
      options,
    );
    expect(badLimit.status).toBe(400);
  });

  it('says which paths record an update and which do not', () => {
    const description = listWorkflowUpdatesOperation.description ?? '';

    expect(description).toContain('weft.workflows.update');
    expect(description).toContain('engine.submitCoordinatedUpdate()');
    expect(description).toContain('MCP `update_workflow` tool');
    expect(description).toContain('`engine.update()` or `handle.update()`');
  });

  it('lists nothing for a workflow that has no history', async () => {
    await seed();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/never-existed/updates'),
      engine!,
      options,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it('answers over JSON-RPC to a principal holding only workflows:read, and refuses one without it', async () => {
    await seed();
    const call = (scopes: string[]) =>
      dispatchJsonRpc(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.workflows.updates.list',
          params: { workflowId: 'wf-updates', limit: 1 },
          id: 1,
        }),
        {
          principal: principalFromApiKey({ subject: 'svc', scopes }),
          host: engine!,
          transport: 'jsonRpcHttp',
          registry,
        },
      );

    const allowed = await call(['workflows:read']);
    if (allowed.kind !== 'single' || 'error' in allowed.response) {
      throw new Error('expected a JSON-RPC result');
    }
    const page = allowed.response.result as Page;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();

    const denied = await call(['updates:write']);
    if (denied.kind !== 'single' || !('error' in denied.response)) {
      throw new Error('expected a JSON-RPC error');
    }
    expect(denied.response.error.data).toEqual(expect.objectContaining({ weftCode: 'Forbidden' }));
  });
});
