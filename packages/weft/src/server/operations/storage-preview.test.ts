import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { BunSQLiteStorage } from "../../embedded/storage-bun-sqlite/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import { previewStorageValue, STORAGE_VALUE_PREVIEW_BYTES } from './storage-value-preview.ts';
import {
  adminStorageOptions,
  encode,
  request,
  writeOnlyStorageOptions,
} from './storage.test-support.ts';

/** Previews `key` over REST, as the storage browser does. */
async function preview(engine: Engine, key: string, options = adminStorageOptions()) {
  return handleRequest(
    request(`/v1/storage/-/preview?key=${encodeURIComponent(key)}`, { method: 'GET' }),
    engine,
    options,
  );
}

describe('weft.storage.preview', () => {
  it('shows a large non-JSON value as its first 64 KB of text with its whole size, and the raw get still returns every byte', async () => {
    // A 2.1 MB server log, as the sample world's log:server holds.
    const line = '2026-11-02 09:00:02 server started\n';
    const log = line.repeat(Math.ceil(2_100_000 / line.length));
    const storage = new MemoryStorage();
    await storage.put('log:server', encode(log));
    using engine = new Engine({ storage });

    const response = await preview(engine, 'log:server');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      key: 'log:server',
      byteLength: encode(log).byteLength,
      format: 'text',
      truncated: true,
    });
    expect(body['preview']).toBe(log.slice(0, STORAGE_VALUE_PREVIEW_BYTES));
    expect(STORAGE_VALUE_PREVIEW_BYTES).toBe(65_536);

    const raw = await handleRequest(
      request('/v1/storage/log%3Aserver', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );
    const bytes = await raw.arrayBuffer();
    expect(bytes.byteLength).toBe(encode(log).byteLength);
  });

  it('judges a small JSON value as json and returns all of it', async () => {
    const storage = new MemoryStorage();
    const value = '{"dismissed":true,"dismissedOn":"2026-11-01T22:12:00Z"}';
    await storage.put('app:welcome-banner', encode(value));
    using engine = new Engine({ storage });

    const response = await preview(engine, 'app:welcome-banner');

    expect(await response.json()).toEqual({
      key: 'app:welcome-banner',
      byteLength: value.length,
      format: 'json',
      preview: value,
      truncated: false,
      updatedAt: null,
    });
  });

  it('carries the key’s write time, so an editor refused for a newer write can say when the app wrote it', async () => {
    // Central time on Mon, Nov 2, 2026: the editor opens the key at 10:42 AM, and the app
    // rewrites it at 10:45 AM while the edit is open.
    let clock = Date.UTC(2026, 10, 2, 16, 42);
    using storage = new BunSQLiteStorage(':memory:', { now: () => clock });
    await storage.put('memory:preferences', encode('{"tone":"short"}'));
    await storage.put('agent-session:summary-index', encode('{"sessions":[]}'));
    using engine = new Engine({ storage });

    const opened = await preview(engine, 'memory:preferences');
    expect(await opened.json()).toMatchObject({ updatedAt: Date.UTC(2026, 10, 2, 16, 42) });

    clock = Date.UTC(2026, 10, 2, 16, 45);
    await storage.put('memory:preferences', encode('{"tone":"long"}'));

    // The editor saves only over the value it read, so the app's newer value is never overwritten.
    const save = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'memory:preferences', expectedValue: btoa('{"tone":"short"}') }],
          operations: [{ type: 'put', key: 'memory:preferences', value: btoa('{"tone":"mine"}') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );
    expect(await save.json()).toEqual({ applied: false });

    const response = await preview(engine, 'memory:preferences');
    expect(await response.json()).toEqual({
      key: 'memory:preferences',
      byteLength: 15,
      format: 'json',
      preview: '{"tone":"long"}',
      truncated: false,
      updatedAt: Date.UTC(2026, 10, 2, 16, 45),
    });

    const scan = await handleRequest(
      request('/v1/storage?prefix=', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );
    const body = await scan.text();
    const rows = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { key: string; updatedAt: number | null });
    expect(rows.map(({ key, updatedAt }) => [key, updatedAt])).toEqual([
      ['agent-session:summary-index', Date.UTC(2026, 10, 2, 16, 42)],
      ['memory:preferences', Date.UTC(2026, 10, 2, 16, 45)],
    ]);
  });

  it('previews exactly the named key, never a longer key it prefixes', async () => {
    using storage = new BunSQLiteStorage(':memory:', { now: () => 1_000 });
    await storage.put('memory:goalsx', encode('other'));
    using engine = new Engine({ storage });

    const absent = await preview(engine, 'memory:goals');
    expect(absent.status).toBe(404);
    await storage.put('memory:goals', encode('mine'));
    const present = await preview(engine, 'memory:goals');
    expect(await present.json()).toMatchObject({
      preview: 'mine',
      updatedAt: 1_000,
    });
  });

  it('answers 404 for an absent key and requires storage admin', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    const absent = await preview(engine, 'missing');
    const forbidden = await preview(engine, 'missing', writeOnlyStorageOptions());
    expect(absent.status).toBe(404);
    expect(forbidden.status).toBe(403);
  });
});

describe('previewStorageValue', () => {
  it('judges JSON on the whole value, so a JSON value larger than the preview is still json', () => {
    const value = JSON.stringify({ entries: 'x'.repeat(STORAGE_VALUE_PREVIEW_BYTES * 2) });

    const result = previewStorageValue(encode(value));

    expect(result.format).toBe('json');
    expect(result.truncated).toBe(true);
    expect(result.preview?.length).toBe(STORAGE_VALUE_PREVIEW_BYTES);
  });

  it('cuts back to a whole character rather than splitting a multi-byte one', () => {
    // One ASCII byte, then four-byte characters: the 64 KB mark falls inside one of them.
    const value = `a${'😀'.repeat(STORAGE_VALUE_PREVIEW_BYTES / 4 + 1)}`;

    const result = previewStorageValue(encode(value));

    expect(result.format).toBe('text');
    expect(result.truncated).toBe(true);
    // 1 + 4 × 16,383 bytes fit; the next character would end past the mark.
    expect(encode(result.preview ?? '').byteLength).toBe(
      1 + 4 * (STORAGE_VALUE_PREVIEW_BYTES / 4 - 1),
    );
    expect(result.preview?.endsWith('😀')).toBe(true);
  });

  it('gives a binary value no preview, and an empty value is empty text', () => {
    expect(previewStorageValue(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({
      byteLength: 3,
      format: 'binary',
      preview: null,
      truncated: false,
    });
    expect(previewStorageValue(new Uint8Array())).toEqual({
      byteLength: 0,
      format: 'text',
      preview: '',
      truncated: false,
    });
  });
});
