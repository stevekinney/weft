/**
 * Type-level regression tests for issues #583 and #585.
 *
 * #583: `StartOrSignalOutcome` must be publicly exported from both the package
 * root (`@lostgradient/weft`) and the `/client` barrel
 * (`@lostgradient/weft/client`).
 *
 * #585: `LocalClient` must accept a branded engine returned by
 * `Engine.create({ workflows })` without requiring a cast.
 */

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import type { StartOrSignalOutcome as OutcomeFromRoot } from '../index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { StartOrSignalOutcome as OutcomeFromClientBarrel } from './index.ts';
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
