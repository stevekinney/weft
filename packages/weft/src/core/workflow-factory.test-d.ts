// Type contracts for `createWorkflowFactory` and the merge semantics it gives
// the builder's chain methods. Every assertion is either an
// `Equals<actual, expected> = true` line or an `@ts-expect-error` on a line
// that must fail to compile.

import { Engine, type WorkflowHandle } from '../index.ts';
import { activity } from './types/activity.ts';
import { query, signal, update, type SignalDefinition } from './types/message-handles.ts';
import type { MergeMaps, NormalizeActivities } from './types/workflow-builder-helpers.ts';
import { workflow as plainWorkflow } from './types/workflow-function.ts';
import { createWorkflowFactory } from './workflow-factory.ts';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// ---------------------------------------------------------------------------
// MergeMaps — merging onto an empty map is the identity, so plain builders
// keep exactly the types they had before chain methods merged.
// ---------------------------------------------------------------------------

type Own = NormalizeActivities<{ shout: (text: string) => Promise<string> }>;
const _check_merge_identity: Equals<MergeMaps<{}, Own>, Own> = true;
const _check_merge_union: Equals<MergeMaps<{ a: 1 }, { b: 2 }>, { a: 1; b: 2 }> = true;
// A wide map on either side is intersected, so neither side's entries are lost.
const _check_merge_wide: Equals<
  MergeMaps<Record<string, 1>, { b: 2 }>,
  Record<string, 1> & { b: 2 }
> = true;
// Both wide: a wide map of either side's value, not an intersection of the two.
const _check_merge_both_wide: Equals<
  MergeMaps<Record<string, 1>, Record<string, 2>>,
  Record<string, 1 | 2>
> = true;
void _check_merge_both_wide;
void _check_merge_identity;
void _check_merge_union;
void _check_merge_wide;

const plain = plainWorkflow({ name: 'plain' })
  .activities({ shout: async (text: string) => text.toUpperCase() })
  .execute(async function* (ctx, text: string) {
    return yield* ctx.run('shout', text);
  });
const _check_plain_activities: Equals<NonNullable<typeof plain._activities>, Own> = true;
void _check_plain_activities;

// ---------------------------------------------------------------------------
// Shared entries are typed in every workflow the factory builds.
// ---------------------------------------------------------------------------

const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
const audit = activity({ name: 'audit', execute: async () => 'audited' });
const approve = signal<{ approverId: string }>('approve');

const factory = createWorkflowFactory({
  activities: { greet },
  signals: { approve },
  updates: { rename: update<string, boolean>('rename') },
  queries: { progress: query<void, number>('progress') },
});
const { workflow } = factory;

const _check_factory_activities: Equals<
  typeof factory.activities,
  Readonly<{ greet: typeof greet }>
> = true;
void _check_factory_activities;

const welcome = workflow({ name: 'welcome' }).execute(async function* (ctx, name: string) {
  const greeting = yield* ctx.run('greet', name);
  const _check_greeting: Equals<typeof greeting, string> = true;
  void _check_greeting;

  // @ts-expect-error — `greet` takes a string.
  yield* ctx.run('greet', 42);

  const decision = yield* ctx.waitForSignal('approve');
  const _check_signal: Equals<typeof decision, { approverId: string }> = true;
  void _check_signal;

  const renamed = yield* ctx.waitForUpdate('rename');
  const _check_update: Equals<typeof renamed.payload, string> = true;
  void _check_update;
  renamed.respond(true);

  ctx.onQuery('progress', () => 0.5);

  return { greeting, approverId: decision.approverId };
});

const _check_welcome_name: Equals<typeof welcome.name, 'welcome'> = true;
void _check_welcome_name;

// ---------------------------------------------------------------------------
// A workflow's own entries merge with the shared ones.
// ---------------------------------------------------------------------------

const merged = workflow({ name: 'merged' })
  .activities({ shout: async (text: string) => text.toUpperCase() })
  .uses({ audit })
  .signals({ reject: signal<{ reason: string }>('reject') })
  .execute(async function* (ctx, name: string) {
    const greeting = yield* ctx.run('greet', name);
    const shouted = yield* ctx.run('shout', greeting);
    const audited = yield* ctx.run('audit');
    const _check_shouted: Equals<typeof shouted, string> = true;
    const _check_audited: Equals<typeof audited, string> = true;
    void _check_shouted;
    void _check_audited;

    const approval = yield* ctx.waitForSignal('approve');
    const rejection = yield* ctx.waitForSignal('reject');
    const _check_approval: Equals<typeof approval, { approverId: string }> = true;
    const _check_rejection: Equals<typeof rejection, { reason: string }> = true;
    void _check_approval;
    void _check_rejection;
    return shouted;
  });

const _check_merged_activities: Equals<
  keyof NonNullable<typeof merged._activities>,
  'greet' | 'shout' | 'audit'
