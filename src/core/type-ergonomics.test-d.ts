import { z } from 'zod';
import type {
  KnownWorkflowName as KnownWorkflowNameFromClientEntry,
  UnknownNameWhenRegistryEmpty as UnknownNameWhenRegistryEmptyFromClientEntry,
} from '../client/index.ts';
import {
  activity,
  Context,
  Engine,
  signal,
  update,
  workflow,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type ClientHandle,
  type InferActivityEntry,
  type KnownWorkflowName,
  type UnknownNameWhenRegistryEmpty,
  type WeftClient,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowHandle,
} from '../index.ts';

interface WelcomeInput {
  name: string;
}

interface WelcomeOutput {
  greeting: string;
}

interface FormatGreetingInput {
  name: string;
}

declare module '../index.ts' {
  interface WorkflowRegistry {
    // Module-augmented workflow name covers the case where a downstream
    // project augments `WorkflowRegistry` via `weft codegen` output. The
    // engine that exercises this name is constructed at module scope below
    // — we use a name distinct from any `engine.register(...)` call so the
    // builder's `WorkflowAlreadyRegistered` brand does not intersect.
    moduleAugmentedWelcome: { input: WelcomeInput; output: WelcomeOutput };
  }
}

type RequiredWorkflowContextKeys =
  | 'all'
  | 'archive'
  | 'expose'
  | 'getAttribute'
  | 'getAttributes'
  | 'review'
  | 'load'
  | 'map'
  | 'memo'
  | 'offload'
  | 'onQuery'
  | 'onUpdate'
  | 'pipe'
  | 'race'
  | 'reduce'
  | 'run'
  | 'runAll'
  | 'saga'
  | 'setAttribute'
  | 'setAttributes'
  | 'sleep'
  | 'startChild'
  | 'state'
  | 'stream'
  | 'streamUrl'
  | 'suspendUntil'
  | 'waitForSignal'
  | 'waitForUpdate';

type MissingWorkflowContextKeys = Exclude<RequiredWorkflowContextKeys, keyof WorkflowContext>;
type AssertNever<T extends never> = T;
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

const workflowContextDriftGuard: AssertNever<MissingWorkflowContextKeys> = undefined as never;
void workflowContextDriftGuard;
const concreteContextContractGuard: Context extends WorkflowContext ? true : never = true;
void concreteContextContractGuard;

const approvalSignal = signal<{ approved: boolean }>('approval');
const setNameUpdate = update<{ name: string }, string>('set-name');

// Activity names are now typed per-workflow via the builder's `.activities()`
// step. This replaces the global `ActivityTypes` module augmentation that the
// pre-builder era relied on.
const welcomeBuilder = workflow({ name: 'localWelcome' })
  .activities({
    formatGreeting: async (input: FormatGreetingInput) => `Hello, ${input.name}`,
  })
  .execute(async function* (ctx, input: WelcomeInput) {
    const greeting = yield* ctx.run('formatGreeting', { name: input.name });
    // @ts-expect-error builder-typed activities must match their declared input type.
    yield* ctx.run('formatGreeting', { id: 'wrong' });
    // @ts-expect-error builder-typed activity names must be present in `.activities()`.
    yield* ctx.run('runtimeFormatGreeting', { name: input.name });
    const signalPayload = yield* ctx.waitForSignal<{ approved: boolean }>('approval');
    const typedSignalPayload: { approved: boolean } = yield* ctx.waitForSignal(approvalSignal);
    const updatePayload = yield* ctx.waitForUpdate<{ suffix: string }>('rename');
    ctx.onUpdate(setNameUpdate, (payload) => payload.name);
    ctx.onQuery('greeting', () => greeting);
    ctx.expose({ greeting: () => greeting });
    ctx.setAttribute('customer', input.name);
    const customer = ctx.getAttribute<string>('customer');
    const attributes = ctx.getAttributes();
    const child = yield* ctx.startChild<WelcomeOutput>('registered', input);
    // @ts-expect-error child workflow options are closed to fields the engine reads.
    yield* ctx.startChild<WelcomeOutput>('registered', input, { unknownOption: true });
    const parallel = yield* ctx.all([ctx.run('formatGreeting', input), ctx.sleep(1)]);
    const typedParallel: [string, void] = parallel;
    const raced = yield* ctx.race([ctx.run('formatGreeting', input)]);
    const typedRace: string | number = yield* ctx.race([
      ctx.run('formatGreeting', input),
      ctx.run(async () => 42),
    ]);
    const offloadReference = yield* ctx.offload('welcome-output', async () => child);
    const loaded = yield* ctx.load<WelcomeOutput>(offloadReference);
    yield* ctx.archive('welcome-output', loaded);
    const streamReference = yield* ctx.stream('welcome-stream', async function* () {});
    const streamUrl = ctx.streamUrl(streamReference);
    const mapped = yield* ctx.map([input], 'registered');
    const reduced = yield* ctx.reduce([input], 'registered', { greeting: '' });
    const memoized = yield* ctx.memo('memo-key', () => input.name);
    const runAllResult = yield* ctx.runAll({
      formatGreeting: [async (value: WelcomeInput) => value.name, input],
      count: [async () => 42],
    });
    const typedRunAllResult: { formatGreeting: string; count: number } = runAllResult;
    const sagaResult = yield* ctx.saga<WelcomeOutput>([]);
    const session = ctx.state.session('name', { initial: input.name });

    void signalPayload;
    void typedSignalPayload;
    void updatePayload;
    void customer;
    void attributes;
    void typedParallel;
    void raced;
    void typedRace;
    void streamUrl;
    void mapped;
    void reduced;
    void memoized;
    void typedRunAllResult;
    void sagaResult;
    void session;

    return { greeting };
  });

