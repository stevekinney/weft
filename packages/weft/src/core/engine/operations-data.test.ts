import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import type { ContextOperationRequest } from '../context.ts';
import { processLoadOperation } from './operations-data.ts';

type LoadOperation = Extract<ContextOperationRequest, { type: 'load' }>;

describe('data operation helpers', () => {
  it('rejects load references with invalid sizeBytes values', async () => {
    const operation: LoadOperation = {
      type: 'load',
      operationId: 'load-operation',
      reference: {
        workflowId: 'workflow-id',
        key: 'artifact',
        sizeBytes: Number.NaN,
      },
    };

    expect(
      await throwingRejectionOf(
        processLoadOperation({ storage: new MemoryStorage() } as never, 'workflow-id', operation, {
          persistCheckpoint: async () => {},
          runOperationWithResult: async (_workflowId, _operation, execute) => {
            await execute();
          },
        }),
      ),
    ).toThrow('ctx.load() requires a valid offload reference size');
  });
});
