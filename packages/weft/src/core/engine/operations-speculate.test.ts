import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import { driveSpeculativeGenerator, executeSpeculativeBranch } from './operations-speculate.ts';
import { SpeculativeExecutionState } from './speculative-execution-state.ts';

type SpeculateOperation = Extract<ContextOperationRequest, { type: 'speculate' }>;

function createSpeculateOperation(execute: SpeculateOperation['execute']): SpeculateOperation {
  return {
    type: 'speculate',
    operationId: 'speculate:0',
    execute,
  };
}

describe('speculative operation helpers', () => {
  it('rejects speculative execution outside inline mode', async () => {
    const operation = createSpeculateOperation(function* () {
      return 'never';
    });

    await expect(
      executeSpeculativeBranch(
        { inlineStrategy: null } as unknown as EngineInternals,
        'workflow-id',
        operation,
        {
          executeSubOperation: async () => 'unused',
        },
      ),
    ).rejects.toThrow('ctx.speculate() requires inline execution mode');
  });

  it('rejects speculative execution when no inline context exists', async () => {
    const operation = createSpeculateOperation(function* () {
      return 'never';
    });

    await expect(
      executeSpeculativeBranch(
        {
          inlineStrategy: {
            getContext: () => undefined,
          },
        } as unknown as EngineInternals,
        'workflow-id',
        operation,
        {
          executeSubOperation: async () => 'unused',
        },
      ),
    ).rejects.toThrow('No active inline context for workflow "workflow-id"');
  });

  it('rethrows non-Error branch failures into the generator as Errors', async () => {
    const completedOperations: string[] = [];

    async function* generator(): AsyncGenerator<ContextOperationRequest, string, unknown> {
      try {
        yield {
          type: 'memo',
          key: 'branch',
          operationId: 'memo:0',
          fn: () => 'unused',
        };
      } catch (error) {
        completedOperations.push(error instanceof Error ? error.message : 'wrong error shape');
      }

      const finalValue = yield {
        type: 'memo',
        key: 'after-error',
        operationId: 'memo:1',
        fn: () => 'unused',
      };
      return typeof finalValue === 'string' ? finalValue : 'wrong final value shape';
    }

    const result = await driveSpeculativeGenerator(
      'workflow-id',
      generator(),
      new SpeculativeExecutionState(),
      {
        executeSubOperation: async (_workflowId, operation) => {
          if (operation.type === 'memo' && operation.key === 'after-error') {
            return 'recovered result';
          }
          throw 'string failure';
        },
      },
    );

    expect(completedOperations).toEqual(['string failure']);
    expect(result).toBe('recovered result');
  });
});
