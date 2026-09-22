import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { storageCapabilitiesOperation } from './storage-capabilities.ts';
import { storageGetOutput, storagePutInput } from './storage-schemas.ts';
import {
  adminOnlyStorageOptions,
  adminStorageOptions,
  DistinctCapabilityStorage,
  encode,
  readWriteStorageOptions,
  request,
  writeOnlyStorageOptions,
} from './storage.test-support.ts';
import { storageGetOperation } from './storage.ts';

function responseError(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    throw new Error('Expected an error response body.');
  }
  const error = value.error;
  if (typeof error !== 'string') throw new Error('Expected a string error response.');
  return error;
}

describe('storage REST operations', () => {
  it.each([new ArrayBuffer(4), new SharedArrayBuffer(4)])(
    'preserves a storage byte view and its backing buffer',
    async (buffer) => {
      const bytes: z.input<typeof storageGetOutput> = new Uint8Array(buffer, 1, 2);
      bytes.set([12, 34]);
      const storage = new MemoryStorage();
      await storage.put('bytes', bytes);
      using engine = new Engine({ storage });

      const result = await storageGetOperation.invoke({
        input: { key: 'bytes' },
        engine,
        principal: principalFromApiKey({ subject: 'admin', scopes: ['storage:admin'] }),
        transport: 'http-rest',
      });

      expect(result).toBe(bytes);
      expect(storageGetOutput.parse(result)).toBe(bytes);
      expect(storagePutInput.parse({ key: 'bytes', value: bytes }).value).toBe(bytes);
    },
  );

  it('rejects nonbyte storage values while allowing a missing get result', () => {
    for (const value of [[12, 34], new ArrayBuffer(2), new DataView(new ArrayBuffer(2))]) {
      expect(storageGetOutput.safeParse(value).success).toBe(false);
      expect(storagePutInput.safeParse({ key: 'bytes', value }).success).toBe(false);
    }
    expect(storageGetOutput.parse(null)).toBeNull();
    expect(storagePutInput.safeParse({ key: 'bytes', value: null }).success).toBe(false);
  });

  it('defensively authorizes direct operation invocation', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('workflow-key', encode('stored value'));
    using engine = new Engine({ storage: rawStorage });

    expect(
      storageGetOperation.invoke({
        input: { key: 'workflow-key' },
        engine,
        principal: anonymousPrincipal(),
        transport: 'http-rest',
      }),
    ).rejects.toMatchObject({ code: 'Unauthorized' });

    expect(
      storageGetOperation.invoke({
        input: { key: 'workflow-key' },
        engine,
        principal: principalFromApiKey({ subject: 'unscoped', scopes: ['storage:read'] }),
        transport: 'http-rest',
      }),
    ).rejects.toMatchObject({ code: 'Forbidden' });

    expect(
      storageGetOperation.invoke({
        input: { key: 'workflow-key' },
        engine,
        principal: principalFromApiKey({ subject: 'admin', scopes: ['storage:admin'] }),
        transport: 'http-rest',
      }),
    ).resolves.toEqual(encode('stored value'));
  });

  it('reports the backend capability profile to storage readers', async () => {
    const storage = new DistinctCapabilityStorage();
    using engine = new Engine({ storage });

    const response = await handleRequest(
      request('/v1/storage/-/capabilities'),
      engine,
      readWriteStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(storage.capabilities());
  });

  it('allows storage readers and administrators to inspect backend capabilities', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    const adminResponse = await handleRequest(
      request('/v1/storage/-/capabilities'),
      engine,
      adminOnlyStorageOptions(),
    );
    expect(adminResponse.status).toBe(200);

    const writeOnlyResponse = await handleRequest(
      request('/v1/storage/-/capabilities'),
      engine,
      writeOnlyStorageOptions(),
    );
    expect(writeOnlyResponse.status).toBe(403);

    const anonymousResponse = await handleRequest(request('/v1/storage/-/capabilities'), engine);
    expect(anonymousResponse.status).toBe(401);
  });

  it('requires every advertised capability profile to declare persistence', () => {
    expect(
      storageCapabilitiesOperation.outputSchema.safeParse({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: true,
      }).success,
    ).toBe(false);
  });

  it('advertises capability discovery on REST and every JSON-RPC transport', () => {
    const operation = createLiveOperationRegistry().get('weft.storage.capabilities');

    expect(operation).toMatchObject({
      destructive: false,
      access: {
        kind: 'scoped',
        scopes: { kind: 'anyOf', scopes: ['storage:read', 'storage:admin'] },
      },
      transports: {
        http: true,
        jsonRpcHttp: true,
        jsonRpcWebSocket: true,
        jsonRpcStdio: true,
      },
    });
  });

  it('returns a 501 NotImplemented when the backend lacks conditionalBatch', async () => {
    const inner = new MemoryStorage();
    // A backend that has the bound conditionalBatch method but honestly reports
    // no support — proves the operation gates on capabilities(), not method
    // presence. Delegates every method to a real MemoryStorage.
    const storageWithoutConditionalBatch = {
      capabilities: () => ({ ...inner.capabilities(), conditionalBatch: false }),
      get: inner.get.bind(inner),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      scan: inner.scan.bind(inner),
      batch: inner.batch.bind(inner),
      conditionalBatch: inner.conditionalBatch.bind(inner),
      has: inner.has.bind(inner),
      deletePrefix: inner.deletePrefix.bind(inner),
      keys: inner.keys.bind(inner),
      count: inner.count.bind(inner),
      scoped: inner.scoped.bind(inner),
      [Symbol.dispose]: inner[Symbol.dispose].bind(inner),
    };
    using engine = new Engine({ storage: storageWithoutConditionalBatch });

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

    expect(response.status).toBe(501);
    const body: unknown = await response.json();
    const error = responseError(body);
    expect(error).toBeDefined();
    expect(error).toContain('capabilities().conditionalBatch');
  });
});
