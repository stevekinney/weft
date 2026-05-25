// Semantic-export oracle for symbols a future Engine split might relocate.
//
// This guards the *public package entrypoint* (`weft`), not a deep sibling
// path: if the Engine class or its companion types move to new modules, the
// re-export chain (src/index.ts -> src/core/engine.ts -> src/core/engine/index.ts)
// must keep these reachable from `weft` with unchanged types. These are
// type-only assertions — no runtime behavior.

import { Engine, type AtomicState, type EngineStateNamespace } from 'weft';

// `EngineStateNamespace` is public and `Engine.state` returns it. The getter's
// type must remain assignable to the named interface, and the interface must
// keep its three admin factory methods with their exact return type.
declare const engine: Engine;
const state: EngineStateNamespace = engine.state;
void state;

// execution(ownerWorkflowId, key, options?) => AtomicState<T>
const executionHandle: AtomicState<number> = state.execution<number>('wf-1', 'count', {
  initial: 0,
});
void executionHandle;

// workflow(tenantId, workflowType, key, options?) => AtomicState<T>
const workflowHandle: AtomicState<string> = state.workflow<string>('acme', 'welcome', 'last', {
  initial: '',
});
void workflowHandle;

// tenant(tenantId, key, options?) => AtomicState<T>
const tenantHandle: AtomicState<boolean> = state.tenant<boolean>('acme', 'flag', {
  initial: false,
});
void tenantHandle;

// Missing required positional arguments must fail to compile (guards against a
// relocation silently widening or dropping the signature).
// @ts-expect-error: execution requires (ownerWorkflowId, key).
void state.execution<number>('wf-1');
