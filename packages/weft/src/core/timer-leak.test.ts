import { afterEach, describe, expect, it } from 'bun:test';
import { waitForever } from '../testing/fake-timers.test-support.ts';

import { flush, storageBackends, teardown } from '../testing/storage-backends.test-support.ts';
import { Engine } from './engine.ts';
import { workflow } from './types/workflow-function.ts';

// ---------------------------------------------------------------------------
// A1: Timer leak in synchronous update Promise.race
//
// When respondPromise resolves before the timeout, clearTimeout must fire
// so the timer does not accumulate. We verify this by sending 100 rapid
// updates with an immediately-responding handler and checking for no
// unhandled rejections.
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Timer leak – rapid updates [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('100 rapid updates with immediate handler cause no unhandled rejections', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const counter = workflow({ name: 'counter' }).execute(async function* (ctx) {
        let count = 0;
        ctx.onUpdate('increment', () => {
          count += 1;
          return count;
        });
        // Keep the workflow alive
        await waitForever();
        return count;
      });
      engine.register(counter);

      const handle = await engine.start('counter', undefined);
      handle.result().catch(() => {});
      await flush();

      // Track unhandled rejections
      const rejections: unknown[] = [];
      const rejectHandler = (_event: PromiseRejectionEvent) => {
        rejections.push(_event.reason);
      };

      // Bun uses addEventListener on globalThis for unhandledrejection
      globalThis.addEventListener('unhandledrejection', rejectHandler as EventListener);

      try {
        // Fire 100 rapid updates
        const updatePromises: Promise<unknown>[] = [];
        for (let i = 0; i < 100; i++) {
          updatePromises.push(engine.update(handle.id, 'increment', undefined));
        }

        const results = await Promise.all(updatePromises);

        // All 100 updates should resolve successfully
        expect(results).toHaveLength(100);
        // Each result should be a number (the count)
        for (const r of results) {
          expect(typeof r).toBe('number');
        }

        // Let any lingering timers fire
        await flush();
        await flush();

        // No unhandled rejections should have accumulated
        expect(rejections).toHaveLength(0);
      } finally {
        globalThis.removeEventListener('unhandledrejection', rejectHandler as EventListener);
      }
    });
  });
}
