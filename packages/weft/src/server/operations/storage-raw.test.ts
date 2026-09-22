import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MAX_SCAN_LIMIT } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  adminStorageOptions,
  decode,
  encode,
  request,
  ThrowingScanStorage,
  TrackingScanStorage,
  writeOnlyStorageOptions,
} from './storage.test-support.ts';

describe('storage REST raw operations', () => {
  it('exposes raw storage operations through REST only', () => {
    const registry = createLiveOperationRegistry();
    const storageOperationNames = [
      'weft.storage.get',
      'weft.storage.put',
      'weft.storage.delete',
      'weft.storage.scan',
      'weft.storage.batch',
      'weft.storage.conditionalbatch',
    ];

    for (const operationName of storageOperationNames) {
      expect(registry.get(operationName)?.transports).toEqual({
        http: true,
        jsonRpcHttp: false,
        jsonRpcStdio: false,
        jsonRpcWebSocket: false,
      });
    }
  });

  it('rejects an oversized binary PUT body before writing the key', async () => {
    const storage = new MemoryStorage();
    using engine = new Engine({ storage });

    const response = await handleRequest(
      request('/v1/storage/oversized-value', {
        method: 'PUT',
        body: new Uint8Array([1, 2]),
      }),
      engine,
      { ...adminStorageOptions(), maxRequestBodyBytes: 1 },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Payload Too Large',
      data: { maxBytes: 1 },
    });
    expect(await storage.get('oversized-value')).toBeNull();
  });

  it('advertises storage admin as the only accepted scope for every raw operation', () => {
    const registry = createLiveOperationRegistry();
    const storageOperationNames = [
      'weft.storage.get',
      'weft.storage.put',
      'weft.storage.delete',
      'weft.storage.scan',
      'weft.storage.batch',
      'weft.storage.conditionalbatch',
    ];

    for (const operationName of storageOperationNames) {
      expect(registry.get(operationName)?.access).toEqual({
        kind: 'scoped',
        scopes: { kind: 'anyOf', scopes: ['storage:admin'] },
      });
    }
  });

  it('reads and writes bytes through admin storage', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });

    const putResponse = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'PUT', body: encode('stored value') }),
      engine,
      adminStorageOptions(),
    );
    expect(putResponse.status).toBe(204);

    expect(decode(await rawStorage.get('workflow-key'))).toBe('stored value');

    const getResponse = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );
    expect(getResponse.status).toBe(200);
    expect(decode(new Uint8Array(await getResponse.arrayBuffer()))).toBe('stored value');
  });

  it('deletes bytes through admin storage', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('workflow-key', encode('stored value'));
    using engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'DELETE' }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(204);
    expect(await rawStorage.get('workflow-key')).toBeNull();
  });

  it('requires storage admin scope for raw access', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const response = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'GET' }),
      engine,
      {
        authContext: {
          method: 'api-key' as const,
          principal: principalFromApiKey({
            subject: 'unscoped-caller',
            scopes: ['storage:read'],
          }),
        },
      },
    );

    expect(response.status).toBe(403);
  });

  it('denies raw storage writes without storage admin scope', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/acme:data', { method: 'PUT', body: encode('value') }),
      engine,
      writeOnlyStorageOptions(),
    );

    expect(response.status).toBe(403);
    expect(await rawStorage.get('acme:data')).toBeNull();
  });

  it('streams scan results as NDJSON', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('wf:a', encode('a'));
    await rawStorage.put('wf:b', encode('b'));
    await rawStorage.put('other:c', encode('c'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage?prefix=wf:', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    const body = await response.text();
    const lines = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { key: 'wf:a', value: btoa('a') },
      { key: 'wf:b', value: btoa('b') },
    ]);
  });

  it('accepts an explicit false reverse query', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('wf:a', encode('a'));
    await rawStorage.put('wf:b', encode('b'));
    using engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage?prefix=wf:&reverse=false', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `${JSON.stringify({ key: 'wf:a', value: btoa('a') })}\n${JSON.stringify({ key: 'wf:b', value: btoa('b') })}\n`,
    );
  });

  it('rejects malformed storage scan query values', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    const cases = [
      {
        query: 'reverse=maybe',
        error: 'Query parameter "reverse" must be "true" or "false".',
      },
      { query: 'limit=0', error: 'Query parameter "limit" must be a positive integer.' },
      { query: 'limit=1.5', error: 'Query parameter "limit" must be a positive integer.' },
    ];

    for (const { query, error } of cases) {
      const response = await handleRequest(
        request(`/v1/storage?${query}`, { method: 'GET' }),
        engine,
        adminStorageOptions(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
  });

  it('propagates storage scan failures through the response stream', async () => {
    using engine = new Engine({ storage: new ThrowingScanStorage() });
    const response = await handleRequest(
      request('/v1/storage?prefix=wf:', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.text()).rejects.toThrow('scan failed');
  });

  it('rejects raw storage scans above MAX_SCAN_LIMIT', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request(`/v1/storage?prefix=wf:&limit=${MAX_SCAN_LIMIT + 1}`, { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['limit'],
            message: 'Too big: expected number to be <=10000',
            code: 'too_big',
          },
        ],
      },
    });
  });

  it('does not pull scan entries until the NDJSON response body is read', async () => {
    const rawStorage = new TrackingScanStorage();
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage?prefix=wf:', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    if (response.body === null) {
      throw new Error('Expected storage scan response to have a body.');
    }

    await Promise.resolve();
    await Promise.resolve();
    expect(rawStorage.entriesPulled).toBe(0);

    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(rawStorage.entriesPulled).toBe(1);
    expect(new TextDecoder().decode(first.value)).toBe(
      `${JSON.stringify({ key: 'wf:a', value: btoa('a') })}\n`,
    );

    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(rawStorage.entriesPulled).toBe(2);

    await reader.cancel();
  });

  it('keeps storage control routes outside the user key namespace', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });

    const keyResponse = await handleRequest(
      request('/v1/storage/batch', { method: 'PUT', body: encode('literal key') }),
      engine,
      adminStorageOptions(),
    );
    expect(keyResponse.status).toBe(204);
    expect(decode(await rawStorage.get('batch'))).toBe('literal key');

    const batchResponse = await handleRequest(
      request('/v1/storage/-/batch', {
        method: 'POST',
        body: JSON.stringify({
          operations: [{ type: 'put', key: 'from-control-route', value: btoa('control') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );
    expect(batchResponse.status).toBe(204);
    expect(decode(await rawStorage.get('from-control-route'))).toBe('control');

    const collisionResponse = await handleRequest(
      request('/v1/storage/batch', {
        method: 'POST',
        body: JSON.stringify({ operations: [] }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );
    expect(collisionResponse.status).toBe(404);
  });
});
