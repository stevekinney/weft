import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

import { createOrderProcessingEngine, orderProcessingSchedule } from '../src/registry';

describe('order-processing server smoke check', () => {
  it('serves health and a caller-supplied shell against SQLite storage', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'weft-order-processing-smoke-'));

    try {
      using storage = new SQLiteStorage(join(temporaryDirectory, 'order-processing.sqlite'));
      await using engine = createOrderProcessingEngine(new Engine({ storage }));
      await engine.schedule(orderProcessingSchedule);

      await using server = serve({
        dashboard: new Response('<html><body>order shell</body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
        engine,
        hostname: '127.0.0.1',
        port: 0,
        publicOrigin: 'http://localhost',
      });

      // Health stays at the origin root (not under /api).
      const healthResponse = await fetch(new URL('/v1/health', server.url));
      expect(healthResponse.ok).toBe(true);

      // The functional API moved under /api.
      const apiHealthResponse = await fetch(new URL('/api/v1/health', server.url));
      expect(apiHealthResponse.ok).toBe(true);

      // A caller-supplied shell can still mount on the origin root.
      const shellResponse = await fetch(new URL('/', server.url));
      expect(shellResponse.ok).toBe(true);
      expect(await shellResponse.text()).toContain('order shell');
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
