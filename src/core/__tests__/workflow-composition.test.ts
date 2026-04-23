import { describe, expect, it } from 'bun:test';

import { TestEngine } from '../../testing/test-engine.ts';
import { Context } from '../context.ts';
import { Engine } from '../engine.ts';
import { tenantFromInputField } from '../tenant.ts';
import type { WorkflowContext, WorkflowReduceInput } from '../types.ts';

async function* trimStage(_ctx: WorkflowContext, input: unknown) {
  return String(input).trim();
}

async function* upperStage(_ctx: WorkflowContext, input: unknown) {
  return String(input).toUpperCase();
}

async function* exclaimStage(_ctx: WorkflowContext, input: unknown) {
  return `${String(input)}!`;
}

describe('workflow composition operators', () => {
  it('Track 7c: ctx.pipe runs a 3-stage pipeline using registered workflow functions', async () => {
    const engine = new TestEngine();

    engine.register('trim-stage', trimStage);
    engine.register('upper-stage', upperStage);
    engine.register('exclaim-stage', exclaimStage);

    engine.register('pipeline-parent', async function* (ctx: WorkflowContext, input: unknown) {
      return yield* ctx.pipe([trimStage, upperStage, exclaimStage], input);
    });

    const handle = await engine.start('pipeline-parent', '  hello world  ');

    await expect(handle.result()).resolves.toBe('HELLO WORLD!');
  });

  it('Track 7c: ctx.pipe preserves completed stages across recovery and allows compensation after a middle-stage failure', async () => {
    const engine = new TestEngine({ startTime: 0 });

    let firstStageRuns = 0;
    let secondStageRuns = 0;
    const compensations: string[] = [];

    async function* firstStage(_ctx: WorkflowContext, input: unknown) {
      firstStageRuns++;
      return `prepared:${String(input)}`;
    }

    async function* secondStage(ctx: WorkflowContext, input: unknown) {
      secondStageRuns++;
      yield* (ctx as Context).sleep('1s');
      throw new Error(`stage failed:${String(input)}`);
    }

    async function* unreachableStage(_ctx: WorkflowContext, input: unknown) {
      return `never:${String(input)}`;
    }

    const recordCompensation = async (value: unknown) => {
      compensations.push(String(value));
      return { compensated: String(value) };
    };

    engine.register('first-stage', firstStage);
    engine.register('second-stage', secondStage);
    engine.register('unreachable-stage', unreachableStage);
    engine.register(
      'pipeline-failure-parent',
      async function* (ctx: WorkflowContext, input: unknown) {
        const context = ctx as Context;

        try {
          return yield* ctx.pipe(
            [{ type: firstStage }, { type: secondStage }, { type: unreachableStage }],
            input,
          );
        } catch {
          return yield* context.run(recordCompensation, `rollback:${String(input)}`);
        }
      },
    );

    const originalHandle = await engine.start('pipeline-failure-parent', 'order-123');
    await engine.advanceTime(0);

    const recovered = engine.recover();
    recovered.register('first-stage', firstStage);
    recovered.register('second-stage', secondStage);
    recovered.register('unreachable-stage', unreachableStage);
    recovered.register(
      'pipeline-failure-parent',
      async function* (ctx: WorkflowContext, input: unknown) {
        const context = ctx as Context;

        try {
          return yield* ctx.pipe(
            [{ type: firstStage }, { type: secondStage }, { type: unreachableStage }],
            input,
          );
        } catch {
          return yield* context.run(recordCompensation, `rollback:${String(input)}`);
        }
      },
    );

    await recovered.recoverAll();
    const resumedHandle = recovered.getHandle(originalHandle.id);
    await recovered.advanceTime('1s');

    await expect(resumedHandle.result()).resolves.toEqual({ compensated: 'rollback:order-123' });
    expect(firstStageRuns).toBe(1);
    expect(secondStageRuns).toBe(2);
    expect(compensations).toEqual(['rollback:order-123']);
  });

  it('Track 7c: ctx.map returns results in input order', async () => {
    const engine = new TestEngine();

    async function* doubleStage(_ctx: WorkflowContext, input: unknown) {
      return Number(input) * 2;
    }

    engine.register('double-stage', doubleStage);
    engine.register('map-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.map([3, 1, 2], 'double-stage');
    });

    const handle = await engine.start('map-parent', null);

    await expect(handle.result()).resolves.toEqual([6, 2, 4]);
  });

  it('Track 7c: user-provided child workflow ids fail fast when the existing child does not match the requested input', async () => {
    const engine = new TestEngine();

    async function* echoStage(_ctx: WorkflowContext, input: unknown) {
      return { echoed: input };
    }

    engine.register('echo-stage', echoStage);
    engine.register('first-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.pipe([{ type: echoStage, options: { id: 'shared-child' } }], 'alpha');
    });
    engine.register('second-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.pipe([{ type: echoStage, options: { id: 'shared-child' } }], 'beta');
    });

    const firstHandle = await engine.start('first-parent', null);
    await expect(firstHandle.result()).resolves.toEqual({ echoed: 'alpha' });

    const secondHandle = await engine.start('second-parent', null);
    await expect(secondHandle.result()).rejects.toThrow(
      'Child workflow id collision for "shared-child" does not match the requested child workflow',
    );
  });

  it('Track 7c: child workflow reuse does not cross tenant boundaries when only one parent has a tenant', async () => {
    const engine = new Engine({ tenantResolver: tenantFromInputField('tenantId') });

    async function* echoStage(_ctx: WorkflowContext, input: unknown) {
      return { echoed: input };
    }

    engine.register('echo-stage', echoStage);
    engine.register('tenant-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.pipe([{ type: echoStage, options: { id: 'shared-child' } }], 'alpha');
    });

    const firstHandle = await engine.start('tenant-parent', {});
    await expect(firstHandle.result()).resolves.toEqual({ echoed: 'alpha' });

    const secondHandle = await engine.start('tenant-parent', { tenantId: 'acme' });
    await expect(secondHandle.result()).rejects.toThrow(
      'Child workflow id collision for "shared-child" does not match the requested child workflow',
    );
  });

  it('Track 7c: ctx.map honors the concurrency limit while keeping input order', async () => {
    const engine = new TestEngine({ startTime: 0 });

    let activeChildren = 0;
    let maxActiveChildren = 0;

    async function* delayedStage(ctx: WorkflowContext, input: unknown) {
      activeChildren++;
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
      yield* (ctx as Context).sleep('1s');
      activeChildren--;
      return Number(input) * 10;
    }

    engine.register('delayed-stage', delayedStage);
    engine.register('concurrency-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.map([1, 2, 3, 4, 5], 'delayed-stage', { concurrency: 2 });
    });

    const handle = await engine.start('concurrency-parent', null);

    await engine.advanceTime(0);
    await engine.advanceTime('1s');
    await engine.advanceTime('1s');
    await engine.advanceTime('1s');

    await expect(handle.result()).resolves.toEqual([10, 20, 30, 40, 50]);
    expect(maxActiveChildren).toBe(2);
  });

  it('Track 7c: ctx.map recovery preserves later step indices when batching by concurrency', async () => {
    const engine = new TestEngine({ startTime: 0 });

    const childRuns: number[] = [];

    async function* delayedStage(ctx: WorkflowContext, input: unknown) {
      childRuns.push(Number(input));
      yield* (ctx as Context).sleep('1s');
      return Number(input) * 10;
    }

    engine.register('delayed-stage', delayedStage);
    engine.register('map-recovery-parent', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const mapped = yield* ctx.map([1, 2, 3], 'delayed-stage', { concurrency: 1 });
      yield* context.sleep('1s');
      return mapped;
    });

    const originalHandle = await engine.start('map-recovery-parent', null);

    await engine.advanceTime(0);
    await engine.advanceTime('1s');
    await engine.advanceTime('1s');
    await engine.advanceTime('1s');

    const recovered = engine.recover();
    recovered.register('delayed-stage', delayedStage);
    recovered.register('map-recovery-parent', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const mapped = yield* ctx.map([1, 2, 3], 'delayed-stage', { concurrency: 1 });
      yield* context.sleep('1s');
      return mapped;
    });

    await recovered.recoverAll();
    const resumedHandle = recovered.getHandle(originalHandle.id);
    await recovered.advanceTime('1s');

    await expect(resumedHandle.result()).resolves.toEqual([10, 20, 30]);
    expect(childRuns).toEqual([1, 2, 3]);
  });

  it('Track 7c: ctx.map still enforces child-workflow nesting depth inside parallel sub-operations', async () => {
    const engine = new Engine({ maxNestingDepth: 2 });

    engine.register('recursive-map', async function* (ctx: WorkflowContext, input: unknown) {
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* ctx.map([{ level: level + 1 }], 'recursive-map');
      }

      return [level];
    });

    const handle = await engine.start('recursive-map', { level: 0 });

    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('Track 7c: ctx.reduce folds sequentially and handles an empty array', async () => {
    const engine = new TestEngine();

    engine.register('fold-stage', async function* (_ctx: WorkflowContext, input: unknown) {
      const typedInput = input as WorkflowReduceInput<number, number>;
      return typedInput.accumulator + typedInput.item + typedInput.index;
    });
    engine.register('reduce-parent', async function* (ctx: WorkflowContext) {
      const folded = yield* ctx.reduce([4, 5, 6], 'fold-stage', 1, { idPrefix: 'fold-step' });
      const empty = yield* ctx.reduce([], 'fold-stage', 99);
      return { folded, empty };
    });

    const handle = await engine.start('reduce-parent', null);

    await expect(handle.result()).resolves.toEqual({
      folded: 19,
      empty: 99,
    });
  });

  it('Track 7c: nested composition works with ctx.pipe inside ctx.map', async () => {
    const engine = new TestEngine();

    async function* incrementStage(_ctx: WorkflowContext, input: unknown) {
      return Number(input) + 1;
    }

    async function* wrapStage(_ctx: WorkflowContext, input: unknown) {
      return `value:${String(input)}`;
    }

    engine.register('increment-stage', incrementStage);
    engine.register('wrap-stage', wrapStage);
    engine.register('pipeline-item', async function* (ctx: WorkflowContext, input: unknown) {
      return yield* ctx.pipe([{ type: incrementStage }, { type: wrapStage }], input);
    });
    engine.register('nested-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.map([1, 2, 3], 'pipeline-item');
    });

    const handle = await engine.start('nested-parent', null);

    await expect(handle.result()).resolves.toEqual(['value:2', 'value:3', 'value:4']);
  });

  it('Track 7c: ctx.pipe rejects unregistered workflow functions even when the function name matches a registered type', async () => {
    const engine = new TestEngine();

    async function* registeredStage(_ctx: WorkflowContext, input: unknown) {
      return String(input).toUpperCase();
    }

    const imposterStage = async function* shadowStage(_ctx: WorkflowContext, input: unknown) {
      return `imposter:${String(input)}`;
    };
    Object.defineProperty(imposterStage, 'name', {
      value: 'registeredStage',
      configurable: true,
    });

    engine.register('registered-stage', registeredStage);
    engine.register('pipe-parent', async function* (ctx: WorkflowContext, input: unknown) {
      return yield* ctx.pipe([imposterStage], input);
    });

    const handle = await engine.start('pipe-parent', 'hello');

    await expect(handle.result()).rejects.toThrow(
      'Workflow functions used in composition operators must be registered before use.',
    );
  });

  it('Track 7c: empty ctx.map and ctx.reduce are side-effect free even for unregistered workflow functions', async () => {
    const engine = new TestEngine();

    async function* registeredStage(_ctx: WorkflowContext, input: unknown) {
      return String(input).toUpperCase();
    }

    const imposterStage = async function* shadowStage(_ctx: WorkflowContext, input: unknown) {
      return `imposter:${String(input)}`;
    };
    Object.defineProperty(imposterStage, 'name', {
      value: 'registeredStage',
      configurable: true,
    });

    engine.register('registered-stage', registeredStage);
    engine.register('composition-parent', async function* (ctx: WorkflowContext) {
      const mapped = yield* ctx.map([], imposterStage);
      const reduced = yield* ctx.reduce([], imposterStage, 'seed');
      return { mapped, reduced };
    });

    const handle = await engine.start('composition-parent', null);

    await expect(handle.result()).resolves.toEqual({
      mapped: [],
      reduced: 'seed',
    });
  });

  it('Track 7c: child workflow reuse ignores plain-object key ordering in inputs', async () => {
    const engine = new TestEngine();

    async function* echoStage(_ctx: WorkflowContext, input: unknown) {
      return input;
    }

    engine.register('echo-stage', echoStage);
    engine.register('first-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.pipe([{ type: echoStage, options: { id: 'shared-child' } }], {
        alpha: 1,
        beta: 2,
      });
    });
    engine.register('second-parent', async function* (ctx: WorkflowContext) {
      return yield* ctx.pipe([{ type: echoStage, options: { id: 'shared-child' } }], {
        beta: 2,
        alpha: 1,
      });
    });

    const firstHandle = await engine.start('first-parent', null);
    await expect(firstHandle.result()).resolves.toEqual({ alpha: 1, beta: 2 });

    const secondHandle = await engine.start('second-parent', null);
    await expect(secondHandle.result()).resolves.toEqual({ alpha: 1, beta: 2 });
  });
});
