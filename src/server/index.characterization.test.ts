/**
 * Characterization tests for `serve()` — assert externally observable
 * lifecycle behaviour without reaching into implementation internals.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve } from './index.ts';
import { type SignalRegistrar, wireShutdownHandlers } from './serve-internals.ts';

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

// ---------------------------------------------------------------------------
// wireShutdownHandlers — signal-registrar hook
// ---------------------------------------------------------------------------

describe('wireShutdownHandlers()', () => {
  it('registers handlers for both SIGINT and SIGTERM', () => {
    const stack = new AsyncDisposableStack();
    const registered: string[] = [];

    const registrar: SignalRegistrar = (signal) => {
      registered.push(signal);
    };

    wireShutdownHandlers(stack, registrar);

    expect(registered).toContain('SIGINT');
    expect(registered).toContain('SIGTERM');
  });

  it('disposes the stack exactly once even when the signal fires twice', async () => {
    let disposeCount = 0;
    const stack = new AsyncDisposableStack();
    stack.defer(() => {
      disposeCount++;
    });

    const handlers: Array<() => void> = [];
    const registrar: SignalRegistrar = (_signal, handler) => {
      handlers.push(handler);
    };

    wireShutdownHandlers(stack, registrar);

    // Fire the same handler twice (simulates two rapid signals).
    handlers[0]!();
    handlers[0]!();

    // Allow the async dispose microtask to settle.
    await Bun.sleep(10);

    expect(disposeCount).toBe(1);
  });

  it('disposes the stack exactly once when both SIGINT and SIGTERM fire', async () => {
    let disposeCount = 0;
    const stack = new AsyncDisposableStack();
    stack.defer(() => {
      disposeCount++;
    });

    const handlerMap = new Map<string, () => void>();
    const registrar: SignalRegistrar = (signal, handler) => {
      handlerMap.set(signal, handler);
    };

    wireShutdownHandlers(stack, registrar);

    handlerMap.get('SIGINT')?.();
    handlerMap.get('SIGTERM')?.();

    await Bun.sleep(10);

    expect(disposeCount).toBe(1);
  });
});
