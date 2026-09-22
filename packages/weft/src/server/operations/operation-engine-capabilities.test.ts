import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  assertOperationEngineMethods,
  assertOperationWorkflowMethods,
  requireOperationStorage,
} from './operation-helpers.ts';
import { storageConditionalBatchOperation, storageGetOperation } from './storage.ts';

describe('operation engine capability boundaries', () => {
  it('accepts structural capabilities and rejects missing methods', () => {
    const structuralEngine = { cancelAll: () => undefined };

    expect(() => assertOperationEngineMethods(structuralEngine, ['cancelAll'])).not.toThrow();
    expect(() => assertOperationEngineMethods({}, ['cancelAll'])).toThrow(
      'missing required method "cancelAll"',
    );
  });

  it('accepts a concrete Engine and validates its storage contract', () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    expect(() => assertOperationEngineMethods(engine, ['cancelAll'])).not.toThrow();
    expect(requireOperationStorage(engine, ['get'])).toBe(engine.storage);
    expect(() => requireOperationStorage({}, ['get'])).toThrow('requested storage capability');
  });

  it('does not validate irrelevant optional capabilities for get-only storage', async () => {
    const storage = requireOperationStorage(
      { storage: { get: () => Promise.resolve(null), conditionalBatch: true } },
      ['get'],
    );
    await expect(storage.get('key')).resolves.toBeNull();
  });

  it('rejects malformed nested workflow capabilities at the boundary', () => {
    expect(() => assertOperationWorkflowMethods({ workflows: null }, ['getActive'])).toThrow(
      'missing the requested workflow capabilities',
    );
    expect(() =>
      assertOperationWorkflowMethods({ workflows: { getActive: true } }, ['getActive']),
    ).toThrow('missing required method "getActive"');
  });

  it('preserves the conditional-batch method error after a positive capability report', async () => {
    const principal = principalFromApiKey({
      subject: 'malformed-conditional-batch-caller',
      scopes: ['storage:admin'],
    });

    await Promise.resolve(
      expect(
        storageConditionalBatchOperation.invoke({
          input: { conditions: [], operations: [] },
          engine: {
            storage: {
              capabilities: () => ({
                persistence: 'ephemeral',
                readAfterWrite: 'linearizable',
                scanConsistency: 'snapshot',
                atomicBatch: true,
                conditionalBatch: true,
                boundedRangeDelete: false,
              }),
              conditionalBatch: true,
            },
          },
          principal,
          transport: 'http-rest',
        }),
      ).rejects.toThrow('does not implement the conditionalBatch() method'),
    );
  });

  it('rechecks conditional-batch capability before invoking a changing backend', async () => {
    const principal = principalFromApiKey({
      subject: 'changing-conditional-batch-caller',
      scopes: ['storage:admin'],
    });
    let capabilityChecks = 0;
    let conditionalBatchCalls = 0;
    const storage = {
      capabilities: () => ({
        persistence: 'ephemeral' as const,
        readAfterWrite: 'linearizable' as const,
        scanConsistency: 'snapshot' as const,
        atomicBatch: true,
        conditionalBatch: capabilityChecks++ === 0,
        boundedRangeDelete: false,
      }),
      conditionalBatch: async () => {
        conditionalBatchCalls += 1;
        return true;
      },
    };

    await expect(
      storageConditionalBatchOperation.invoke({
        input: { conditions: [], operations: [] },
        engine: { storage },
        principal,
        transport: 'http-rest',
      }),
    ).rejects.toThrow('requires storage capability "conditionalBatch"');
    expect(capabilityChecks).toBe(2);
    expect(conditionalBatchCalls).toBe(0);
  });

  it('invokes a raw operation against a minimal receiver-bound storage contract', async () => {
    const storage = {
      prefix: 'stored',
      get(key: string): Promise<Uint8Array> {
        return Promise.resolve(new TextEncoder().encode(`${this.prefix}:${key}`));
      },
    };
    const principal = principalFromApiKey({
      subject: 'minimal-storage-caller',
      scopes: ['storage:admin'],
    });

    await Promise.resolve(
      expect(
        storageGetOperation.invoke({
          input: { key: 'workflow-key' },
          engine: { storage },
          principal,
          transport: 'http-rest',
        }),
      ).resolves.toEqual(new TextEncoder().encode('stored:workflow-key')),
    );
  });
});