const registered = workflow({ name: 'registered' }).execute(async function* (
  ctx: WorkflowContext,
  input: WelcomeInput,
) {
  return yield* ctx.run(async (value: WelcomeInput) => ({ greeting: value.name }), input);
});

const engine = new Engine().register(welcomeBuilder).register(registered);

async function verifyHandleTyping(): Promise<void> {
  const handle = await engine.start('localWelcome', { name: 'Steve' });
  const typedHandle: WorkflowHandle<WelcomeOutput> = handle;
  const output = await handle.result();
  output.greeting.toUpperCase();
  void typedHandle;
}
void verifyHandleTyping;

// Module-augmented workflow names typecheck on `start` even when no
// `register(...)` call was made — the augmentation is the source of truth.
async function verifyModuleAugmentedStart(): Promise<void> {
  // @ts-expect-error start input must match the module-augmented input type.
  void engine.start('moduleAugmentedWelcome', { id: 'wrong' });
  const handle = await engine.start('moduleAugmentedWelcome', { name: 'Grace' });
  void handle;
}
void verifyModuleAugmentedStart;

// @ts-expect-error workflow names must be present in the augmented registry or registered.
void engine.start('runtime-discovered', { id: 'dynamic' });

// The same module augmentation (the surface `weft codegen` emits) also types
// the CLIENT. A `WeftClient` narrows `start`/`schedule` input to the
// augmented workflow's input type and the returned handle's `result()` to its
// output type — proving per-workflow typed client methods, not just engine
// methods, flow from the generated `WorkflowRegistry` declaration.
declare const typedClient: WeftClient;

async function verifyModuleAugmentedClientStart(): Promise<void> {
  // @ts-expect-error client start input must match the module-augmented input type.
  void typedClient.start('moduleAugmentedWelcome', { id: 'wrong' });

  const handle = await typedClient.start('moduleAugmentedWelcome', { name: 'Grace' });

  // The handle is parameterized by the augmented workflow's output type.
  const typedHandle: ClientHandle<WelcomeOutput> = handle;
  void typedHandle;

  const output = await handle.result();
  // `result()` resolves to the augmented output type, so property access is safe.
  output.greeting.toUpperCase();
  const outputCheck: Equals<typeof output, WelcomeOutput> = true;
  void outputCheck;
}
void verifyModuleAugmentedClientStart;

async function verifyModuleAugmentedClientSchedule(): Promise<void> {
  // @ts-expect-error client schedule input must match the module-augmented input type.
  void typedClient.schedule('moduleAugmentedWelcome', { id: 'wrong' }, '0 9 * * 1');
  await typedClient.schedule('moduleAugmentedWelcome', { name: 'Grace' }, '0 9 * * 1');
}
void verifyModuleAugmentedClientSchedule;

// Regression guard for the review finding: the helper types that appear in the
// public `WeftClient.start`/`schedule` overload signatures must be importable
// by consumers from the same public specifiers that expose `WeftClient`. They
// are re-exported from both `weft` (this file's `../index.ts`) and
// `@lostgradient/weft/client` (`../client/index.ts`); if either re-export is dropped, the
// imports above stop resolving and this file fails to typecheck. The aliases
// must also resolve to the same type from both entrypoints — a single source
// of truth, not two divergent declarations.
type KnownWorkflowNameEntrypointsAgree = Equals<
  KnownWorkflowName,
  KnownWorkflowNameFromClientEntry
