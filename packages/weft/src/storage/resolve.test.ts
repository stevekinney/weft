import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HTTPStorage } from './http.ts';
import { MemoryStorage } from './memory.ts';
import { resolveStorage, type HTTPStorageConfiguration } from './resolve.ts';

type WebExtensionTestGlobal = typeof globalThis & {
  browser?: unknown;
  chrome?: unknown;
};

function installWebExtensionStorageNamespace(): () => void {
  const globalObject = globalThis as WebExtensionTestGlobal;
  const previousBrowser = globalObject.browser;
  const previousChrome = globalObject.chrome;
  const data = new Map<string, unknown>();
  const area = {
    get(key?: string | string[] | null) {
      if (typeof key === 'string') {
        return Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {});
      }
      return Promise.resolve(Object.fromEntries(data));
    },
    set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      return Promise.resolve();
    },
  };

  Object.assign(globalObject, {
    browser: { storage: { local: area } },
    chrome: undefined,
  });

  return () => {
    Object.assign(globalObject, { browser: previousBrowser, chrome: previousChrome });
  };
}

describe('resolveStorage', () => {
  let testTempDir: string;
  let previousDefaultStoragePath: string | undefined;

  beforeEach(() => {
    testTempDir = mkdtempSync(join(tmpdir(), 'weft-resolve-test-'));
    previousDefaultStoragePath = process.env['WEFT_DEFAULT_STORAGE_PATH'];
  });

  afterEach(() => {
    if (previousDefaultStoragePath === undefined) {
      delete process.env['WEFT_DEFAULT_STORAGE_PATH'];
    } else {
      process.env['WEFT_DEFAULT_STORAGE_PATH'] = previousDefaultStoragePath;
    }
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it('resolves memory storage', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    expect(storage).toBeInstanceOf(MemoryStorage);
  });

  it('resolves HTTP storage without loading native backends', async () => {
    const storage = await resolveStorage({ type: 'http', baseUrl: 'https://example.test' });
    expect(storage.constructor.name).toBe('HTTPStorage');
  });

  it('resolves SQLite storage under Bun', async () => {
    const storage = await resolveStorage({ type: 'sqlite', path: ':memory:' });
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
    storage[Symbol.dispose]();
  });

  it('resolves automatic storage to SQLite under Bun', async () => {
    const storage = await resolveStorage({ type: 'auto' });
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
    storage[Symbol.dispose]();
  });

  it('resolves automatic server storage to the persistent default SQLite path', async () => {
    const databasePath = join(testTempDir, 'nested', 'weft.db');
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = databasePath;

    const storage = await resolveStorage({ type: 'auto' });
    await storage.put('durable', new Uint8Array([1, 2, 3]));
    storage[Symbol.dispose]?.();

    const reopenedStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
    expect(await reopenedStorage.get('durable')).toEqual(new Uint8Array([1, 2, 3]));
    reopenedStorage[Symbol.dispose]?.();
  });

  it('resolves WebExtension storage from configuration', async () => {
    const restore = installWebExtensionStorageNamespace();
    try {
      const storage = await resolveStorage({ type: 'web-extension', area: 'local' });
      expect(storage.constructor.name).toBe('WebExtensionStorage');
      storage[Symbol.dispose]();
    } finally {
      restore();
    }
  });

  it('resolves IndexedDB storage from configuration', async () => {
    const storage = await resolveStorage({
      type: 'indexeddb',
      databaseName: `weft-resolve-${crypto.randomUUID()}`,
    });
    expect(storage.constructor.name).toBe('IndexedDBStorage');
    storage[Symbol.dispose]();
  });

  it('resolves Neon storage from a url without opening a connection', async () => {
    // The Neon serverless pool is lazy, so resolving and disposing it never
    // contacts the (bogus) endpoint.
    const storage = await resolveStorage({
      type: 'neon',
      url: 'postgresql://user:pass@nonexistent.invalid/db',
    });
    expect(storage.constructor.name).toBe('NeonStorage');
    storage[Symbol.dispose]();
  });

  it('rejects unknown storage configuration variants', async () => {
    await expect(resolveStorage({ type: 'nope' } as never)).rejects.toThrow(
      'Unsupported storage configuration type: nope',
    );
  });

  it('rejects non-object storage configuration values predictably', async () => {
    await expect(resolveStorage(null as never)).rejects.toThrow(
      'Unsupported storage configuration type: unknown',
    );
  });

  it('validates backend-specific runtime configuration before constructing storage', async () => {
    await expect(resolveStorage({ type: 'http' } as never)).rejects.toThrow(
      'HTTP storage configuration requires "baseUrl" as a string or URL.',
    );
    await expect(resolveStorage({ type: 'lmdb' } as never)).rejects.toThrow(
      'LMDB storage configuration requires "path" as a string.',
    );
    await expect(resolveStorage({ type: 'neon' } as never)).rejects.toThrow(
      'Neon storage configuration requires "url" as a string.',
    );
    await expect(
      resolveStorage({ type: 'web-extension', area: 'chrome' } as never),
    ).rejects.toThrow(
      'WebExtension storage configuration field "area" must be one of local, sync, session, or managed.',
    );
    await expect(
      resolveStorage({
        type: 'http',
        baseUrl: 'https://example.test',
        headers: { ok: 1 },
      } as never),
    ).rejects.toThrow('HTTP storage configuration field "headers" must be a string record.');
  });
});

async function assertResolvedStorageTypes(): Promise<void> {
  const httpStorage = await resolveStorage({
    type: 'http',
    baseUrl: 'https://weft.example.com',
  } satisfies HTTPStorageConfiguration);
  const typedHttpStorage: HTTPStorage = httpStorage;
  void typedHttpStorage;
}

void assertResolvedStorageTypes;
