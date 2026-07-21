/**
 * Type-level regression tests for issues #583, #585, and #722.
 *
 * #583: `StartOrSignalOutcome` must be publicly exported from both the package
 * root (`@lostgradient/weft`) and the `/client` barrel
 * (`@lostgradient/weft/client`).
 *
 * #585: `LocalClient` must accept a branded engine returned by
 * `Engine.create({ workflows })` without requiring a cast.
 *
 * #722: `isWeftFault`/`isWeftError`/`isWeftErrorCode`/`isWeftErrorLike`/
 * `WeftError`/`WeftErrorCode` must be importable from the `/client` barrel
 * directly, so browser client code never needs to reach through the root
 * barrel (which also re-exports server-only, Node-dependent code) just to
 * classify errors.
 */

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import type {
  StartOrSignalOptions as OptionsFromRoot,
  StartOrSignalOutcome as OutcomeFromRoot,
  WeftErrorCode as WeftErrorCodeFromRoot,
} from '../index.ts';
import { isWeftFault as isWeftFaultFromRoot, WeftError as WeftErrorFromRoot } from '../index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type {
  ClientStartOrSignalOptions,
  StartOrSignalOutcome as OutcomeFromClientBarrel,
  WeftErrorCode as WeftErrorCodeFromClientBarrel,
} from './index.ts';
import {
  isWeftError,
  isWeftErrorCode,
  isWeftErrorLike,
  isWeftFault as isWeftFaultFromClientBarrel,
  WeftError as WeftErrorFromClientBarrel,
} from './index.ts';
import { LocalClient } from './local.ts';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// --- Issue #583: StartOrSignalOutcome export surface -------------------------

// Both re-exports must resolve to the same underlying union.
declare const outcomeRoot: OutcomeFromRoot;
declare const outcomeClient: OutcomeFromClientBarrel;

// Cross-assignability proves they are the same type.
const _rootToClient: OutcomeFromClientBarrel = outcomeRoot;
void _rootToClient;
const _clientToRoot: OutcomeFromRoot = outcomeClient;
void _clientToRoot;

// The union must only admit the documented members — exact-type check.
const _provedExact: Equals<OutcomeFromRoot, 'started' | 'signalled'> = true;
void _provedExact;

// @ts-expect-error: 'pending' is not a valid StartOrSignalOutcome.
const _invalid: OutcomeFromRoot = 'pending';
void _invalid;

// --- Issue #604: restart-capable startOrSignal option surface ---------------

const _rootStartOrSignalOptions: OptionsFromRoot = {
  id: 'stable-id',
  onTerminalConflict: 'start-new',
};
void _rootStartOrSignalOptions;

const _clientStartOrSignalOptions: ClientStartOrSignalOptions = {
  id: 'stable-id',
  onTerminalConflict: 'start-new',
};
void _clientStartOrSignalOptions;

// @ts-expect-error: client start-or-signal options cannot carry inline services.
const _clientStartOrSignalRejectsServices: ClientStartOrSignalOptions = { services: {} };
void _clientStartOrSignalRejectsServices;

// --- Issue #585: LocalClient accepts a branded Engine from Engine.create ----

// A branded engine returned by `Engine.create({ workflows })`. This is
// `Engine<{ greet: ... } & DefaultWorkflowRegistry, ...>` — NOT the bare
// `Engine<DefaultWorkflowRegistry>` the old constructor accepted.
const greetWorkflow = workflow({ name: 'greet' }).execute(async function* (
  _ctx: WorkflowContext,
  input: { name: string },
) {
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
const _bareClient = new LocalClient(bareEngine);
void _bareClient;

// Generic constructor must infer without any cast.
async function proveGenericConstructor(): Promise<void> {
  const brandedEngine2 = await Engine.create({
    storage,
    workflows: { greet: greetWorkflow },
    recover: false,
  });
  // No `as` cast — constructor is generic and infers TWorkflows from brandedEngine2.
  const _typedClient = new LocalClient(brandedEngine2);
  void _typedClient;
}
void proveGenericConstructor;

// --- Issue #722: isWeftFault/isWeftError family importable from /client -----

// The client barrel's re-exported guard functions must be callable and
// narrow the same way as the root barrel's.
declare const unknownError: unknown;
if (isWeftError(unknownError)) {
  const _code: string = unknownError.code;
  void _code;
}
if (isWeftErrorLike(unknownError)) {
  const _code: WeftErrorCodeFromClientBarrel = unknownError.code;
  void _code;
}
const _isCode: boolean = isWeftErrorCode('WorkflowNotFoundError');
void _isCode;
const _isFault: boolean = isWeftFaultFromClientBarrel(unknownError, 'WorkflowNotFoundError');
void _isFault;

// `WeftError` re-exported from `/client` must be the same class as the root
// barrel's — an instance of one must be assignable through the other's type.
declare const errorFromClientBarrel: WeftErrorFromClientBarrel;
const _clientErrorAsRoot: WeftErrorFromRoot = errorFromClientBarrel;
void _clientErrorAsRoot;

// `WeftErrorCode` re-exported from `/client` must resolve to the same union
// as the root barrel's.
declare const codeFromRoot: WeftErrorCodeFromRoot;
const _codeAsClientBarrel: WeftErrorCodeFromClientBarrel = codeFromRoot;
void _codeAsClientBarrel;

// The root barrel's guard must still work identically for comparison.
const _isFaultFromRoot: boolean = isWeftFaultFromRoot(unknownError, 'WorkflowNotFoundError');
void _isFaultFromRoot;
