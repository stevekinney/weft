import {
  BranchTopologyChangedError,
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  DevelopmentWarningEvent,
  Engine,
  ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME,
  isWeftErrorCode,
  ScheduleMissedFireEvent,
  signal,
  workflow,
  WorkflowConcurrencyLimitExceededError,
  WorkflowStartedEvent,
  WorkflowSuspendNotSupportedError,
  type BulkOperationDryRunResult,
  type BulkOperationOptions,
  type BulkSignalResult,
  type ChildWorkflowHandle,
  type WeftErrorCode,
  type WorkflowHandle,
} from '@lostgradient/weft';

interface PackageRootWelcomeInput {
  name: string;
}

interface PackageRootWelcomeOutput {
  greeting: string;
}

interface PackageRootFormatGreetingInput {
  name: string;
}

interface PackageRootServices {
  repository: {
    greetingFor(name: string): Promise<string>;
  };
}

declare module '@lostgradient/weft' {
  interface WorkflowRegistry {
    // Module-augmented workflow name, distinct from any `engine.register(...)`
    // call site below so the builder's `WorkflowAlreadyRegistered` brand does
    // not intersect.
    packageRootModuleAugmented: {
      input: PackageRootWelcomeInput;
      output: PackageRootWelcomeOutput;
    };
  }
}

const packageRootApprovalSignal = signal<{ approved: boolean }>('packageRootApproval');

// Activity names are typed per-workflow via the builder's `.activities()`
// step. The pre-builder global `ActivityTypes` augmentation no longer exists.
const packageRootWelcome = workflow({ name: 'packageRootWelcome' })
  .activities({
    packageRootFormatGreeting: async (input: PackageRootFormatGreetingInput) =>
      `Hello, ${input.name}`,
  })
  .services<PackageRootServices>()
  .execute(async function* (ctx, input: PackageRootWelcomeInput) {
    const services = ctx.services;
    if (services !== undefined) {
      const serviceGreeting = yield* ctx.run(() => services.repository.greetingFor(input.name));
      void (serviceGreeting satisfies string);
    }
    const greeting = yield* ctx.run('packageRootFormatGreeting', { name: input.name });
    const approval = yield* ctx.waitForSignal(packageRootApprovalSignal);
    const parallel = yield* ctx.all([
      ctx.run('packageRootFormatGreeting', { name: input.name }),
      ctx.run(async () => 42),
    ]);
    const typedParallel: [string, number] = parallel;
    const raced = yield* ctx.race([
      ctx.run('packageRootFormatGreeting', { name: input.name }),
      ctx.run(async () => 42),
    ]);
    const typedRace: string | number = raced;
    const runAllResult = yield* ctx.runAll({
      greeting: [async (value: PackageRootWelcomeInput) => value.name, input],
      count: [async () => 42],
    });
    const typedRunAllResult: { greeting: string; count: number } = runAllResult;
    // @ts-expect-error builder-typed activity arguments must match the declared input type.
    yield* ctx.run('packageRootFormatGreeting', { id: 'wrong' });
    // @ts-expect-error builder-typed activities must be present in the workflow's `.activities()`.
    yield* ctx.run('packageRootRuntimeFormatGreeting', { name: input.name });
    const awaitedChild: PackageRootWelcomeOutput = yield* ctx.startChild<PackageRootWelcomeOutput>(
      'packageRootWelcome',
      input,
      { parentClosePolicy: 'await' },
    );
    const omittedPolicyChild: PackageRootWelcomeOutput =
      yield* ctx.startChild<PackageRootWelcomeOutput>('packageRootWelcome', input);
    const abandonedChild: ChildWorkflowHandle<PackageRootWelcomeOutput> =
      yield* ctx.startChild<PackageRootWelcomeOutput>('packageRootWelcome', input, {
        parentClosePolicy: 'abandon',
      });
    const requestCancelChild: ChildWorkflowHandle<PackageRootWelcomeOutput> =
      yield* ctx.startChild<PackageRootWelcomeOutput>('packageRootWelcome', input, {
        parentClosePolicy: 'request-cancel',
      });
    const detachedChildId: string = abandonedChild.id;
    const detachedResult = yield* ctx.startChild<PackageRootWelcomeOutput>(
      'packageRootWelcome',
      input,
      {
        parentClosePolicy: 'request-cancel',
      },
    );
    // @ts-expect-error detached child workflow policies return handles, not child results.
    const invalidDetachedResult: PackageRootWelcomeOutput = detachedResult;
    // @ts-expect-error only await, abandon, and request-cancel are valid parent-close policies.
    yield* ctx.startChild('packageRootWelcome', input, { parentClosePolicy: 'terminate' });
    // @ts-expect-error child workflow options are closed to fields the engine reads.
    yield* ctx.startChild('packageRootWelcome', input, { unknownOption: true });
    yield* ctx.pipe(
      [
        {
          type: 'packageRootWelcome',
          options: {
            // @ts-expect-error composition operators are await-only and cannot abandon child workflows.
            parentClosePolicy: 'request-cancel',
          },
        },
      ],
      input,
    );
    approval.approved.valueOf();
    void awaitedChild;
    void omittedPolicyChild;
    void requestCancelChild;
    void detachedChildId;
    void invalidDetachedResult;
    void typedParallel;
    void typedRace;
    void typedRunAllResult;
    return { greeting };
  });

