/**
 * Type-level regression tests for issues #583, #585, #722, and #751.
 *
 * #583: `StartOrSignalOutcome` must be publicly exported from both the package
 * root (`@lostgradient/weft`) and the `/client` barrel
 * (`@lostgradient/weft`).
 *
 * #585: `LocalClient` must accept a branded engine returned by
 * `Engine.create({ workflows })` without requiring a cast.
 *
 * #722: `isWeftFault`/`isWeftError`/`isWeftErrorCode`/`isWeftErrorLike`/
 * `WeftError`/`WeftErrorCode` must be importable from the `/client` barrel
 * directly, so browser client code never needs to reach through the root
 * barrel (which also re-exports server-only, Node-dependent code) just to
 * classify errors.
 *
 * #751: `isFaultCode` and the workflow lifecycle event classes used to
 * classify live client event frames must be importable from `/client` without
 * reaching through the Node-dependent root barrel.
 */

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import type {
  ClientStartOrSignalOptions,
  FaultCode as FaultCodeFromRoot,
  StartOrSignalOptions as OptionsFromRoot,
  StartOrSignalOutcome as OutcomeFromRoot,
  WeftErrorCode as WeftErrorCodeFromRoot,
} from '../index.ts';
import {
  isFaultCode as isFaultCodeFromRoot,
  isWeftFault as isWeftFaultFromRoot,
  WeftError as WeftErrorFromRoot,
  WorkflowCancelledEvent as WorkflowCancelledEventFromRoot,
  WorkflowCompletedEvent as WorkflowCompletedEventFromRoot,
  WorkflowFailedEvent as WorkflowFailedEventFromRoot,
  WorkflowResumedEvent as WorkflowResumedEventFromRoot,
  WorkflowStartedEvent as WorkflowStartedEventFromRoot,
  WorkflowSuspendedEvent as WorkflowSuspendedEventFromRoot,
  WorkflowTeardownEvent as WorkflowTeardownEventFromRoot,
  WorkflowTimedOutEvent as WorkflowTimedOutEventFromRoot,
} from '../index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { HttpClient } from './http-client.ts';
import type {
  FaultCode as FaultCodeFromClientBarrel,
  StartOrSignalOutcome as OutcomeFromClientBarrel,
  WeftErrorCode as WeftErrorCodeFromClientBarrel,
} from './index.ts';
import {
  isFaultCode as isFaultCodeFromClientBarrel,
  isWeftError,
  isWeftErrorCode,
  isWeftErrorLike,
  isWeftFault as isWeftFaultFromClientBarrel,
  WeftError as WeftErrorFromClientBarrel,
  WorkflowCancelledEvent as WorkflowCancelledEventFromClientBarrel,
  WorkflowCompletedEvent as WorkflowCompletedEventFromClientBarrel,
  WorkflowFailedEvent as WorkflowFailedEventFromClientBarrel,
  WorkflowResumedEvent as WorkflowResumedEventFromClientBarrel,
  WorkflowStartedEvent as WorkflowStartedEventFromClientBarrel,
  WorkflowSuspendedEvent as WorkflowSuspendedEventFromClientBarrel,
  WorkflowTeardownEvent as WorkflowTeardownEventFromClientBarrel,
  WorkflowTimedOutEvent as WorkflowTimedOutEventFromClientBarrel,
} from './index.ts';
import { LocalClient } from './local.ts';

type SameUnion<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

// --- Issue #583: StartOrSignalOutcome export surface -------------------------

// Both re-exports must resolve to the same underlying union.
declare const outcomeRoot: OutcomeFromRoot;
declare const outcomeClient: OutcomeFromClientBarrel;

// Cross-assignability proves they are the same type.
const rootToClient: OutcomeFromClientBarrel = outcomeRoot;
void rootToClient;
const clientToRoot: OutcomeFromRoot = outcomeClient;
void clientToRoot;

