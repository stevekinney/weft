import { workflow } from '../types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine, type RegistryAgnosticEngine } from './index.ts';

const greet = workflow({ name: 'greet' }).execute(async function* (_ctx, input: { a: number }) {
  return { b: input.a };
});

// #708: `RegistryAgnosticEngine` must accept both the default-registry
// `Engine` and a concretely narrowed `Engine` returned by
// `Engine.create({ workflows })`, without a call-site cast.
async function verifyBothEngineConstructionPatternsSatisfyRegistryAgnosticEngine(): Promise<void> {
  const defaultEngine = new Engine({ storage: new MemoryStorage() });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { greet },
  });

  const a: RegistryAgnosticEngine = defaultEngine;
  const b: RegistryAgnosticEngine = concreteEngine;
  void a;
  void b;
}
void verifyBothEngineConstructionPatternsSatisfyRegistryAgnosticEngine;

// Codex review on #708 (PR #715): the hosted transports actually call
// `.start()` and `.startOrSignal()` on the engine at runtime (REST/JSON-RPC
// workflow starts, MCP tool invocations), so `RegistryAgnosticEngine` keeps
// those two methods required rather than omitting them — only `register`
// and `registerWorkflows` (the two members whose return type is itself
// `Engine<T>`, the actual source of the registry-generic invariance) are
// dropped. A duck-typed engine substitute missing `start` must fail to
// satisfy `RegistryAgnosticEngine` so this is caught at compile time, not at
// the first runtime "not a function" failure.
declare const engineSubstituteMissingStart: Omit<
  Engine,
  'register' | 'registerWorkflows' | 'start'
>;
// @ts-expect-error a substitute missing `start` must not satisfy RegistryAgnosticEngine.
const rejectedForMissingStart: RegistryAgnosticEngine = engineSubstituteMissingStart;
void rejectedForMissingStart;

declare const engineSubstituteMissingStartOrSignal: Omit<
  Engine,
  'register' | 'registerWorkflows' | 'startOrSignal'
>;
// @ts-expect-error a substitute missing `startOrSignal` must not satisfy RegistryAgnosticEngine.
const rejectedForMissingStartOrSignal: RegistryAgnosticEngine = engineSubstituteMissingStartOrSignal;
void rejectedForMissingStartOrSignal;

// `register` and `registerWorkflows` remain intentionally excluded — no
// hosted transport this PR widens (`serve()`, the Service Worker helpers,
// the MCP session/HTTP/stdio surfaces) calls them.
declare const registryAgnosticEngine: RegistryAgnosticEngine;
// @ts-expect-error `register` is intentionally not part of RegistryAgnosticEngine.
void registryAgnosticEngine.register;
// @ts-expect-error `registerWorkflows` is intentionally not part of RegistryAgnosticEngine.
void registryAgnosticEngine.registerWorkflows;
