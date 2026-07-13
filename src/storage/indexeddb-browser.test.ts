/**
 * Real-browser IndexedDB adapter durability test.
 *
 * Validates IndexedDBStorage against a real Chromium engine (not fake-indexeddb).
 * The existing indexeddb.test.ts suite exercises the adapter against the
 * fake-indexeddb polyfill. This file validates the real-browser behaviors that matter
 * for a durability adapter:
 *
 *  1. capabilities() matches the declared contract in a real browser.
 *  2. put/get/keys/count/deletePrefix round-trip real bytes (Uint8Array) through
 *     the structured-clone boundary unchanged.
 *  3. Durability across reload: records written on first page load survive a
 *     page.reload() and are readable by a fresh adapter against the same IDB
 *     database — the IDB analog of "fresh adapter against the same on-disk file."
 *  4. Range/prefix scan ordering matches the adapter contract in a real IDB.
 *  5. batch() atomicity: an all-or-nothing batch leaves no partial writes.
 *
 * ## Running
 *
 * Gate: WEFT_BROWSER_SMOKE=1 must be set (the shared flag for all real-browser
 * smokes). Otherwise all tests skip. This test does NOT run in the default
 * `bun test` pass.
 *
 * Browser provisioning: `bunx playwright install chromium` (run once; the CI
 * ticket wires this into the workflow). No CHROMIUM_PATH discovery needed —
 * Playwright manages its own pinned binary.
 *
 * ## Architecture
 *
 * A Bun.serve() local HTTP origin serves a minimal test page. The adapter source
 * (already in src/storage/indexeddb.ts) is bundled into the page via Bun.build()
 * and served as a static script. The test drives the browser with Playwright
 * library mode (not @playwright/test) so bun:test remains the sole test runner.
 * Results are collected from page.evaluate() return values or exposeFunction
 * callbacks — no hand-rolled HTTP report-back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

import type { StorageCapabilities } from './capabilities.ts';

const shouldRun = Bun.env['WEFT_BROWSER_SMOKE'] === '1';

/**
 * Build the IndexedDB adapter as a browser-compatible IIFE and return its
 * source so it can be served as a static asset over HTTP.
 *
 * Bun.build() cannot use data: URL entrypoints, so we write a temporary build entry
 * into a temp directory, build from there, then clean up.
 */