// The union must only admit the documented members — exact-type check.
const provedExact: SameUnion<OutcomeFromRoot, 'started' | 'signalled'> = true;
void provedExact;

// @ts-expect-error: 'pending' is not a valid StartOrSignalOutcome.
const invalid: OutcomeFromRoot = 'pending';
void invalid;

// --- Issue #604: restart-capable startOrSignal option surface ---------------

const rootStartOrSignalOptions: OptionsFromRoot = {
  id: 'stable-id',
  onTerminalConflict: 'start-new',
};
void rootStartOrSignalOptions;

const clientStartOrSignalOptions: ClientStartOrSignalOptions = {
  id: 'stable-id',
  onTerminalConflict: 'start-new',
};
void clientStartOrSignalOptions;

// @ts-expect-error: client start-or-signal options cannot carry inline services.
const clientStartOrSignalRejectsServices: ClientStartOrSignalOptions = { services: {} };
void clientStartOrSignalRejectsServices;

// --- Issue #585: LocalClient accepts a branded Engine from Engine.create ----

// A branded engine returned by `Engine.create({ workflows })`. This is
// `Engine<{ greet: ... } & DefaultWorkflowRegistry, ...>` — NOT the bare
// `Engine<DefaultWorkflowRegistry>` the old constructor accepted.
const greetWorkflow = workflow({ name: 'greet' }).execute(async function* (
  ctx: WorkflowContext,
  input: { name: string },
) {
  yield* ctx.sleep(0);
  return `Hello, ${input.name}!`;
});

declare const storage: MemoryStorage;

// This must type-check without `as` or any cast. The branded engine from
// Engine.create must be accepted by the constructor directly.
async function proveBrandedEngineAccepted(): Promise<void> {
  const brandedEngine = await Engine.create({
    storage,
    workflows: { greet: greetWorkflow },
    recover: false,
  });
  // This line is the regression guard for #585: it must compile without error.
  const client = new LocalClient(brandedEngine);
  void client;
}
void proveBrandedEngineAccepted;

// A bare Engine (the pre-existing case) must also still be accepted.
declare const bareEngine: Engine;
const bareClient = new LocalClient(bareEngine);
void bareClient;

// Generic constructor must infer without any cast.
async function proveGenericConstructor(): Promise<void> {
  const brandedEngine2 = await Engine.create({
    storage,
    workflows: { greet: greetWorkflow },
    recover: false,
  });
  // No `as` cast — constructor is generic and infers TWorkflows from brandedEngine2.
  const typedClient = new LocalClient(brandedEngine2);
  void typedClient;
}
void proveGenericConstructor;

// --- Codex review on #953: WeftClient#start/#startOrSignal/#schedule's
// string-name fallback overload (used when a project has not augmented
// `WorkflowRegistry` via `weft codegen`) must stay generic over `TName`, or
// a caller-supplied explicit type argument (e.g.
// `client.start<'my-workflow'>('my-workflow', input)`) no longer compiles.
// This file cannot exercise that against the real `WeftClient`/
// `LocalClient`/`HttpClient` types with a genuinely empty registry:
// `src/core/type-ergonomics.test-d.ts` augments `WorkflowRegistry` for the
// whole `tsconfig.test-d.json` program (module augmentation is program-wide,
// not file-scoped), so `KnownWorkflowName` is never actually `never` here.
// The real regression test lives in
// `src/client/__fixtures__/no-workflow-registry/consumer.ts`, compiled by
// `src/client/empty-registry-overloads-typecheck.test.ts` via an isolated
// `tsc` invocation with no augmenting file in scope — it calls the actual
// client methods on real `WeftClient`/`LocalClient`/`HttpClient`-typed
// values, not a locally reproduced overload shape.

// --- Issues #725/#728: REST-only operation and storage client surfaces -----

declare const httpClient: HttpClient;
const clearDeadLetterResult: Promise<{ readonly ok: boolean }> = httpClient.call(
  'weft.tasks.diagnostics.deadletters.clear',
  { operationId: 'op-1' },
);
void clearDeadLetterResult;

