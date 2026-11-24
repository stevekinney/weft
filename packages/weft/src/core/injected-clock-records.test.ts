/**
 * COR-2009 — what Weft stores is stamped on the engine's injected clock (`getNow`), never on the
 * process's `Date.now()`, so a host that runs its engine on another clock (the showcase's offset
 * clock) writes every record at that clock's time.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { restoreWorkflowCatalog } from './catalog/storage-io.ts';
import { WorkflowCatalog } from './catalog/workflow-catalog.ts';
import { buildWorkflowContract } from './contract/build.ts';
import { buildWorkflowRevisionManifest } from './contract/manifest.ts';
import { Engine } from './engine/index.ts';
import { EventLog } from './event-log.ts';
import { workflow } from './types.ts';
import { UpdateCoordinator } from './updates.ts';

/** An instant far from today, so a record stamped with `Date.now()` cannot pass by accident. */
const INJECTED_NOW = Date.parse('2026-10-30T16:00:00.000Z');

describe('records stamped on the injected clock', () => {
  it('stamps an event log entry with the log’s clock', async () => {
    const storage = new MemoryStorage();
    const log = new EventLog(storage, 'clocked-events', () => INJECTED_NOW);
    await log.append({ type: 'noted', payload: null });

    const [entry] = await log.replay(0);
    expect(entry?.timestamp).toBe(INJECTED_NOW);
  });

  it('stamps an update request, its response and the clean-up cutoff with the coordinator’s clock', async () => {
    const storage = new MemoryStorage();
    let now = INJECTED_NOW;
    const coordinator = new UpdateCoordinator(storage, () => now);
    const request = await coordinator.submitRequest('clocked-updates', 'increment', { by: 1 });
    expect(request.createdAt).toBe(INJECTED_NOW);

    now = INJECTED_NOW + 1_000;
    await storage.batch(
      coordinator.buildResponseOperations(
        request.updateId,
        'clocked-updates',
        2,
        undefined,
        undefined,
        {
          name: request.name,
          receivedAt: request.createdAt,
        },
      ),
    );
    const response = await coordinator.getResponse(request.updateId);
    expect(response?.createdAt).toBe(INJECTED_NOW + 1_000);

    // An hour on the injected clock, never on the process's: the response is an hour old.
    now = INJECTED_NOW + 1_000 + 3_600_000;
    expect(await coordinator.cleanupExpiredResponses(3_599_999)).toBe(1);
  });

  it('stamps a catalog entry’s installation and its activation with the catalog’s clock', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage, undefined, () => INJECTED_NOW);
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'clocked-catalog', version: '1.0.0' }),
    );
    await catalog.activateRegistered('clocked-catalog', manifest, {
      type: 'clocked-catalog',
      version: '1.0.0',
      tags: [],
    });

    const restored = await restoreWorkflowCatalog(storage);
    expect(restored.entries.get('clocked-catalog')?.get(manifest.revision)?.installedAt).toBe(
      INJECTED_NOW,
    );
    expect(restored.active.get('clocked-catalog')?.activatedAt).toBe(INJECTED_NOW);
  });

  it('writes a run’s events and checkpoints at the engine’s getNow', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, getNow: () => INJECTED_NOW });
    try {
      engine.register(
        workflow({ name: 'clocked-run' }).execute(async function* (ctx) {
          const value = yield* ctx.run(() => 'done');
          return value;
        }),
      );
      const handle = await engine.start('clocked-run', null, { id: 'clocked-run-1' });
      expect(await handle.result()).toBe('done');

      const events = await engine.getEvents('clocked-run-1');
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event.timestamp).toBe(INJECTED_NOW);

      const checkpoints = await engine.listCheckpoints('clocked-run-1');
      expect(checkpoints.length).toBeGreaterThan(0);
      for (const checkpoint of checkpoints) expect(checkpoint.timestamp).toBe(INJECTED_NOW);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
