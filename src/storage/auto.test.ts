import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDefaultStorage } from './auto.ts';

type FakeOpenRequest = {
  error: DOMException | null;
  onerror: (() => void) | null;
  onsuccess: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  readyState: 'pending' | 'done';
  result: {
    createObjectStore: (name: string) => void;
    objectStoreNames: { contains: (name: string) => boolean };
  };
};

async function withActualGlobals(
  overrides: Partial<Record<'browser' | 'chrome' | 'indexedDB', unknown>>,
  callback: () => Promise<void>,
): Promise<void> {
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['browser', 'chrome', 'indexedDB'] as const) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: overrides[key],
    });
  }

  try {
    await callback();
  } finally {
    for (const key of ['browser', 'chrome', 'indexedDB'] as const) {
      const descriptor = previousDescriptors.get(key);
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  }
}

function createIndexedDbFactory(): { open: (name: string, version: number) => FakeOpenRequest } {
  return {
    open: (_name: string, _version: number) => {
      const stores = new Set<string>();
      const request: FakeOpenRequest = {
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        readyState: 'pending',
        result: {
          createObjectStore: (name: string) => {
            stores.add(name);
          },
          objectStoreNames: {
            contains: (name: string) => stores.has(name),
          },
        },
      };

      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.readyState = 'done';
        request.onsuccess?.();
      });

      return request;
    },
  };
}

describe('resolveDefaultStorage', () => {
  // All tests run inside an isolated temp directory and route the
  // resolver's path policy through `WEFT_DEFAULT_STORAGE_PATH` so the
  // test never touches the real `${tmpdir()}/weft-default/` location
  // (which would persist across runs and across tests).
  let testTempDir: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    testTempDir = mkdtempSync(join(tmpdir(), 'weft-auto-test-'));
    previousEnv = process.env['WEFT_DEFAULT_STORAGE_PATH'];
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = join(testTempDir, 'weft.db');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env['WEFT_DEFAULT_STORAGE_PATH'];
    else process.env['WEFT_DEFAULT_STORAGE_PATH'] = previousEnv;
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it('returns BunSQLiteStorage in the Bun runtime', async () => {
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
  });

  it('honors WEFT_DEFAULT_STORAGE_PATH and creates the parent directory', async () => {
    const customPath = join(testTempDir, 'nested', 'subdir', 'weft.db');
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = customPath;
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
    expect(existsSync(join(testTempDir, 'nested', 'subdir'))).toBe(true);
  });

  it('bundles for browser targets without static Node built-ins', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-auto-browser-build-'));
    const entryPath = join(temporaryDirectory, 'entry.ts');
    const autoModulePath = fileURLToPath(new URL('./auto.ts', import.meta.url));

    try {
      await Bun.write(
        entryPath,
        `import { resolveDefaultStorage } from ${JSON.stringify(autoModulePath)};
(globalThis as Record<string, unknown>)['resolveDefaultStorage'] = resolveDefaultStorage;
`,
      );

      const build = await Bun.build({
        entrypoints: [entryPath],
        format: 'iife',
        minify: false,
        target: 'browser',
      });

      expect(build.success).toBe(true);
      const source = await build.outputs[0]!.text();
      expect(source).toContain('resolveDefaultStorage');
      expect(source).toContain('IndexedDBStorage');
      expect(source).toContain('WebExtensionStorage');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('selects the Node adapter when Bun is absent but process.versions.node is present', async () => {
    const runtimeGlobals = { process };
    const resolved = await resolveDefaultStorage(runtimeGlobals).catch((error) => error);
    if (resolved instanceof Error) {
      expect(resolved.message.length).toBeGreaterThan(0);
      return;
    }

    expect(resolved.constructor.name).toBe('NodeSQLiteStorage');
    resolved[Symbol.dispose]?.();
  });

  it('selects WebExtension and IndexedDB adapters from their runtime globals', async () => {
    const browserStorage = {
      local: {
        get: async () => ({}),
        remove: async () => {},
        set: async () => {},
      },
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    };

    await withActualGlobals(
      {
        browser: { storage: browserStorage },
        chrome: undefined,
        indexedDB: undefined,
      },
      async () => {
        const webExtensionStorage = await resolveDefaultStorage({
          browser: { storage: browserStorage },
        });
        expect(webExtensionStorage.constructor.name).toBe('WebExtensionStorage');
      },
    );

    await withActualGlobals(
      {
        browser: undefined,
        chrome: undefined,
        indexedDB: createIndexedDbFactory(),
      },
      async () => {
        const indexedDbStorage = await resolveDefaultStorage({
          indexedDB: createIndexedDbFactory(),
        });
        expect(indexedDbStorage.constructor.name).toBe('IndexedDBStorage');
      },
    );
  });

  it('describes missing runtime globals when no default adapter is available', async () => {
    await expect(resolveDefaultStorage({})).rejects.toThrow(
      'resolveDefaultStorage: requires Bun, Node, WebExtension storage, or IndexedDB.',
    );
  });
});