const storageGetResult: Promise<Uint8Array | null> = httpClient.storage.get('raw-key');
void storageGetResult;
const storageScanResult: AsyncIterable<[string, Uint8Array]> = httpClient.storage.scan('raw:');
void storageScanResult;

// @ts-expect-error: the six specialized storage operations stay off the generic map.
void httpClient.operations['weft.storage.get'];

// --- Issue #722: isWeftFault/isWeftError family importable from /client -----

// The client barrel's re-exported guard functions must be callable and
// narrow the same way as the root barrel's.
declare const unknownError: unknown;
if (isWeftError(unknownError)) {
  const code: string = unknownError.code;
  void code;
}
if (isWeftErrorLike(unknownError)) {
  const code: WeftErrorCodeFromClientBarrel = unknownError.code;
  void code;
}
const isCode: boolean = isWeftErrorCode('WorkflowNotFoundError');
void isCode;
const isFault: boolean = isWeftFaultFromClientBarrel(unknownError, 'WorkflowNotFoundError');
void isFault;

// `WeftError` re-exported from `/client` must be the same class as the root
// barrel's — an instance of one must be assignable through the other's type.
declare const errorFromClientBarrel: WeftErrorFromClientBarrel;
const clientErrorAsRoot: WeftErrorFromRoot = errorFromClientBarrel;
void clientErrorAsRoot;

// `WeftErrorCode` re-exported from `/client` must resolve to the same union
// as the root barrel's.
declare const codeFromRoot: WeftErrorCodeFromRoot;
const codeAsClientBarrel: WeftErrorCodeFromClientBarrel = codeFromRoot;
void codeAsClientBarrel;

// The root barrel's guard must still work identically for comparison.
const isFaultFromRoot: boolean = isWeftFaultFromRoot(unknownError, 'WorkflowNotFoundError');
void isFaultFromRoot;

// --- Issue #751: browser lifecycle classifiers importable from /client -----

declare const unknownFaultCode: unknown;
if (isFaultCodeFromClientBarrel(unknownFaultCode)) {
  const sameNarrowing: FaultCodeFromClientBarrel = unknownFaultCode;
  const sameAsRoot: FaultCodeFromRoot = sameNarrowing;
  void sameNarrowing;
  void sameAsRoot;
}
const rootGuardStillCallable: boolean = isFaultCodeFromRoot(unknownFaultCode);
void rootGuardStillCallable;

const workflowLifecycleTypes = [
  WorkflowStartedEventFromClientBarrel.type,
  WorkflowResumedEventFromClientBarrel.type,
  WorkflowCompletedEventFromClientBarrel.type,
  WorkflowFailedEventFromClientBarrel.type,
  WorkflowCancelledEventFromClientBarrel.type,
  WorkflowTimedOutEventFromClientBarrel.type,
  WorkflowSuspendedEventFromClientBarrel.type,
  WorkflowTeardownEventFromClientBarrel.type,
] as const;
const expectedWorkflowLifecycleTypes: readonly [
  typeof WorkflowStartedEventFromRoot.type,
  typeof WorkflowResumedEventFromRoot.type,
  typeof WorkflowCompletedEventFromRoot.type,
  typeof WorkflowFailedEventFromRoot.type,
  typeof WorkflowCancelledEventFromRoot.type,
  typeof WorkflowTimedOutEventFromRoot.type,
  typeof WorkflowSuspendedEventFromRoot.type,
  typeof WorkflowTeardownEventFromRoot.type,
] = workflowLifecycleTypes;
void expectedWorkflowLifecycleTypes;

// Runtime classes re-exported through `/client` must retain the root classes'
// constructor and instance types rather than becoming client-only copies.
declare const startedFromClient: InstanceType<typeof WorkflowStartedEventFromClientBarrel>;
const startedAsRoot: InstanceType<typeof WorkflowStartedEventFromRoot> = startedFromClient;
void startedAsRoot;