>;
type UnknownNameEntrypointsAgree = Equals<
  UnknownNameWhenRegistryEmpty<'unknown-name'>,
  UnknownNameWhenRegistryEmptyFromClientEntry<'unknown-name'>
>;
const knownWorkflowNameEntrypointsAgree: KnownWorkflowNameEntrypointsAgree = true;
const unknownNameEntrypointsAgree: UnknownNameEntrypointsAgree = true;
void knownWorkflowNameEntrypointsAgree;
void unknownNameEntrypointsAgree;

// Because `WorkflowRegistry` is module-augmented above, `KnownWorkflowName`
// resolves to a non-empty union (the augmented name is assignable) and the
// permissive `UnknownNameWhenRegistryEmpty<TName>` gate collapses to `never`,
// matching the engine's `UnknownWorkflowNameWhenDefaultRegistryIsEmpty` gate.
const augmentedNameIsKnown: 'moduleAugmentedWelcome' extends KnownWorkflowName ? true : never =
  true;
const registryEmptyGateIsClosed: Equals<UnknownNameWhenRegistryEmpty<'anything'>, never> = true;
void augmentedNameIsKnown;
void registryEmptyGateIsClosed;

// Activity name brand-rejection at the `engine.register` boundary was
// intentionally removed when the global `ActivityTypes` augmentation went
// away: activity-name typing now lives on the per-workflow builder's
// `.activities()` step (see the `// @ts-expect-error builder-typed activity
// names must be present in `.activities()`.` assertion above). There is no
// equivalent engine-level rejection to test; the builder-level rejection
// covers the same architectural goal.

const localGreet = workflow({ name: 'localGreet' }).execute(async function* (
  _ctx: WorkflowContext,
  input: string,
) {
  yield;
  return `Hello, ${input}`;
});

const schemaDefinedWorkflow = workflow({
  name: 'schemaDefinedWorkflow',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
}).execute(async function* (_ctx, input: { id: string }) {
  const _inputCheck: Equals<typeof input, { id: string }> = true;
  void _inputCheck;
  yield;
  return { ok: true };
});

const concreteWorkflow: WorkflowDefinition<string, string, 'concreteWorkflow'> = workflow({
  name: 'concreteWorkflow',
}).execute(async function* (_ctx: WorkflowContext, input: string) {
  yield;
  return input.toUpperCase();
});

const sendEmail = activity({
  name: 'sendEmail',
  execute: async (input: { to: string }) => {
    void input.to;
  },
});

const zeroInputActivity = activity({
  name: 'zeroInputActivity',
  execute: async () => 'pong',
});

const explicitEmptyEngine = new Engine<{}, {}>();
// @ts-expect-error explicit empty workflow registries reject unknown workflow starts.
void explicitEmptyEngine.start('notRegistered', null);
// @ts-expect-error explicit empty activity registries reject name-based activity registration.
explicitEmptyEngine.registerActivity('notRegisteredActivity', async () => 'not registered');

const strictLocalEngine = new Engine<{}, {}>()
  .register(localGreet)
  .register(concreteWorkflow)
  .register(schemaDefinedWorkflow)
  .register(sendEmail)
  .register(zeroInputActivity);

void strictLocalEngine.start('localGreet', 'Steve');
void strictLocalEngine.start('concreteWorkflow', 'Steve');
void strictLocalEngine.start('schemaDefinedWorkflow', { id: 'wf-1' });
// @ts-expect-error strict local engines reject workflow names not added by register().
void strictLocalEngine.start('unknownLocalWorkflow', 'Steve');
// @ts-expect-error localGreet input is inferred from the workflow definition.
void strictLocalEngine.start('localGreet', { id: 'wrong' });

type ZeroInputActivityEntry = InferActivityEntry<typeof zeroInputActivity>;
const zeroInputCallable: ZeroInputActivityEntry['zeroInputActivity'] = async () => 'pong';
void zeroInputCallable();
// @ts-expect-error zero-input activity entries must stay zero-argument.
void zeroInputCallable('unexpected');

