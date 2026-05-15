import { z } from 'zod';
import {
  activity,
  Context,
  Engine,
  signal,
  update,
  workflow,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type InferActivityEntry,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowHandle,
  type WorkflowRegistration,
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
    welcome: { input: WelcomeInput; output: WelcomeOutput };
    registered: { input: WelcomeInput; output: WelcomeOutput };
  }

  interface ActivityTypes {
    formatGreeting: (input: FormatGreetingInput) => Promise<string>;
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

const engine = new Engine();
const approvalSignal = signal<{ approved: boolean }>('approval');
const setNameUpdate = update<{ name: string }, string>('set-name');

engine.register('welcome', async function* (ctx: WorkflowContext, input: WelcomeInput) {
  const greeting = yield* ctx.run('formatGreeting', { name: input.name });
  // @ts-expect-error string-name activities must match their augmented input type.
  yield* ctx.run('formatGreeting', { id: 'wrong' });
  // @ts-expect-error string-name activities must be present in the augmented registry.
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

const registration: WorkflowRegistration<WelcomeInput, WelcomeOutput> = {
  handler: async function* (ctx: WorkflowContext, input: WelcomeInput) {
    return yield* ctx.run(async (value: WelcomeInput) => ({ greeting: value.name }), input);
  },
};
engine.register('registered', registration);

engine.register(
  activity({
    name: 'formatGreeting',
    execute: async (input: FormatGreetingInput) => {
      return `Hello, ${input.name}`;
    },
  }),
);

engine.register(
  // @ts-expect-error registered activities must match their augmented input type.
  activity({ name: 'formatGreeting', execute: async (input: { id: string }) => input.id }),
);

// @ts-expect-error registered activity names must be present in the augmented registry.
engine.registerActivity('runtimeFormatGreeting', async (input: FormatGreetingInput) => {
  return `Hello, ${input.name}`;
});

async function verifyHandleTyping(): Promise<void> {
  const handle = await engine.start('welcome', { name: 'Steve' });
  const typedHandle: WorkflowHandle<WelcomeOutput> = handle;
  const output = await handle.result();
  output.greeting.toUpperCase();
  void typedHandle;
}
void verifyHandleTyping;

// @ts-expect-error start input must match the augmented workflow input type.
void engine.start('welcome', { id: 'wrong' });

// @ts-expect-error workflow names must be present in the augmented registry.
void engine.start('runtime-discovered', { id: 'dynamic' });

// @ts-expect-error workflow registration names must be present in the augmented registry.
engine.register('runtime-discovered', async () => {
  return 'dynamic';
});

const localGreet = workflow({
  name: 'localGreet',
  handler: async function* (_ctx: WorkflowContext, input: string) {
    yield;
    return `Hello, ${input}`;
  },
});

const schemaDefinedWorkflow = workflow({
  name: 'schemaDefinedWorkflow',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async function* (_ctx, input) {
    const _inputCheck: Equals<typeof input, { id: string }> = true;
    void _inputCheck;
    yield;
    return { ok: true };
  },
});

const concreteWorkflow: WorkflowDefinition<string, string, 'concreteWorkflow'> = workflow({
  name: 'concreteWorkflow',
  handler: async function* (_ctx: WorkflowContext, input: string) {
    yield;
    return input.toUpperCase();
  },
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
// @ts-expect-error explicit empty workflow registries reject name-based workflow registration.
explicitEmptyEngine.register('notRegistered', async function* () {
  yield;
  return 'not registered';
});
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
  // No definition maps: the engine uses the module-augmented
  // WorkflowRegistry / ActivityTypes, without the old dynamic-name fallback.
  const neither = await Engine.create({ recover: false });
  void neither.start('welcome', { name: 'Steve' });
  // @ts-expect-error no definition maps means only module-augmented workflows are available.
  void neither.start('localGreet', 'Steve');
  await Engine.create({ recover: true, acknowledgeUnknownWorkflowTypes: true });
  // @ts-expect-error unknown workflow acknowledgement only applies when recovery runs.
  await Engine.create({ acknowledgeUnknownWorkflowTypes: true });
  // @ts-expect-error unknown workflow acknowledgement only applies when recovery runs.
  await Engine.create({ recover: false, acknowledgeUnknownWorkflowTypes: true });

  // workflows-only narrows TWorkflows to the inferred map keys; activities
  // fall back to the module-augmented registry.
  const workflowsOnly = await Engine.create({
    workflows: { localGreet },
    recover: false,
  });
  void workflowsOnly.start('localGreet', 'Steve');
  // @ts-expect-error workflow names not in the map are rejected.
  void workflowsOnly.start('missingFromWorkflowMap', 'Steve');

  // activities-only mirrors workflows-only: TWorkflows keeps the
  // module-augmented registry,
  // TActivities narrows to the inferred map.
  const activitiesOnly = await Engine.create({
    activities: { sendEmail },
    recover: false,
  });
  void activitiesOnly.start('welcome', { name: 'Steve' });
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
  handler: async function* (_ctx, _input: { strict: true }) {
    yield;
    return 1;
  },
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