async function buildAdapterScript(): Promise<string> {
  const adapterPath = fileURLToPath(new URL('./indexeddb.ts', import.meta.url));
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-idb-build-'));
  const entryPath = join(temporaryDirectory, 'entry.ts');

  // Build entry that imports IndexedDBStorage and exposes it on globalThis so
  // in-page evaluate calls can access it as window.IndexedDBStorage.
  await Bun.write(
    entryPath,
    `import { IndexedDBStorage } from ${JSON.stringify(adapterPath)};
(globalThis as unknown as Record<string, unknown>)['IndexedDBStorage'] = IndexedDBStorage;
`,
  );

  try {
    const build = await Bun.build({
      entrypoints: [entryPath],
      format: 'iife',
      minify: false,
      target: 'browser',
    });

    if (!build.success) {
      const messages = build.logs.map((log) => log.message).join('\n');
      throw new Error(`Failed to build IndexedDBStorage for browser: ${messages}`);
    }

    const output = build.outputs[0];
    if (!output) {
      throw new Error('Bun.build produced no output');
    }
    return output.text();
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

/** Minimal HTML page that loads the adapter script at a given URL. */
function buildTestPageHtml(adapterScriptUrl: string): string {
  return `<!doctype html>
<html>
<head><title>IndexedDB Smoke</title></head>
<body>
<script src="${adapterScriptUrl}"></script>
</body>
</html>`;
}

/** Persistent test state shared across describe blocks. */
let browser: Browser;
let context: BrowserContext;
let server: ReturnType<typeof Bun.serve>;
let adapterScriptSource: string;
let baseUrl: string;

(shouldRun ? describe : describe.skip)('IndexedDBStorage — real Chromium durability', () => {
  beforeAll(async () => {
    adapterScriptSource = await buildAdapterScript();

    // Serve the test page and adapter script from a real http: origin so IndexedDB
    // has a normal same-origin storage partition (data: URLs do not get persistent IDB).
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/adapter.js') {
          return new Response(adapterScriptSource, {
            headers: { 'Content-Type': 'application/javascript' },
          });
        }
        if (url.pathname === '/') {
          return new Response(buildTestPageHtml('/adapter.js'), {
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response(null, { status: 404 });
      },
    });

    baseUrl = `http://127.0.0.1:${server.port}`;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.stop(true);
  });

  /** Navigate a fresh page to the test origin and wait for the adapter script to load. */
  async function openPage(): Promise<Page> {
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    // Wait until IndexedDBStorage is available on globalThis
    await page.waitForFunction(
      () => typeof (globalThis as Record<string, unknown>)['IndexedDBStorage'] === 'function',
    );
    return page;
  }

  /** Unique database name per test to prevent cross-test contamination. */
  function uniqueDatabase(): string {
    return `weft-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // ─── 1. capabilities() ───────────────────────────────────────────────────

  it('capabilities() in a real browser matches the declared contract', async () => {
    const page = await openPage();
    try {
      const result = (await page.evaluate((databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          capabilities(): {
            persistence: string;
            readAfterWrite: string;
            scanConsistency: string;
            atomicBatch: boolean;
            conditionalBatch: boolean;
            boundedRangeDelete: boolean;
          };
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);
        const caps = storage.capabilities();
        storage[Symbol.dispose]();
        return caps;
      }, uniqueDatabase())) as StorageCapabilities;

      expect(result.persistence).toBe('local');
      expect(result.readAfterWrite).toBe('linearizable');
      expect(result.scanConsistency).toBe('best-effort');
      expect(result.atomicBatch).toBe(true);
      expect(result.conditionalBatch).toBe(true);
      expect(result.boundedRangeDelete).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  // ─── 2. put/get/keys/count/deletePrefix round-trip ──────────────────────

  it('put/get/keys/count/deletePrefix round-trip real bytes through the structured-clone boundary', async () => {
    const page = await openPage();
    const dbName = uniqueDatabase();
    try {
      const result = await page.evaluate(async (databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          put(key: string, value: Uint8Array): Promise<void>;
          get(key: string): Promise<Uint8Array | null>;
          keys(prefix: string): AsyncIterable<string>;
          count(prefix: string): Promise<number>;
          deletePrefix(prefix: string): Promise<number>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);

        // The structured-clone boundary must preserve all byte values including 0 and 255
        const testValue = new Uint8Array([0, 1, 127, 128, 254, 255]);
        await storage.put('prefix:key', testValue);

        const got = await storage.get('prefix:key');
        const gotValue = got ? Array.from(got) : null;

        const keys: string[] = [];
        for await (const k of storage.keys('prefix:')) keys.push(k);

        const countBefore = await storage.count('prefix:');
        await storage.deletePrefix('prefix:');
        const afterDeleteRaw = await storage.get('prefix:key');
        const afterDelete = afterDeleteRaw ? Array.from(afterDeleteRaw) : null;
        const countAfter = await storage.count('prefix:');

        storage[Symbol.dispose]();
        return { gotValue, keys, countBefore, afterDelete, countAfter } as {
          gotValue: number[] | null;
          keys: string[];
          countBefore: number;
          afterDelete: null | number[];
          countAfter: number;
        };
      }, dbName);

      expect(result.gotValue).toEqual([0, 1, 127, 128, 254, 255]);
      expect(result.keys).toEqual(['prefix:key']);
      expect(result.countBefore).toBe(1);
      expect(result.afterDelete).toBeNull();
      expect(result.countAfter).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  // ─── 3. Durability across reload ─────────────────────────────────────────

  it('records written on first page load survive page.reload() and are readable by a fresh adapter', async () => {
    const page = await openPage();
    const dbName = uniqueDatabase();
    try {
      // Write on the first load
      await page.evaluate(async (databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          put(key: string, value: Uint8Array): Promise<void>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);
        await storage.put('durable:key', new Uint8Array([42, 43, 44]));
        // Dispose closes the IDBDatabase connection cleanly before reload
        storage[Symbol.dispose]();
      }, dbName);

      // Reload — this is the IDB analog of "fresh adapter against the same on-disk file"
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => typeof (globalThis as Record<string, unknown>)['IndexedDBStorage'] === 'function',
      );

      // Read with a fresh adapter instance on the same database name / origin
      const result = await page.evaluate(async (databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          get(key: string): Promise<Uint8Array | null>;
          count(prefix: string): Promise<number>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);
        const raw = await storage.get('durable:key');
        const value = raw ? Array.from(raw) : null;
        const count = await storage.count('durable:');
        storage[Symbol.dispose]();
        return { value, count } as { value: number[] | null; count: number };
      }, dbName);

      expect(result.value).toEqual([42, 43, 44]);
      expect(result.count).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  // ─── 4. Prefix scan ordering ─────────────────────────────────────────────

  it('scan() yields keys in ascending lexicographic order in a real IDB', async () => {
    const page = await openPage();
    const dbName = uniqueDatabase();
    try {
      const result = await page.evaluate(async (databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          put(key: string, value: Uint8Array): Promise<void>;
          scan(prefix: string): AsyncIterable<[string, Uint8Array]>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);

        // Insert in reverse order to verify IDB returns keys in ascending order
        await storage.put('order:c', new Uint8Array([3]));
        await storage.put('order:a', new Uint8Array([1]));
        await storage.put('order:b', new Uint8Array([2]));

        const entries: Array<{ key: string; value: number[] }> = [];
        for await (const [key, value] of storage.scan('order:')) {
          entries.push({ key, value: Array.from(value) });
        }
        storage[Symbol.dispose]();
        return entries;
      }, dbName);

      expect(result).toEqual([
        { key: 'order:a', value: [1] },
        { key: 'order:b', value: [2] },
        { key: 'order:c', value: [3] },
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it('keys() with reverse:true yields keys in descending order in a real IDB', async () => {
    const page = await openPage();
    const dbName = uniqueDatabase();
    try {
      const result = await page.evaluate(async (databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          put(key: string, value: Uint8Array): Promise<void>;
          keys(prefix: string, options?: { reverse?: boolean }): AsyncIterable<string>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);

        await storage.put('rev:a', new Uint8Array([1]));
        await storage.put('rev:b', new Uint8Array([2]));
        await storage.put('rev:c', new Uint8Array([3]));

        const keys: string[] = [];
        for await (const key of storage.keys('rev:', { reverse: true })) {
          keys.push(key);
        }
        storage[Symbol.dispose]();
        return keys;
      }, dbName);

      expect(result).toEqual(['rev:c', 'rev:b', 'rev:a']);
    } finally {
      await page.close();
    }
  }, 30_000);

  // ─── 5. batch() atomicity ────────────────────────────────────────────────

  it('batch() applies all operations atomically — all visible together, none missing', async () => {
    const page = await openPage();
    const dbName = uniqueDatabase();
    try {
      const result = await page.evaluate(async (databaseName) => {
        type BatchOperation =
          | { type: 'put'; key: string; value: Uint8Array }
          | { type: 'delete'; key: string };
        type IDBStorageCtor = new (name: string) => {
          put(key: string, value: Uint8Array): Promise<void>;
          get(key: string): Promise<Uint8Array | null>;
          batch(operations: BatchOperation[]): Promise<void>;
          count(prefix: string): Promise<number>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);

        // Seed a key that will be deleted by the batch
        await storage.put('atomic:existing', new Uint8Array([99]));

        // A batch of puts + delete — all must land atomically
        await storage.batch([
          { type: 'put', key: 'atomic:a', value: new Uint8Array([1]) },
          { type: 'put', key: 'atomic:b', value: new Uint8Array([2]) },
          { type: 'delete', key: 'atomic:existing' },
        ]);

        const a = await storage.get('atomic:a');
        const b = await storage.get('atomic:b');
        const existing = await storage.get('atomic:existing');
        const count = await storage.count('atomic:');

        storage[Symbol.dispose]();
        return {
          a: a ? Array.from(a) : null,
          b: b ? Array.from(b) : null,
          existing: existing ? Array.from(existing) : null,
          count,
        };
      }, dbName);

      expect(result.a).toEqual([1]);
      expect(result.b).toEqual([2]);
      expect(result.existing).toBeNull();
      expect(result.count).toBe(2);
    } finally {
      await page.close();
    }
  }, 30_000);

  // ─── 6. conditionalBatch() compare-and-swap ──────────────────────────────

  it('conditionalBatch() commits when conditions match and aborts when they do not', async () => {
    const page = await openPage();
    const dbName = uniqueDatabase();
    try {
      const result = await page.evaluate(async (databaseName) => {
        type IDBStorageCtor = new (name: string) => {
          put(key: string, value: Uint8Array): Promise<void>;
          get(key: string): Promise<Uint8Array | null>;
          conditionalBatch(
            conditions: Array<{ key: string; expectedValue: Uint8Array | null }>,
            operations: Array<
              { type: 'put'; key: string; value: Uint8Array } | { type: 'delete'; key: string }
            >,
          ): Promise<boolean>;
          [Symbol.dispose](): void;
        };
        const Cls = (globalThis as Record<string, unknown>)['IndexedDBStorage'] as IDBStorageCtor;
        const storage = new Cls(databaseName);

        await storage.put('cas:key', new Uint8Array([1]));

        // Condition match: current value is [1], operation should commit
        const committed = await storage.conditionalBatch(
          [{ key: 'cas:key', expectedValue: new Uint8Array([1]) }],
          [{ type: 'put', key: 'cas:key', value: new Uint8Array([2]) }],
        );

        const afterCommit = await storage.get('cas:key');

        // Condition mismatch: current value is now [2], expect [99] — should abort
        const aborted = await storage.conditionalBatch(
          [{ key: 'cas:key', expectedValue: new Uint8Array([99]) }],
          [{ type: 'put', key: 'cas:key', value: new Uint8Array([3]) }],
        );

        const afterAbort = await storage.get('cas:key');
        storage[Symbol.dispose]();

        return {
          committed,
          afterCommit: afterCommit ? Array.from(afterCommit) : null,
          aborted,
          afterAbort: afterAbort ? Array.from(afterAbort) : null,
        };
      }, dbName);

      expect(result.committed).toBe(true);
      expect(result.afterCommit).toEqual([2]);
      expect(result.aborted).toBe(false);
      expect(result.afterAbort).toEqual([2]); // unchanged because abort
    } finally {
      await page.close();
    }
  }, 30_000);
});
