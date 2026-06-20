import { describe, expect, it, mock } from 'bun:test';

import type { ChildWorkflowInterception } from '../interceptor/interception-contexts.ts';
import type { WorkflowState } from '../types.ts';
import type { ChildWorkflowOptions } from '../types/workflow-function.ts';
import { executeChildWorkflow } from './child-workflow.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';

// The public defense: `onTerminalConflict` must stay absent from `ChildWorkflowOptions`.
// If a future edit adds it, this fails to compile and forces a deliberate decision rather
// than silently turning the top-level restart policy into a child-start option.
type OnTerminalConflictAbsentFromChildOptions =
  'onTerminalConflict' extends keyof ChildWorkflowOptions ? false : true;
const _onTerminalConflictAbsent: OnTerminalConflictAbsentFromChildOptions = true;
void _onTerminalConflictAbsent;

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1,
    executionStateOwnerId: 'parent-owner',
    id: workflowId,
    input: { value: 1 },
    startedAt: 1,
    status: 'running',
    type: 'child',
    updatedAt: 1,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createInternals() {
  return {
    pendingExecutionStateOwnerId: undefined,
    pendingNestingDepth: undefined,
    pendingParentHeaders: undefined,
    workflowHeaders: new Map([['parent', new Map([['traceparent', '00-parent']])]]),
  };
}

describe('engine child workflow helpers', () => {
  it('rethrows id collisions when the existing child state is missing', async () => {
    const internals = createInternals();
    const collision = new WorkflowAlreadyExistsError('child-id');

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:1',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'cached' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start: async () => {
            throw collision;
          },
        },
      ),
    ).rejects.toBe(collision);

    expect(internals.pendingNestingDepth).toBeUndefined();
    expect(internals.pendingParentHeaders).toBeUndefined();
    expect(internals.pendingExecutionStateOwnerId).toBeUndefined();
  });

  it('reuses an existing matching child workflow after an id collision', async () => {
    const internals = createInternals();
    const childHandle = { result: mock(async () => 'cached-child-result') };

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:2',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => childHandle as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent'
              ? createWorkflowState('parent')
              : createWorkflowState('child-id'),
          start: async () => {
            throw new WorkflowAlreadyExistsError('child-id');
          },
        },
      ),
    ).resolves.toBe('cached-child-result');

    expect(childHandle.result).toHaveBeenCalled();
  });

  it('rejects an existing child workflow whose stored state differs', async () => {
    const internals = createInternals();

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:3',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'cached' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent'
              ? createWorkflowState('parent')
              : createWorkflowState('child-id', { input: { value: 2 } }),
          start: async () => {
            throw new WorkflowAlreadyExistsError('child-id');
          },
        },
      ),
    ).rejects.toThrow(
      'Child workflow id collision for "child-id" does not match the requested child workflow',
    );
  });

  it('rethrows non-id-collision child start failures', async () => {
    const internals = createInternals();
    const failure = new Error('start failed');

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:non-collision',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'cached' }) as never,
          loadWorkflowState: async () => createWorkflowState('parent'),
          start: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
  });

  it('wraps child workflow execution with the composed workflow interceptor', async () => {
    const internals = createInternals();

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:4',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () =>
            ({
              childWorkflow: async (
                interception: ChildWorkflowInterception,
                next: (interception: ChildWorkflowInterception) => Promise<unknown>,
              ) => ({
                headers: [...interception.parentHeaders],
                result: await next(interception),
              }),
            }) as never,
          getHandle: () => ({ result: async () => 'child-result' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start: async () => ({ result: async () => 'child-result' }) as never,
        },
      ),
    ).resolves.toEqual({
      headers: [['traceparent', '00-parent']],
      result: 'child-result',
    });
  });

  it('rejects onTerminalConflict smuggled onto a child-start', async () => {
    const internals = createInternals();
    const start = mock(async () => ({ result: async () => 'never' }) as never);

    // The real threat is a structurally valid `ChildWorkflowOptions` carrying one extra
    // runtime property (an untyped JS caller or a widened cast), not an impossible value.
    // Model exactly that: a genuine ChildWorkflowOptions intersected with the smuggled key.
    const smuggledOptions = {
      id: 'child-id',
      onTerminalConflict: 'start-new',
    } satisfies ChildWorkflowOptions & { onTerminalConflict: 'start-new' };

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:terminal-conflict',
          options: smuggledOptions,
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'never' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start,
        },
      ),
    ).rejects.toThrow('ctx.startChild does not support options.onTerminalConflict');

    // The guard fires before the start is dispatched — no replacement run is created.
    expect(start).not.toHaveBeenCalled();
    // Pending child-execution context is still cleared on the rejection path.
    expect(internals.pendingNestingDepth).toBeUndefined();
    expect(internals.pendingParentHeaders).toBeUndefined();
    expect(internals.pendingExecutionStateOwnerId).toBeUndefined();
  });
});
