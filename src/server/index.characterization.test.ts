/**
 * Characterization tests for `serve()` — assert externally observable
 * lifecycle behaviour without reaching into implementation internals.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withEngine(fn: (engine: Engine) => Promise<void>): Promise<void> {
  await using storage = new MemoryStorage();
  await using engine = new Engine({ storage });
  await fn(engine);
}

// ---------------------------------------------------------------------------
// serve() handle surface
// ---------------------------------------------------------------------------

describe('serve()', () => {
  it('returns a WeftServer with port, hostname, url, registry, and taskQueue', async () => {
    await withEngine(async (engine) => {
      await using server = serve({ engine, port: 0 });
      expect(typeof server.port).toBe('number');
      expect(typeof server.hostname).toBe('string');
      expect(typeof server.url).toBe('string');
      expect(server.url).toMatch(/^https?:\/\//);
      expect(server.registry).toBeDefined();
      expect(server.taskQueue).toBeDefined();
    });
  });

  it('url reflects the actual bound port', async () => {
    await withEngine(async (engine) => {
      await using server = serve({ engine, port: 0 });
      const urlPort = new URL(server.url).port;
      expect(String(server.port)).toBe(urlPort);
    });
  });

  it('exposes stop() which resolves without throwing', async () => {
    await withEngine(async (engine) => {
      const server = serve({ engine, port: 0 });
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  it('stop() is idempotent — calling it twice does not throw', async () => {
    await withEngine(async (engine) => {
      const server = serve({ engine, port: 0 });
      await server.stop();
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  it('Symbol.asyncDispose() delegates to stop()', async () => {
    await withEngine(async (engine) => {
      const server = serve({ engine, port: 0 });
      // Using await using triggers Symbol.asyncDispose().
      // If it throws the test fails.
      await server[Symbol.asyncDispose]();
    });
  });

  it('two sequential serve() calls each return independent handles', async () => {
    await withEngine(async (engine) => {
      const a = serve({ engine, port: 0 });
      const b = serve({ engine, port: 0 });
      // Both must stop independently.
      await a.stop();
      await expect(b.stop()).resolves.toBeUndefined();
    });
  });
});
