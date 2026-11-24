/**
 * Type-level assertions for `.uses({...})`: a used engine activity is typed
 * for `ctx.run('name', input)` exactly like a `.activities()` entry, in either
 * call order, and a second `.uses()` call is a type error.
 */

import { activity, workflow } from '../../index.ts';

const greet = activity({
  name: 'greet',
  execute: async (input: { name: string }): Promise<string> => `Hello, ${input.name}`,
});

const audit = activity({ name: 'audit', execute: async (): Promise<number> => 1 });

workflow({ name: 'uses-only' })
  .uses({ greet })
  .execute(async function* (ctx) {
    const greeting: string = yield* ctx.run('greet', { name: 'Ada' });
    // @ts-expect-error -- the used activity's input type is enforced.
    yield* ctx.run('greet', { name: 1 });
    // @ts-expect-error -- an undeclared activity name is not typed.
    yield* ctx.run('missing', {});
    return greeting;
  });

workflow({ name: 'uses-then-activities' })
  .uses({ greet })
  .activities({ local: async (value: number) => value * 2 })
  .execute(async function* (ctx) {
    const doubled: number = yield* ctx.run('local', 2);
    const greeting: string = yield* ctx.run('greet', { name: 'Ada' });
    return `${greeting}:${doubled}`;
  });

workflow({ name: 'activities-then-uses' })
  .activities({ local: async (value: number) => value * 2 })
  .uses({ audit })
  .execute(async function* (ctx) {
    const doubled: number = yield* ctx.run('local', 2);
    const audited: number = yield* ctx.run('audit');
    return doubled + audited;
  });

// @ts-expect-error -- `.uses()` may be called once.
workflow({ name: 'uses-twice' }).uses({ greet }).uses({ audit });