async function verifyEngineCreateInference(): Promise<void> {
  // No definition maps: the engine carries the module-augmented
  // `WorkflowRegistry` for workflow names but starts with an empty activity
  // map. Activity names enter the type system only via builder
  // `.activities({...})` calls or `Engine.create({ activities })`.
  const neither = await Engine.create({ recover: false });
  void neither.start('moduleAugmentedWelcome', { name: 'Steve' });
  // @ts-expect-error no definition maps means only module-augmented workflows are available.
  void neither.start('localGreet', 'Steve');
  await Engine.create({ recover: true, acknowledgeUnknownWorkflowTypes: true });
  await Engine.create({ recover: true, requireConcurrentResumeSafety: true });
  // @ts-expect-error unknown workflow acknowledgement only applies when recovery runs.
  await Engine.create({ acknowledgeUnknownWorkflowTypes: true });
  // @ts-expect-error concurrent resume safety only applies when recovery runs.
  await Engine.create({ requireConcurrentResumeSafety: true });
  // @ts-expect-error unknown workflow acknowledgement only applies when recovery runs.
  await Engine.create({ recover: false, acknowledgeUnknownWorkflowTypes: true });
  // @ts-expect-error concurrent resume safety only applies when recovery runs.
  await Engine.create({ recover: false, requireConcurrentResumeSafety: true });

  // workflows-only narrows TWorkflows to the inferred map keys; activities
  // stay empty until added explicitly.
  const workflowsOnly = await Engine.create({
    workflows: { localGreet },
    recover: false,
  });
  void workflowsOnly.start('localGreet', 'Steve');
  // @ts-expect-error workflow names not in the map are rejected.
  void workflowsOnly.start('missingFromWorkflowMap', 'Steve');

  // activities-only mirrors workflows-only: TWorkflows keeps the
  // module-augmented registry, TActivities narrows to the inferred map.
  const activitiesOnly = await Engine.create({
    activities: { sendEmail },
    recover: false,
  });
  void activitiesOnly.start('moduleAugmentedWelcome', { name: 'Steve' });
  // @ts-expect-error activity maps do not add workflow names.
  void activitiesOnly.start('localGreet', 'Steve');

  const both = await Engine.create({
    workflows: { localGreet, concreteWorkflow, schemaDefinedWorkflow },
    activities: { sendEmail, zeroInputActivity },
    recover: false,
  });
  void both.start('localGreet', 'Steve');
  void both.start('concreteWorkflow', 'Steve');
  void both.start('schemaDefinedWorkflow', { id: 'wf-1' });
  // @ts-expect-error Engine.create infers names from the definition map keys.
  void both.start('missingFromBothMap', 'Steve');

  // Regression guard for the recover-then-register pattern that
  // `Engine.create({ storage, recover: false })` is documented to support:
  // deferred names must flow through the explicit registration API so the typed
  // view records the additional workflow before it is started.
  const deferredRegistration = await Engine.create({ recover: false });
  const deferredRegistrationWithWorkflow = deferredRegistration.register(localGreet);
  void deferredRegistrationWithWorkflow.start('localGreet', 'Steve');
}
void verifyEngineCreateInference;

// @ts-expect-error registerActivity has been collapsed into register().
engine.registerActivity('formatGreeting', async (input: FormatGreetingInput) => {
  return `Hello, ${input.name}`;
});

// @ts-expect-error withWorkflow has been collapsed into register().
engine.withWorkflow(localGreet);

// @ts-expect-error withActivity has been collapsed into register().
engine.withActivity(sendEmail);

// Variance regression detector — reverting `AnyWorkflowDefinition` /
// `AnyActivityDefinition` to `WorkflowDefinition<unknown, unknown>` /
// `ActivityDefinition<unknown, unknown>` (i.e. removing the `never` in the
// input position) makes these assignments fail to compile, because
// `WorkflowFunction<{ id: string }, ...>` is not assignable to
// `WorkflowFunction<unknown, ...>` under strict function-parameter
// contravariance. Direct assignment is the load-bearing test: it succeeds
// today because `AnyWorkflowDefinition` uses `never` in the input position.
const _narrowInputWorkflowGuard: AnyWorkflowDefinition = workflow({
  name: 'narrowInputGuard',
}).execute(async function* (_ctx, _input: { strict: true }) {
  yield;
  return 1;
});
void _narrowInputWorkflowGuard;

const _narrowInputActivityGuard: AnyActivityDefinition = activity({
  name: 'narrowInputActivityGuard',
  execute: async (input: { strict: true; payload: number }) => input.payload,
});
void _narrowInputActivityGuard;

// Smoke-test for zero-input activities. A zero-argument function is
// assignable to most function types regardless of constraint variance, so
// this guard is not the contravariance regression detector — it pins that
// the constraint shape continues to accept the no-input case after future
// edits to AnyActivityDefinition.
const _zeroInputActivityGuard: AnyActivityDefinition = activity({
  name: 'zeroInputActivityGuard',
  execute: async () => 'ok',
});
void _zeroInputActivityGuard;
