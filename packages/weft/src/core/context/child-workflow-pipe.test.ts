import { describe, expect, it } from 'bun:test';

import { Context } from '../context.ts';
import {
  createCompositionChildWorkflowOptions,
  createReduceChildWorkflowOptions,
  normalizePipeStage,
  resolveChildWorkflowTarget,
} from './child-workflow-pipe.ts';
import { getInternals } from './internals.ts';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-parent',
    workflowType: 'parent',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

async function* childWorkflow(): AsyncGenerator<never, string, unknown> {
  return 'done';
}

describe('resolveChildWorkflowTarget', () => {
  it('returns a workflow type name as it is', () => {
    const internals = getInternals(createContext());

    expect(resolveChildWorkflowTarget(internals, 'registered-type')).toBe('registered-type');
  });

  it('asks the engine for the registered type of a workflow function', () => {
    const resolved: unknown[] = [];
    const internals = getInternals(
      createContext({
        resolveWorkflowType: (target) => {
          resolved.push(target);
          return 'registered-from-function';
        },
      }),
    );

    expect(resolveChildWorkflowTarget(internals, childWorkflow as never)).toBe(
      'registered-from-function',
    );
    expect(resolved).toEqual([childWorkflow]);
  });

  it('refuses a workflow function when the context has no way to look up its registration', () => {
    const internals = getInternals(createContext());

    expect(() => resolveChildWorkflowTarget(internals, childWorkflow as never)).toThrow(
      'Workflow functions used in composition operators must be registered before use. Pass the registered workflow type string or register the function on the engine first.',
    );
    expect(() => normalizePipeStage(internals, childWorkflow as never)).toThrow(
      'must be registered before use',
    );
  });
});

describe('composition child workflow options', () => {
  const internals = () => getInternals(createContext());
  const refusal =
    'ctx.pipe, ctx.map, and ctx.reduce always await child workflow results. Use ctx.startChild() directly for parentClosePolicy: "abandon" or "request-cancel".';

  it('refuses a parent close policy other than await for pipe and map children', () => {
    for (const parentClosePolicy of ['abandon', 'request-cancel'] as const) {
      expect(() =>
        createCompositionChildWorkflowOptions(internals(), 'pipe:0', 0, {
          parentClosePolicy,
        } as never),
      ).toThrow(refusal);
    }
  });

  it('refuses it for reduce children too, before applying an id prefix', () => {
    expect(() =>
      createReduceChildWorkflowOptions(internals(), 'reduce:0', 2, {
        idPrefix: 'tally',
        parentClosePolicy: 'abandon',
      } as never),
    ).toThrow(refusal);
  });

  it('accepts await or no policy, and numbers children from the prefix', () => {
    expect(
      createCompositionChildWorkflowOptions(internals(), 'pipe:0', 1, {
        parentClosePolicy: 'await',
      }),
    ).toMatchObject({ id: 'wf-parent:pipe:0:1', parentClosePolicy: 'await' });
    expect(
      createReduceChildWorkflowOptions(internals(), 'reduce:0', 2, { idPrefix: 'tally' }),
    ).toMatchObject({ id: 'tally:2' });
  });
});
