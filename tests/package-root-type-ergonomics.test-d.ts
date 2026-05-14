import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  Engine,
  activity,
  signal,
  type BulkOperationDryRunResult,
  type BulkSignalResult,
  type WorkflowContext,
  type WorkflowHandle,
} from 'weft';

interface PackageRootWelcomeInput {
  name: string;
}

interface PackageRootWelcomeOutput {
  greeting: string;
}

interface PackageRootFormatGreetingInput {
  name: string;
}

declare module 'weft' {
  interface WorkflowRegistry {
    packageRootWelcome: {
      input: PackageRootWelcomeInput;
      output: PackageRootWelcomeOutput;
    };
  }

  interface ActivityTypes {
    packageRootFormatGreeting: (input: PackageRootFormatGreetingInput) => Promise<string>;
  }
}

const engine = new Engine();
const packageRootApprovalSignal = signal<{ approved: boolean }>('packageRootApproval');

engine.register(
  activity({
    name: 'packageRootFormatGreeting',
    execute: async (input: PackageRootFormatGreetingInput) => `Hello, ${input.name}`,
  }),
);

engine.register(
  // @ts-expect-error registered activities must match the public package-root augmentation.
  activity({
    name: 'packageRootFormatGreeting',
    execute: async (input: { id: string }) => input.id,
  }),
);

engine.register(
  'packageRootWelcome',
  async function* (ctx: WorkflowContext, input: PackageRootWelcomeInput) {
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
    // @ts-expect-error string-name activity arguments must match the package-root augmentation.
    yield* ctx.run('packageRootFormatGreeting', { id: 'wrong' });
    // @ts-expect-error child workflow options are closed to fields the engine reads.
    yield* ctx.startChild('packageRootWelcome', input, { unknownOption: true });
    approval.approved.valueOf();
    void typedParallel;
    void typedRace;
    void typedRunAllResult;
    return { greeting };
  },
);

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

// Dynamic names are still available to package consumers.
void engine.start('runtime-discovered-package-root', { id: 'dynamic' });
