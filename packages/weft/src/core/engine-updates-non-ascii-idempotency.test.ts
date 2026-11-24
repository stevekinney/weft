/**
 * End-to-end regression for non-ASCII update idempotency keys.
 *
 * An update's `idempotencyKey` is written into the `upk:` storage key without
 * encoding, and nothing validates it. Under Bun, `ordered-binary@1.6.1` threw
 * `ReferenceError: finishUtf8 is not defined` whenever an LMDB range read
 * decoded a non-ASCII key. After one such key was stored, the engine's
 * update-response sweep (`upk:` scan) failed on every maintenance cycle and the
 * owning workflow's purge (`upk:{workflow}:` key collection) failed too. These
 * tests drive both paths through a real `Engine` over every backend Weft's
 * engine matrix holds; the LMDB range-read case itself is covered by the LMDB
 * adapter's own tests.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { Storage } from "../embedded/storage/src/index.ts";
import { KEYS } from '../storage/keys.ts';
import {
  collectKeys,
  storageBackends,
  storageHas,
  teardown,
  waitForWorkflowStatus,
  type StorageBackendDescriptor,
} from '../testing/storage-backends.test-support.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import { CleanupWarningEvent } from './events.ts';
import { workflow, type WorkflowContext } from './types.ts';

/** Accented Latin, CJK, and an astral emoji in one idempotency key. */
const nonAsciiIdempotencyKey = 'commande-café-日本語-😀';

for (const backend of storageBackends) {
  describeOn(backend);
}

function describeOn(backend: StorageBackendDescriptor): void {
  describe(`non-ASCII update idempotency keys over ${backend.name}`, () => {
    let engine: Engine | undefined;
    let storage: Storage | undefined;
    let cleanupStorage: (() => void | Promise<void>) | undefined;

    function createEngine(): { engine: Engine; storage: Storage } {
      const created = backend.factory();
      cleanupStorage = created.cleanup;
      storage = created.storage;
      engine = new Engine({ storage, backgroundTasks: 'manual' });
      engine.register(
        workflow({ name: 'reviewer' }).execute(async function* (ctx: WorkflowContext) {
          const { payload, respond } = yield* ctx.waitForUpdate<string>('review');
          respond({ accepted: true, payload });
          return 'reviewed';
        }),
      );
      return { engine, storage };
    }

    afterEach(async () => {
      await teardown(engine, cleanupStorage);
      engine = undefined;
      storage = undefined;
      cleanupStorage = undefined;
    });

    async function submitReview(
      activeEngine: Engine,
      activeStorage: Storage,
    ): Promise<{ workflowId: string; updateId: string }> {
      const handle = await activeEngine.start('reviewer', undefined);
      await waitForWorkflowStatus(activeEngine, handle.id, 'running');

      const result = await activeEngine.submitCoordinatedUpdate(handle.id, 'review', 'looks good', {
        idempotencyKey: nonAsciiIdempotencyKey,
      });
      expect(result.result).toEqual({ accepted: true, payload: 'looks good' });
      expect(await handle.result()).toBe('reviewed');

      // The key reaches storage verbatim, which is what put the non-ASCII
      // bytes into the range the sweep and the purge later decode.
      expect(
        await storageHas(activeStorage, KEYS.updateIdempotency(handle.id, nonAsciiIdempotencyKey)),
      ).toBe(true);
      return { workflowId: handle.id, updateId: result.updateId };
    }

    it('the maintenance sweep expires the response and its non-ASCII upk: mapping', async () => {
      const { engine: activeEngine, storage: activeStorage } = createEngine();
      const warnings: CleanupWarningEvent[] = [];
      activeEngine.addEventListener(CleanupWarningEvent.type, (event) => warnings.push(event));
      const { workflowId, updateId } = await submitReview(activeEngine, activeStorage);

      // Age the stored response past the 5-minute TTL so the sweep reaches the
      // `upk:` scan, which only runs once at least one response has expired.
      const responseKey = KEYS.updateResponse(updateId);
      const stored = await activeStorage.get(responseKey);
      expect(stored).not.toBeNull();
      const response = decode(stored!) as { createdAt: number };
      await activeStorage.put(
        responseKey,
        encode({ ...response, createdAt: Date.now() - 60 * 60 * 1000 }),
      );

      await activeEngine.runMaintenance();

      expect(warnings.map((warning) => warning.error.message)).toEqual([]);
      expect(await activeStorage.get(responseKey)).toBeNull();
      expect(
        await storageHas(activeStorage, KEYS.updateIdempotency(workflowId, nonAsciiIdempotencyKey)),
      ).toBe(false);
    });

    it('purging the workflow removes its non-ASCII upk: mapping', async () => {
      const { engine: activeEngine, storage: activeStorage } = createEngine();
      const { workflowId } = await submitReview(activeEngine, activeStorage);

      const purged = await activeEngine.purge({ idPrefix: workflowId });

      expect(purged).toMatchObject({ deleted: 1 });
      expect(await collectKeys(activeStorage, 'upk:')).toEqual([]);
    });
  });
}
