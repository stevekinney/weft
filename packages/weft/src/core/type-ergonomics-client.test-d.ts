import type {
  HttpClient,
  KnownWorkflowName as KnownWorkflowNameFromClientEntry,
  UnknownNameWhenRegistryEmpty as UnknownNameWhenRegistryEmptyFromClientEntry,
} from '../client/index.ts';
import {
  type ClientHandle,
  type KnownWorkflowName,
  type LocalClient,
  type UnknownNameWhenRegistryEmpty,
  type WeftClient,
} from '../index.ts';

import type { Equals, WelcomeOutput } from './type-ergonomics.test-d.ts';

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

// The unified public root exposes the helper types used by the internal client
// signatures. These comparisons keep the root and client declarations identical.
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