const engine = new Engine().register(packageRootWelcome);
const shutdownResult: Promise<void> = engine.shutdown();
void shutdownResult;
const leaseSynchronousDisposeWarningName: 'WeftEngineLeaseSynchronousDisposeWarning' =
  ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME;
void leaseSynchronousDisposeWarningName;

function verifyPackageRootEngineEventListenerTyping(): void {
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
    // @ts-expect-error schedule missed-fire events do not carry workflow IDs.
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
}
void verifyPackageRootEngineEventListenerTyping;

async function verifyPackageRootWorkflowTyping(): Promise<void> {
  const handle = await engine.start(
    'packageRootWelcome',
    { name: 'Steve' },
    {
      services: {
        repository: { greetingFor: async (name) => `Hello, ${name}` },
      },
    },
  );
  // @ts-expect-error package-root start services must match the declared workflow services.
  void engine.start('packageRootWelcome', { name: 'Steve' }, { services: { repository: {} } });
  const typedHandle: WorkflowHandle<PackageRootWelcomeOutput> = handle;
  const output = await typedHandle.result();
  output.greeting.toUpperCase();
}
void verifyPackageRootWorkflowTyping;

// @ts-expect-error workflow input must match the public package-root augmentation.
void engine.start('packageRootWelcome', { id: 'wrong' });

async function verifyPackageRootBulkSignalTyping(): Promise<void> {
  const concurrentBulkOptions: BulkOperationOptions = { dryRun: true, bulkConcurrency: 2 };
  void concurrentBulkOptions;
  const noPayloadPreview: BulkOperationDryRunResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    undefined,
    { dryRun: true },
  );
  const preview: BulkOperationDryRunResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
    { dryRun: true },
  );
  const confirmed: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
    { confirmationToken: preview.confirmationToken },
  );
  const payloadCommitResult: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
  );
  const requestIdPayloadCommitResult: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { requestId: 'payload-request' },
  );
  const confirmationError: BulkOperationConfirmationError = new BulkOperationConfirmationError();
  const terminalOnlyError: BulkDeleteRequiresTerminalWorkflowsError =
    new BulkDeleteRequiresTerminalWorkflowsError();
  const concurrencyError: WorkflowConcurrencyLimitExceededError =
    new WorkflowConcurrencyLimitExceededError({
      workflowType: 'limited',
      limit: 1,
      partitionKey: 'limited',
    });
  const suspendError: WorkflowSuspendNotSupportedError = new WorkflowSuspendNotSupportedError(
    'suspend is only supported in inline execution mode',
  );
  const topologyError: BranchTopologyChangedError = new BranchTopologyChangedError(
    'branch topology changed across retry',
  );
  const suspendCode: WeftErrorCode = 'WorkflowSuspendNotSupportedError';
  const concurrencyCode: WeftErrorCode = 'WorkflowConcurrencyLimitExceededError';
  const topologyCode: WeftErrorCode = 'BranchTopologyChangedError';
  if (topologyError instanceof BranchTopologyChangedError) {
    topologyError.code satisfies 'BranchTopologyChangedError';
  }
  isWeftErrorCode(suspendCode);
  isWeftErrorCode(concurrencyCode);
  isWeftErrorCode(topologyCode);
  void noPayloadPreview;
  void confirmed;
  void payloadCommitResult;
  void requestIdPayloadCommitResult;
  void confirmationError;
  void terminalOnlyError;
  void concurrencyError;
  void suspendError;
}
void verifyPackageRootBulkSignalTyping;

// @ts-expect-error workflow names must match the public package-root augmentation.
void engine.start('runtime-discovered-package-root', { id: 'dynamic' });