> = true;
const _check_merged_signals: Equals<
  keyof NonNullable<typeof merged._signals>,
  'approve' | 'reject'
> = true;
void _check_merged_activities;
void _check_merged_signals;

// Additions held in a wide map type keep the shared entries' types.
declare const wideSignals: Record<string, SignalDefinition<{ reason: string }>>;
declare const wideActivities: Record<string, (text: string) => Promise<number>>;
workflow({ name: 'wide' })
  .signals(wideSignals)
  .activities(wideActivities)
  .execute(async function* (ctx, name: string) {
    const greeting = yield* ctx.run('greet', name);
    const _check_wide_greeting: Equals<typeof greeting, string> = true;
    void _check_wide_greeting;
    const approval = yield* ctx.waitForSignal('approve');
    const _check_wide_approval: Equals<typeof approval, { approverId: string }> = true;
    void _check_wide_approval;
    return greeting;
  });

// A factory whose shared maps have wide types keeps them after a local addition.
declare const wideShared: Record<string, typeof greet>;
declare const wideSharedSignals: Record<string, SignalDefinition<{ approverId: string }>>;
createWorkflowFactory({ activities: wideShared, signals: wideSharedSignals })
  .workflow({ name: 'wide-shared' })
  .activities({ shout: async (text: string) => text.toUpperCase() })
  .uses({ audit })
  .signals({ reject: signal<{ reason: string }>('reject') })
  .execute(async function* (ctx, name: string) {
    const greeting = yield* ctx.run('greet', name);
    const _check_wide_shared_greeting: Equals<typeof greeting, string> = true;
    void _check_wide_shared_greeting;
    const shouted = yield* ctx.run('shout', greeting);
    const approval = yield* ctx.waitForSignal('approve');
    const _check_wide_shared_approval: Equals<typeof approval, { approverId: string }> = true;
    void _check_wide_shared_approval;
    return shouted;
  });

// Both wide with different entry types: each name runs with either side's
// arguments and result, never an unsatisfiable intersection of them.
declare const wideNumbers: Record<string, (value: number) => Promise<number>>;
createWorkflowFactory({ activities: wideShared })
  .workflow({ name: 'both-wide' })
  .activities(wideNumbers)
  .execute(async function* (ctx) {
    const fromShared = yield* ctx.run('greet', 'Ada');
    const fromLocal = yield* ctx.run('double', 2);
    const _check_both_wide_shared: Equals<typeof fromShared, string | number> = true;
    const _check_both_wide_local: Equals<typeof fromLocal, string | number> = true;
    void _check_both_wide_shared;
    void _check_both_wide_local;
    return 0;
  });

// ---------------------------------------------------------------------------
// Conflicting names are rejected, and each chain method is still once-only.
// ---------------------------------------------------------------------------

workflow({ name: 'conflict' })
  // @ts-expect-error — `greet` is already declared by the factory.
  .activities({ greet: async (name: string) => name });

workflow({ name: 'conflict' })
  // @ts-expect-error — `greet` is already declared by the factory.
  .uses({ greet });

workflow({ name: 'conflict' })
  // @ts-expect-error — `approve` is already declared by the factory.
  .signals({ approve });

workflow({ name: 'conflict' })
  // @ts-expect-error — `rename` is already declared by the factory.
  .updates({ rename: update<string, boolean>('rename') });

workflow({ name: 'conflict' })
  // @ts-expect-error — `progress` is already declared by the factory.
  .queries({ progress: query<void, number>('progress') });

// The same rule holds on a plain builder: one name, one place.
plainWorkflow({ name: 'both' })
  .uses({ greet })
  // @ts-expect-error — `greet` is already declared with `.uses()`.
  .activities({ greet: async (name: string) => name });

workflow({ name: 'once' })
  .activities({ shout: async (text: string) => text })
  // @ts-expect-error — `.activities()` is once-only, factory or not.
  .activities({ whisper: async (text: string) => text });

// ---------------------------------------------------------------------------
// createEngine registers the workflows and the shared activities in one call.
// ---------------------------------------------------------------------------

async function assertCreateEngineTypesFactoryWorkflows(): Promise<void> {
  const engine = await factory.createEngine({
    workflows: { welcome, merged },
    activities: { audit },
  });
  const welcomeHandle: WorkflowHandle<{ greeting: string; approverId: string }> =
    await engine.start('welcome', 'Ada');
  const mergedHandle: WorkflowHandle<string> = await engine.start('merged', 'Grace');
  // @ts-expect-error — `merged` takes a string.
  await engine.start('merged', 42);
  const _check_engine: Equals<
    typeof engine extends Engine<infer _W, infer TActivities> ? keyof TActivities : never,
    'greet' | 'audit'
  > = true;
  void _check_engine;
  void welcomeHandle;
  void mergedHandle;
}
void assertCreateEngineTypesFactoryWorkflows;
