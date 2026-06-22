import { z } from 'zod';
import type {
  HttpClient,
  KnownWorkflowName as KnownWorkflowNameFromClientEntry,
  UnknownNameWhenRegistryEmpty as UnknownNameWhenRegistryEmptyFromClientEntry,
} from '../client/index.ts';
import {
  activity,
  Context,
  DevelopmentWarningEvent,
  durableActivity,
  Engine,
  ScheduleMissedFireEvent,
  signal,
  update,
  workflow,
  WorkflowStartedEvent,
  type ActivityCallable,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type ChildWorkflowHandle,
  type ClientHandle,
  type InferActivityEntry,
  type KnownWorkflowName,
  type LocalClient,
  type UnknownNameWhenRegistryEmpty,
  type WeftClient,
  type WorkflowConcurrencyOptions,
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

interface WelcomeServices {
  repository: {
    loadGreeting(name: string): Promise<string>;
  };
  log(message: string): void;
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
  | 'waitForUpdate'
  | 'workflowType';

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

const typedToolActivity = activity({
  name: 'typedTool',
  execute: async (input: { tool: string }) => ({ result: input.tool }),
});

async function sharedDurableActivityHelper(input: { tool: string }): Promise<void> {
  const byName = await durableActivity<{ result: string }>('typedTool', input, {
    idempotencyKey: `tool:${input.tool}`,
  });
  const byCallable = await durableActivity(typedToolActivity, input, {
    idempotencyKey: `callable:${input.tool}`,
  });
  const noInputActivity: ActivityCallable<void, number> = activity(async () => 42);
  const noInputResult = await durableActivity(noInputActivity);
  async function noInputBareTool(): Promise<number> {
    return 42;
  }
  const noInputBareResult = await durableActivity(noInputBareTool, {
    idempotencyKey: 'bare:no-input',
  });
  // @ts-expect-error typed ActivityCallable inputs must match the activity input type.
  await durableActivity(typedToolActivity, { missing: input.tool });

  void (byName satisfies { result: string });
  void (byCallable satisfies { result: string });
  void (noInputResult satisfies number);
  void (noInputBareResult satisfies number);
}
void sharedDurableActivityHelper;

// Activity names are now typed per-workflow via the builder's `.activities()`
// step. This replaces the global `ActivityTypes` module augmentation that the
// pre-builder era relied on.
const welcomeBuilder = workflow({ name: 'localWelcome' })
  .activities({
    formatGreeting: async (input: FormatGreetingInput) => `Hello, ${input.name}`,
  })
  .services<WelcomeServices>()
  .execute(async function* (ctx, input: WelcomeInput) {
    const services = ctx.services;
    if (services !== undefined) {
      const loadedGreeting = yield* ctx.run(async () =>
        services.repository.loadGreeting(input.name),
      );
      services.log(loadedGreeting);
      // @ts-expect-error declared workflow services expose only the declared members.
      services.missingClient;
    }
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
    const child: WelcomeOutput = yield* ctx.startChild<WelcomeOutput>('registered', input);
    const awaitedChild: WelcomeOutput = yield* ctx.startChild<WelcomeOutput>('registered', input, {
      parentClosePolicy: 'await',
    });
    const abandonedChild: ChildWorkflowHandle<WelcomeOutput> = yield* ctx.startChild<WelcomeOutput>(
      'registered',
      input,
      {
        parentClosePolicy: 'abandon',
      },
    );
    const requestCancelChild: ChildWorkflowHandle<WelcomeOutput> =
      yield* ctx.startChild<WelcomeOutput>('registered', input, {
        parentClosePolicy: 'request-cancel',
      });
    const detachedChildId: string = abandonedChild.id;
    const detachedResult = yield* ctx.startChild<WelcomeOutput>('registered', input, {
      parentClosePolicy: 'abandon',
    });
    // @ts-expect-error detached child workflow policies return handles, not child results.
    const invalidDetachedResult: WelcomeOutput = detachedResult;
    // @ts-expect-error only await, abandon, and request-cancel are valid parent-close policies.
    yield* ctx.startChild<WelcomeOutput>('registered', input, { parentClosePolicy: 'terminate' });
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
    // @ts-expect-error composition operators are await-only and cannot abandon child workflows.
    yield* ctx.pipe([{ type: 'registered', options: { parentClosePolicy: 'abandon' } }], input);
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
    void awaitedChild;
    void requestCancelChild;
    void detachedChildId;
    void invalidDetachedResult;

    return { greeting };
  });

const registered = workflow({ name: 'registered' }).execute(async function* (
  ctx: WorkflowContext,
  input: WelcomeInput,
) {
  return yield* ctx.run(async (value: WelcomeInput) => ({ greeting: value.name }), input);
});

declare const serviceContext: WorkflowContext<{}, {}, {}, {}, {}, WelcomeServices>;
void (serviceContext.services satisfies WelcomeServices | undefined);
if (serviceContext.services !== undefined) {
  void (serviceContext.services.repository.loadGreeting satisfies (
    name: string,
  ) => Promise<string>);
}

declare const defaultServicesContext: WorkflowContext;
void (defaultServicesContext.services satisfies unknown);
// @ts-expect-error default workflow services stay unknown until explicitly typed.
defaultServicesContext.services.repository;

// @ts-expect-error builder services can only be declared once before execute().
workflow({ name: 'duplicateServices' }).services<WelcomeServices>().services<WelcomeServices>();

const engine = new Engine().register(welcomeBuilder).register(registered);
declare const httpClient: HttpClient;
declare const sharedClient: WeftClient;

const typedConcurrency = {
  max: 2,
  key: (input) => input.name,
} satisfies WorkflowConcurrencyOptions<WelcomeInput>;
void workflow({ name: 'typedConcurrencyWelcome', concurrency: typedConcurrency });

async function verifyHandleTyping(): Promise<void> {
  const services: WelcomeServices = {
    repository: { loadGreeting: async (name) => `Hello, ${name}` },
    log: (_message) => {},
  };
  const handle = await engine.start('localWelcome', { name: 'Steve' }, { services });
  // @ts-expect-error start options must match the workflow's declared services shape.
  void engine.start('localWelcome', { name: 'Steve' }, { services: { repository: {} } });
  const serviceStartOptions = { services };
  const deferStartOptions = { defer: false };
  void httpClient.start('moduleAugmentedWelcome', { name: 'Steve' }, { id: 'remote-start' });
  // @ts-expect-error HttpClient cannot serialize inline-only workflow services.
  void httpClient.start('moduleAugmentedWelcome', { name: 'Steve' }, { services });
  // @ts-expect-error HttpClient also rejects service-bearing option variables.
  void httpClient.start('moduleAugmentedWelcome', { name: 'Steve' }, serviceStartOptions);
  // @ts-expect-error HttpClient also rejects inline-only defer option variables.
  void httpClient.start('moduleAugmentedWelcome', { name: 'Steve' }, deferStartOptions);
  // @ts-expect-error the shared WeftClient surface excludes inline-only workflow services.
  void sharedClient.start('moduleAugmentedWelcome', { name: 'Steve' }, { services });
  // @ts-expect-error shared WeftClient also rejects service-bearing option variables.
  void sharedClient.start('moduleAugmentedWelcome', { name: 'Steve' }, serviceStartOptions);
  // @ts-expect-error shared WeftClient also rejects inline-only defer option variables.
  void sharedClient.start('moduleAugmentedWelcome', { name: 'Steve' }, deferStartOptions);
  const typedHandle: WorkflowHandle<WelcomeOutput> = handle;
  const output = await handle.result();
  output.greeting.toUpperCase();
  void typedHandle;
}
void verifyHandleTyping;

function verifyEngineEventListenerTyping(): void {
  engine.addEventListener('workflow:completed', (event) => {
    const workflowId: string = event.workflowId;
    const duration: number = event.duration;
    const result: unknown = event.result;
    // @ts-expect-error completed workflow events do not carry an error.
    event.error;
    void workflowId;
    void duration;
    void result;
  });

  engine.addEventListener(WorkflowStartedEvent.type, (event) => {
    const workflowType: string = event.workflowType;
    const input: unknown = event.input;
    // @ts-expect-error started workflow events do not carry a completion duration.
    event.duration;
    void workflowType;
    void input;
  });

  engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
    const scheduleId: string = event.scheduleId;
    const missedCount: number = event.missedCount;
    const windowStart: number = event.windowStart;
    const windowEnd: number = event.windowEnd;
    // @ts-expect-error missed-fire events describe schedules, not workflow executions.
    event.workflowId;
    void scheduleId;
    void missedCount;
    void windowStart;
    void windowEnd;
  });

  const developmentWarningListener = (event: DevelopmentWarningEvent) => {
    const workflowId: string = event.workflowId;
    const fieldPaths: string[] = event.fieldPaths;
    void workflowId;
    void fieldPaths;
  };

  engine.addEventListener(DevelopmentWarningEvent.type, developmentWarningListener);
  engine.removeEventListener(DevelopmentWarningEvent.type, developmentWarningListener);

  engine.addEventListener('application:custom', (event) => {
    const eventType: string = event.type;
    // @ts-expect-error custom event strings fall back to the standard Event type.
    event.workflowId;
    void eventType;
  });
}
void verifyEngineEventListenerTyping;

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
declare const typedLocalClient: LocalClient;
declare const typedHttpClient: HttpClient;

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

