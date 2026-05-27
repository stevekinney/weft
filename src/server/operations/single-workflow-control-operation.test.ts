import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { anonymousPrincipal } from '../principal.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const inputSchema = z.object({
  workflowId: z.string().min(1),
});

describe('single-workflow control operation helpers', () => {
  it('maps not-found failures through one invoke scaffold', async () => {
    const operation = createSingleWorkflowControlOperation({
      name: 'weft.workflows.cancel',
      summary: 'Cancel a running workflow',
      destructive: false,
      tags: ['Workflows'],
      inputSchema,
      outputSchema: z.undefined(),
      producibleFaults: ['NotFound'],
      invoke: async () => {
        throw new Error('workflow not found');
      },
    });

    const result = operation.invoke({
      input: { workflowId: 'missing-workflow' },
      engine: {} as Engine,
      principal: anonymousPrincipal(),
      transport: 'http-rest',
    });

    await expect(result).rejects.toEqual({
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow', identifier: 'missing-workflow' },
    });
  });

  it('lets callers preserve operation-specific conflict mappings', async () => {
    const operation = createSingleWorkflowControlOperation({
      name: 'weft.workflows.resume',
      summary: 'Resume a suspended workflow',
      destructive: false,
      tags: ['Workflows'],
      inputSchema,
      outputSchema: z.object({ id: z.string() }),
      producibleFaults: ['NotFound', 'Conflict'],
      invoke: async () => {
        throw new Error('Cannot resume completed workflow');
      },
      mapErrorToFault: ({ message }) =>
        message.includes('Cannot resume')
          ? {
              code: 'Conflict',
              message,
              data: { reason: message },
            }
          : undefined,
    });

    const result = operation.invoke({
      input: { workflowId: 'completed-workflow' },
      engine: {} as Engine,
      principal: anonymousPrincipal(),
      transport: 'http-rest',
    });

    await expect(result).rejects.toEqual({
      code: 'Conflict',
      message: 'Cannot resume completed workflow',
      data: { reason: 'Cannot resume completed workflow' },
    });
  });

  it('keeps workflow id path extraction consistent for REST bindings', () => {
    expect(extractWorkflowIdFromPath({ id: 'workflow-123' })).toEqual({
      workflowId: 'workflow-123',
    });
    expect(extractWorkflowIdFromPath({})).toEqual({ workflowId: '' });
  });
});
