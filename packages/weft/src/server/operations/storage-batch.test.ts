import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MAX_BATCH_OPERATIONS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import {
  adminStorageOptions,
  decode,
  encode,
  readWriteStorageOptions,
  request,
} from './storage.test-support.ts';

function responseError(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    throw new Error('Expected an error response body.');
  }
  const error = value.error;
  if (typeof error !== 'string') throw new Error('Expected a string error response.');
  return error;
}

describe('storage REST batch operations', () => {
  it('applies batch writes and deletes through the server route', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('wf:delete', encode('old'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/-/batch', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            { type: 'put', key: 'wf:new', value: btoa('new') },
            { type: 'delete', key: 'wf:delete' },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(204);
    expect(decode(await rawStorage.get('wf:new'))).toBe('new');
    expect(await rawStorage.get('wf:delete')).toBeNull();
  });

  it('rejects malformed JSON storage batch bodies', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/storage/-/batch', {
        method: 'POST',
        body: '{',
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON.' });
  });

  it('rejects raw storage batches above MAX_BATCH_OPERATIONS before applying writes', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });
    const operations = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) => ({
      type: 'delete' as const,
      key: `oversized:${index}`,
    }));

    const response = await handleRequest(
      request('/v1/storage/-/batch', {
        method: 'POST',
        body: JSON.stringify({ operations }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['operations'],
            message: 'Too big: expected array to have <=10000 items',
            code: 'too_big',
          },
        ],
      },
    });
    expect(await rawStorage.get('oversized:0')).toBeNull();
  });

  it('evaluates conditional batch conditions against stored keys', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'wf:key', expectedValue: null }],
          operations: [{ type: 'put', key: 'wf:key', value: btoa('value') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(decode(await rawStorage.get('wf:key'))).toBe('value');
  });

  it('denies conditional batches to callers with both narrower storage scopes', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('wf:key', encode('existing'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'wf:key', expectedValue: btoa('existing') }],
          operations: [{ type: 'put', key: 'wf:key', value: btoa('changed') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      readWriteStorageOptions(),
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(responseError(body)).toContain('storage:admin');
    expect(decode(await rawStorage.get('wf:key'))).toBe('existing');
  });

  it('applies conditional batches atomically through the server route', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('key', encode('old'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'key', expectedValue: btoa('old') }],
          operations: [{ type: 'put', key: 'key', value: btoa('new') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(decode(await rawStorage.get('key'))).toBe('new');
  });

  it('rejects raw conditional batches above MAX_BATCH_OPERATIONS before adapter work', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });
    const conditions = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) => ({
      key: `oversized:${index}`,
      expectedValue: null,
    }));

    const response = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions,
          operations: [{ type: 'put', key: 'should-not-write', value: btoa('value') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['conditions'],
            message: 'Too big: expected array to have <=10000 items',
            code: 'too_big',
          },
        ],
      },
    });
    expect(await rawStorage.get('should-not-write')).toBeNull();
  });

  it('allows empty byte values in batch conditions and operations', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('empty', new Uint8Array());
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'empty', expectedValue: '' }],
          operations: [{ type: 'put', key: 'empty', value: '' }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(await rawStorage.get('empty')).toEqual(new Uint8Array());
  });

  it('returns 400 when batch operation values are not valid base64', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/storage/-/batch', {
        method: 'POST',
        body: JSON.stringify({
          operations: [{ type: 'put', key: 'key', value: 'not-base64' }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Storage batch operation value must be base64.',
    });
  });

  it('returns 400 when conditional batch expected values are not valid base64', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/storage/-/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'key', expectedValue: 'not-base64' }],
          operations: [{ type: 'delete', key: 'key' }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Storage conditional batch expectedValue must be base64.',
    });
  });
});
