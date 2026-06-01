import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  Engine,
  signal,
  workflow,
  type BulkOperationDryRunResult,
  type BulkSignalResult,
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
  .execute(async function* (ctx, input: PackageRootWelcomeInput) {
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
    // @ts-expect-error child workflow options are closed to fields the engine reads.
    yield* ctx.startChild('packageRootWelcome', input, { unknownOption: true });
    approval.approved.valueOf();
    void typedParallel;
    void typedRace;
    void typedRunAllResult;
    return { greeting };
  });

const engine = new Engine().register(packageRootWelcome);

async function verifyPackageRootWorkflowTyping(): Promise<void> {
  const handle = await engine.start('packageRootWelcome', { name: 'Steve' });
  const typedHandle: WorkflowHandle<PackageRootWelcomeOutput> = handle;
  const output = await typedHandle.result();
  output.greeting.toUpperCase();
}
void verifyPackageRootWorkflowTyping;

// @ts-expect-error workflow input must match the public package-root augmentation.
void engine.start('packageRootWelcome', { id: 'wrong' });

async function verifyPackageRootBulkSignalTyping(): Promise<void> {
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
  const legacyPayloadCommit: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
  );
  const legacyRequestIdPayloadCommit: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { requestId: 'payload-request' },
  );
  const confirmationError: BulkOperationConfirmationError = new BulkOperationConfirmationError();
  const terminalOnlyError: BulkDeleteRequiresTerminalWorkflowsError =
    new BulkDeleteRequiresTerminalWorkflowsError();
  void noPayloadPreview;
  void confirmed;
  void legacyPayloadCommit;
  void legacyRequestIdPayloadCommit;
  void confirmationError;
  void terminalOnlyError;
}
void verifyPackageRootBulkSignalTyping;

// @ts-expect-error workflow names must match the public package-root augmentation.
void engine.start('runtime-discovered-package-root', { id: 'dynamic' });
