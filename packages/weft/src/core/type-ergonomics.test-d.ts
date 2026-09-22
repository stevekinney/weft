import {
  activity,
  Context,
  durableActivity,
  Engine,
  signal,
  update,
  workflow,
  type ActivityCallable,
  type ChildWorkflowHandle,
  type WorkflowConcurrencyOptions,
  type WorkflowContext,
} from '../index.ts';

export interface WelcomeInput {
  name: string;
}

export interface WelcomeOutput {
  greeting: string;
}

export interface FormatGreetingInput {
  name: string;
}

export interface WelcomeServices {
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
    //
    // `revision`/`workflowVersion` mirror what `weft codegen` now actually
    // generates (string-literal fields alongside `input`/`output`) — their
    // presence here proves `WorkflowInput`/`WorkflowOutput` still narrow
    // correctly through extra fields on the registry entry, and that
    // `engine.start`/`.result()` need no caller-supplied revision.
    moduleAugmentedWelcome: {
      input: WelcomeInput;
      output: WelcomeOutput;
      revision: 'sha256:module-augmented-welcome';
      workflowVersion: '1.0.0';
    };
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
export type Equals<X, Y> =
  (<T>(value: T) => T extends X ? 1 : 2) extends <T>(value: T) => T extends Y ? 1 : 2
    ? true
    : false;

declare const workflowContextDriftGuard: AssertNever<MissingWorkflowContextKeys>;
void workflowContextDriftGuard;
const concreteContextContractGuard: Context extends WorkflowContext ? true : never = true;
void concreteContextContractGuard;

const approvalSignal = signal<{ approved: boolean }>('approval');
const setNameUpdate = update<{ name: string }, string>('set-name');

const typedToolActivity = activity({
  name: 'typedTool',
  execute: async (input: { tool: string }) => ({ result: input.tool }),
});

async function noInputBareTool(): Promise<number> {
  return 42;
}

async function sharedDurableActivityHelper(input: { tool: string }): Promise<void> {
  const byName = await durableActivity<{ result: string }>('typedTool', input, {
    idempotencyKey: `tool:${input.tool}`,
  });
  const byCallable = await durableActivity(typedToolActivity, input, {
    idempotencyKey: `callable:${input.tool}`,
  });
  const noInputActivity: ActivityCallable<void, number> = activity(async () => 42);
  const noInputResult = await durableActivity(noInputActivity);
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
export const welcomeBuilder = workflow({ name: 'localWelcome' })
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
      void services.missingClient;
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
    const keyedRace = yield* ctx.raceKeyed({
      greeting: ctx.run('formatGreeting', input),
      count: ctx.run(async () => 42),
    });
    if (keyedRace.key === 'greeting') {
      const greetingWinner: string = keyedRace.value;
      // @ts-expect-error the greeting branch cannot produce a number.
      const invalidGreetingWinner: number = keyedRace.value;
      void greetingWinner;
      void invalidGreetingWinner;
    } else {
      const countWinner: number = keyedRace.value;
      // @ts-expect-error the count branch cannot produce a string.
      const invalidCountWinner: string = keyedRace.value;
      void countWinner;
      void invalidCountWinner;
    }
    const numericKeyedRace = yield* ctx.raceKeyed({
      0: ctx.run('formatGreeting', input),
      1: ctx.run(async () => 42),
    });
    if (numericKeyedRace.key === '0') {
      const greetingWinner: string = numericKeyedRace.value;
      void greetingWinner;
    } else {
      const countWinner: number = numericKeyedRace.value;
      void countWinner;
    }
    // @ts-expect-error numeric branch names are stringified by JavaScript object enumeration.
    const numericWinnerKey: 0 | 1 = numericKeyedRace.key;
    void numericWinnerKey;
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
    void keyedRace;
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
  const serviceMethodSignature: Equals<
    typeof serviceContext.services.repository.loadGreeting,
    (name: string) => Promise<string>
  > = true;
  void serviceMethodSignature;
}

declare const defaultServicesContext: WorkflowContext;
void (defaultServicesContext.services satisfies unknown);
// @ts-expect-error default workflow services stay unknown until explicitly typed.
void defaultServicesContext.services.repository;

// @ts-expect-error builder services can only be declared once before execute().
workflow({ name: 'duplicateServices' }).services<WelcomeServices>().services<WelcomeServices>();

export const engine = new Engine().register(welcomeBuilder).register(registered);

const typedConcurrency = {
  max: 2,
  key: (input) => input.name,
} satisfies WorkflowConcurrencyOptions<WelcomeInput>;
void workflow({ name: 'typedConcurrencyWelcome', concurrency: typedConcurrency });
