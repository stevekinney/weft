import { z } from 'zod';
import type { HttpClient } from '../client/index.ts';
import {
  activity,
  DevelopmentWarningEvent,
  Engine,
  ScheduleMissedFireEvent,
  workflow,
  WorkflowStartedEvent,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type InferActivityEntry,
  type WeftClient,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowHandle,
} from '../index.ts';

import {
  engine,
  welcomeBuilder,
  type Equals,
  type FormatGreetingInput,
  type WelcomeOutput,
  type WelcomeServices,
} from './type-ergonomics.test-d.ts';

declare const httpClient: HttpClient;
declare const sharedClient: WeftClient;

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

const developmentWarningListener = (event: DevelopmentWarningEvent) => {
  const workflowId: string = event.workflowId;
  const fieldPaths: string[] = event.fieldPaths;
  void workflowId;
  void fieldPaths;
};

function verifyEngineEventListenerTyping(): void {
  engine.addEventListener('workflow:completed', (event) => {
    const workflowId: string = event.workflowId;
    const duration: number = event.duration;
    const result: unknown = event.result;
    // @ts-expect-error completed workflow events do not carry an error.
    void event.error;
    void workflowId;
    void duration;
    void result;
  });

  engine.addEventListener(WorkflowStartedEvent.type, (event) => {
    const workflowType: string = event.workflowType;
    const input: unknown = event.input;
    // @ts-expect-error started workflow events do not carry a completion duration.
    void event.duration;
    void workflowType;
    void input;
  });

  engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
    const scheduleId: string = event.scheduleId;
    const missedCount: number = event.missedCount;
    const windowStart: number = event.windowStart;
    const windowEnd: number = event.windowEnd;
    // @ts-expect-error missed-fire events describe schedules, not workflow executions.
    void event.workflowId;
    void scheduleId;
    void missedCount;
    void windowStart;
    void windowEnd;
  });

  engine.addEventListener(DevelopmentWarningEvent.type, developmentWarningListener);
  engine.removeEventListener(DevelopmentWarningEvent.type, developmentWarningListener);

  engine.addEventListener('application:custom', (event) => {
    const eventType: string = event.type;
    // @ts-expect-error custom event strings fall back to the standard Event type.
    void event.workflowId;
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
  const inputCheck: Equals<typeof input, { id: string }> = true;
  void inputCheck;
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
const narrowInputWorkflowGuard: AnyWorkflowDefinition = workflow({
  name: 'narrowInputGuard',
}).execute(async function* (_ctx, _input: { strict: true }) {
  yield;
  return 1;
});
void narrowInputWorkflowGuard;

const narrowInputActivityGuard: AnyActivityDefinition = activity({
  name: 'narrowInputActivityGuard',
  execute: async (input: { strict: true; payload: number }) => input.payload,
});
void narrowInputActivityGuard;

// Smoke-test for zero-input activities. A zero-argument function is
// assignable to most function types regardless of constraint variance, so
// this guard is not the contravariance regression detector — it pins that
// the constraint shape continues to accept the no-input case after future
// edits to AnyActivityDefinition.
const zeroInputActivityGuard: AnyActivityDefinition = activity({
  name: 'zeroInputActivityGuard',
  execute: async () => 'ok',
});
void zeroInputActivityGuard;
