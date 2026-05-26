import { describe, expect, it } from 'bun:test';

import { TestEngine } from '../../testing/test-engine.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext, type WorkflowReduceInput } from '../types.ts';

async function* trimStageFn(_ctx: WorkflowContext, input: unknown) {
  return String(input).trim();
}

async function* upperStageFn(_ctx: WorkflowContext, input: unknown) {
  return String(input).toUpperCase();
}

async function* exclaimStageFn(_ctx: WorkflowContext, input: unknown) {
  return `${String(input)}!`;
}

const trimStage = workflow({ name: 'trim-stage' }).execute(trimStageFn);
const upperStage = workflow({ name: 'upper-stage' }).execute(upperStageFn);
const exclaimStage = workflow({ name: 'exclaim-stage' }).execute(exclaimStageFn);

describe('workflow composition operators', () => {
  it('Track 7c: ctx.pipe runs a 3-stage pipeline using registered workflow functions', async () => {
    const engine = new TestEngine();

    engine.register(trimStage);
    engine.register(upperStage);
    engine.register(exclaimStage);

    engine.register(
      workflow({ name: 'pipeline-parent' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        return yield* ctx.pipe(['trim-stage', 'upper-stage', 'exclaim-stage'], input);
      }),
    );

    const handle = await engine.start('pipeline-parent', '  hello world  ');

    await expect(handle.result()).resolves.toBe('HELLO WORLD!');
  });

  it('Track 7c: ctx.pipe preserves completed stages across recovery and allows compensation after a middle-stage failure', async () => {
    const engine = new TestEngine({ startTime: 0 });

    let firstStageRuns = 0;
    let secondStageRuns = 0;
    const compensations: string[] = [];

    const firstStage = workflow({ name: 'first-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      firstStageRuns++;
      return `prepared:${String(input)}`;
    });

    const secondStage = workflow({ name: 'second-stage' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      secondStageRuns++;
      yield* ctx.sleep('1s');
      throw new Error(`stage failed:${String(input)}`);
    });

    const unreachableStage = workflow({ name: 'unreachable-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return `never:${String(input)}`;
    });

    const recordCompensation = async (value: unknown) => {
      compensations.push(String(value));
      return { compensated: String(value) };
    };

    const pipelineFailureParent = workflow({ name: 'pipeline-failure-parent' }).execute(
      async function* (ctx: WorkflowContext, input: unknown) {
        const context = ctx;

        try {
          return yield* ctx.pipe(
            [{ type: 'first-stage' }, { type: 'second-stage' }, { type: 'unreachable-stage' }],
            input,
          );
        } catch {
          return yield* context.run(recordCompensation, `rollback:${String(input)}`);
        }
      },
    );

    engine.register(firstStage);
    engine.register(secondStage);
    engine.register(unreachableStage);
    engine.register(pipelineFailureParent);

    const originalHandle = await engine.start('pipeline-failure-parent', 'order-123');
    await engine.advanceTime(0);

    const recovered = engine.recover();
    recovered.register(firstStage);
    recovered.register(secondStage);
    recovered.register(unreachableStage);
    recovered.register(pipelineFailureParent);

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

    const doubleStage = workflow({ name: 'double-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return Number(input) * 2;
    });

    engine.register(doubleStage);
    engine.register(
      workflow({ name: 'map-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.map([3, 1, 2], 'double-stage');
      }),
    );

    const handle = await engine.start('map-parent', null);

    await expect(handle.result()).resolves.toEqual([6, 2, 4]);
  });

  it('Track 7c: user-provided child workflow ids fail fast when the existing child does not match the requested input', async () => {
    const engine = new TestEngine();

    const echoStage = workflow({ name: 'echo-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return { echoed: input };
    });

    engine.register(echoStage);
    engine.register(
      workflow({ name: 'first-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], 'alpha');
      }),
    );
    engine.register(
      workflow({ name: 'second-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], 'beta');
      }),
    );

    const firstHandle = await engine.start('first-parent', null);
    await expect(firstHandle.result()).resolves.toEqual({ echoed: 'alpha' });

    const secondHandle = await engine.start('second-parent', null);
    await expect(secondHandle.result()).rejects.toThrow(
      'Child workflow id collision for "shared-child" does not match the requested child workflow',
    );
  });

  it('child workflow reuse does not cross execution-state owners', async () => {
    const engine = new TestEngine();

    const echoStage = workflow({ name: 'echo-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return { echoed: input };
    });

    engine.register(echoStage);
    engine.register(
      workflow({ name: 'first-execution-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], 'same');
      }),
    );
    engine.register(
      workflow({ name: 'second-execution-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], 'same');
      }),
    );

    const firstHandle = await engine.start('first-execution-parent', null, {
      id: 'first-parent',
    });
    await expect(firstHandle.result()).resolves.toEqual({ echoed: 'same' });

    const secondHandle = await engine.start('second-execution-parent', null, {
      id: 'second-parent',
    });
    await expect(secondHandle.result()).rejects.toThrow(
      'Child workflow id collision for "shared-child" does not match the requested child workflow',
    );
  });

  it('child workflow id collisions do not leak nesting depth into later workflow starts', async () => {
    const engine = new Engine({ maxNestingDepth: 1 });

    const echoStage = workflow({ name: 'echo-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return { echoed: input };
    });

    engine.register(echoStage);
    engine.register(
      workflow({ name: 'first-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], 'same');
      }),
    );
    engine.register(
      workflow({ name: 'collision-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe(
          [{ type: 'echo-stage', options: { id: 'shared-child' } }],
          'different',
        );
      }),
    );
    engine.register(
      workflow({ name: 'unrelated-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.pipe([{ type: 'echo-stage' }], 'unrelated');
      }),
    );

    const firstHandle = await engine.start('first-parent', null, {
      id: 'first-parent',
    });
    await expect(firstHandle.result()).resolves.toEqual({ echoed: 'same' });

    const collisionHandle = await engine.start('collision-parent', null, {
      id: 'collision-parent',
    });
    await expect(collisionHandle.result()).rejects.toThrow(
      'Child workflow id collision for "shared-child" does not match the requested child workflow',
    );

    const unrelatedHandle = await engine.start('unrelated-parent', null, {
      id: 'unrelated-parent',
    });
    await expect(unrelatedHandle.result()).resolves.toEqual({ echoed: 'unrelated' });
  });

  it('Track 7c: ctx.map honors the concurrency limit while keeping input order', async () => {
    const engine = new TestEngine({ startTime: 0 });

    let activeChildren = 0;
    let maxActiveChildren = 0;

    const delayedStage = workflow({ name: 'delayed-stage' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      activeChildren++;
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
      yield* ctx.sleep('1s');
      activeChildren--;
      return Number(input) * 10;
    });

    engine.register(delayedStage);
    engine.register(
      workflow({ name: 'concurrency-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.map([1, 2, 3, 4, 5], 'delayed-stage', { concurrency: 2 });
      }),
    );

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

    const delayedStage = workflow({ name: 'delayed-stage' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      childRuns.push(Number(input));
      yield* ctx.sleep('1s');
      return Number(input) * 10;
    });

    const mapRecoveryParent = workflow({ name: 'map-recovery-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const mapped = yield* ctx.map([1, 2, 3], 'delayed-stage', { concurrency: 1 });
      yield* context.sleep('1s');
      return mapped;
    });

    engine.register(delayedStage);
    engine.register(mapRecoveryParent);

    const originalHandle = await engine.start('map-recovery-parent', null);

    await engine.advanceTime(0);
    await engine.advanceTime('1s');
    await engine.advanceTime('1s');
    await engine.advanceTime('1s');

    const recovered = engine.recover();
    recovered.register(delayedStage);
    recovered.register(mapRecoveryParent);

    await recovered.recoverAll();
    const resumedHandle = recovered.getHandle(originalHandle.id);
    await recovered.advanceTime('1s');

    await expect(resumedHandle.result()).resolves.toEqual([10, 20, 30]);
    expect(childRuns).toEqual([1, 2, 3]);
  });

  it('Track 7c: ctx.map still enforces child-workflow nesting depth inside parallel sub-operations', async () => {
    const engine = new Engine({ maxNestingDepth: 2 });

    engine.register(
      workflow({ name: 'recursive-map' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const { level } = input as { level: number };
        if (level < 3) {
          return yield* ctx.map([{ level: level + 1 }], 'recursive-map');
        }

        return [level];
      }),
    );

    const handle = await engine.start('recursive-map', { level: 0 });

    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('Track 7c: ctx.reduce folds sequentially and handles an empty array', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'fold-stage' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        const typedInput = input as WorkflowReduceInput<number, number>;
        return typedInput.accumulator + typedInput.item + typedInput.index;
      }),
    );
    engine.register(
      workflow({ name: 'reduce-parent' }).execute(async function* (ctx: WorkflowContext) {
        const folded = yield* ctx.reduce([4, 5, 6], 'fold-stage', 1, { idPrefix: 'fold-step' });
        const empty = yield* ctx.reduce([], 'fold-stage', 99);
        return { folded, empty };
      }),
    );

    const handle = await engine.start('reduce-parent', null);

    await expect(handle.result()).resolves.toEqual({
      folded: 19,
      empty: 99,
    });
  });

  it('Track 7c: nested composition works with ctx.pipe inside ctx.map', async () => {
    const engine = new TestEngine();

    const incrementStage = workflow({ name: 'increment-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return Number(input) + 1;
    });

    const wrapStage = workflow({ name: 'wrap-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return `value:${String(input)}`;
    });

    engine.register(incrementStage);
    engine.register(wrapStage);
    engine.register(
      workflow({ name: 'pipeline-item' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        return yield* ctx.pipe([{ type: 'increment-stage' }, { type: 'wrap-stage' }], input);
      }),
    );
    engine.register(
      workflow({ name: 'nested-parent' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.map([1, 2, 3], 'pipeline-item');
      }),
    );

    const handle = await engine.start('nested-parent', null);

    await expect(handle.result()).resolves.toEqual(['value:2', 'value:3', 'value:4']);
  });

  it('Track 7c: ctx.pipe rejects unregistered workflow functions even when the function name matches a registered type', async () => {
    const engine = new TestEngine();

    const registeredStage = workflow({ name: 'registered-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return String(input).toUpperCase();
    });

    // An unregistered bare function whose .name shadows a registered workflow.
    // The composition operator must reject it; matching by name is not enough.
    const imposterStage = async function* shadowStage(_ctx: WorkflowContext, input: unknown) {
      return `imposter:${String(input)}`;
    };
    Object.defineProperty(imposterStage, 'name', {
      value: 'registeredStage',
      configurable: true,
    });

    engine.register(registeredStage);
    engine.register(
      workflow({ name: 'pipe-parent' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        return yield* ctx.pipe([imposterStage], input);
      }),
    );

    const handle = await engine.start('pipe-parent', 'hello');

    await expect(handle.result()).rejects.toThrow(
      'Workflow functions used in composition operators must be registered before use.',
    );
  });

  it('Track 7c: empty ctx.map and ctx.reduce are side-effect free even for unregistered workflow functions', async () => {
    const engine = new TestEngine();

    const registeredStage = workflow({ name: 'registered-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return String(input).toUpperCase();
    });

    const imposterStage = async function* shadowStage(_ctx: WorkflowContext, input: unknown) {
      return `imposter:${String(input)}`;
    };
    Object.defineProperty(imposterStage, 'name', {
      value: 'registeredStage',
      configurable: true,
    });

    engine.register(registeredStage);
    engine.register(
      workflow({ name: 'composition-parent' }).execute(async function* (ctx: WorkflowContext) {
        const mapped = yield* ctx.map([], imposterStage);
        const reduced = yield* ctx.reduce([], imposterStage, 'seed');
        return { mapped, reduced };
      }),
    );

    const handle = await engine.start('composition-parent', null);

    await expect(handle.result()).resolves.toEqual({
      mapped: [],
      reduced: 'seed',
    });
  });

  it('Track 7c: child workflow reuse ignores plain-object key ordering in inputs', async () => {
    const engine = new TestEngine();

    const echoStage = workflow({ name: 'echo-stage' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return input;
    });

    engine.register(echoStage);
    engine.register(
      workflow({ name: 'same-execution-parent' }).execute(async function* (ctx: WorkflowContext) {
        const first = yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], {
          alpha: 1,
          beta: 2,
        });
        const second = yield* ctx.pipe([{ type: 'echo-stage', options: { id: 'shared-child' } }], {
          beta: 2,
          alpha: 1,
        });
        return { first, second };
      }),
    );

    const handle = await engine.start('same-execution-parent', null);
    await expect(handle.result()).resolves.toEqual({
      first: { alpha: 1, beta: 2 },
      second: { alpha: 1, beta: 2 },
    });
  });
});