async function verifyModuleAugmentedClientGetHandle(): Promise<void> {
  // Supplying the augmented workflow name as a type argument narrows the
  // re-attached handle's `result()` to that workflow's output type. The `id`
  // alone identifies the run, so no runtime workflow-type argument is required.
  const handle = await typedClient.getHandle<'moduleAugmentedWelcome'>('welcome-1');
  if (handle === null) return;

  const typedHandle: ClientHandle<WelcomeOutput> = handle;
  void typedHandle;

  const output = await handle.result();
  output.greeting.toUpperCase();
  const outputCheck: Equals<typeof output, WelcomeOutput> = true;
  void outputCheck;

  // Without a type argument, `result()` stays `unknown`.
  const untyped = await typedClient.getHandle('welcome-2');
  if (untyped === null) return;
  const untypedCheck: Equals<Awaited<ReturnType<typeof untyped.result>>, unknown> = true;
  void untypedCheck;
}
void verifyModuleAugmentedClientGetHandle;

// The overload reorder must hold on the CONCRETE client classes too — a caller
// typed directly as `LocalClient`/`HttpClient` (not the `WeftClient` interface)
// would otherwise hit the generic overload first and infer a union of all
// outputs instead of `unknown`. Pin both surfaces here.
async function verifyConcreteClientGetHandleStaysUnknown(): Promise<void> {
  const local = await typedLocalClient.getHandle('welcome-3');
  if (local === null) return;
  const localCheck: Equals<Awaited<ReturnType<typeof local.result>>, unknown> = true;
  void localCheck;

  const http = await typedHttpClient.getHandle('welcome-4');
  if (http === null) return;
  const httpCheck: Equals<Awaited<ReturnType<typeof http.result>>, unknown> = true;
  void httpCheck;
}
void verifyConcreteClientGetHandleStaysUnknown;

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
  // Recovery is the default: omitting `recover` (or passing `recover: undefined`)
  // is equivalent to `recover: true`, and the acknowledgement escape hatch is
  // valid in all of those forms.
  await Engine.create({});
  await Engine.create({ recover: undefined, acknowledgeUnknownWorkflowTypes: true });
  await Engine.create({ acknowledgeUnknownWorkflowTypes: true });
  await Engine.create({ recover: true, acknowledgeUnknownWorkflowTypes: true });
  await Engine.create({ recover: false });
  // @ts-expect-error unknown workflow acknowledgement is invalid when recovery is opted out.
  await Engine.create({ recover: false, acknowledgeUnknownWorkflowTypes: true });

  // Regression guard for #455: Engine.create({ workflows: {} }) must carry the
  // DefaultWorkflowRegistry brand — semantically identical to Engine.create
  // with no workflows map. The Equals check enforces exact type equality, not
  // mere assignability, so it catches any drift in branding.
  const absentWorkflows = await Engine.create({ recover: false });
  const emptyWorkflows = await Engine.create({ workflows: {}, recover: false });
  type AbsentType = typeof absentWorkflows;
  type EmptyMapType = typeof emptyWorkflows;
  const emptyEqualsAbsent: Equals<AbsentType, EmptyMapType> = true;
  void emptyEqualsAbsent;

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

  const serviceAwareEngine = await Engine.create({
    workflows: { localWelcome: welcomeBuilder },
    resolveWorkflowServices: () => ({
      status: 'available',
      services: {
        repository: { loadGreeting: async (name) => `Hello, ${name}` },
        log: (_message) => {},
      },
    }),
    recover: false,
  });
  void serviceAwareEngine.start(
    'localWelcome',
    { name: 'Steve' },
    {
      services: {
        repository: { loadGreeting: async (name) => `Hello, ${name}` },
        log: (_message) => {},
      },
    },
  );

  await Engine.create({
    workflows: { localWelcome: welcomeBuilder },
    // @ts-expect-error recovered services must satisfy the workflow's declared services type.
    resolveWorkflowServices: () => ({ status: 'available', services: { repository: {} } }),
    recover: false,
  });
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
