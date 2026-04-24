/**
 * Live registry of `RestBinding` instances for migrated REST operations.
 *
 * Each entry is a REST route whose dispatch flows through the shared
 * `executeOperation` pipeline. The router (handleRequest) matches
 * against `REST_BINDINGS` first; a miss falls through to the legacy
 * `ROUTES`/`ROUTE_EXECUTORS` table for operations not yet migrated.
 *
 * @module server/rest-bindings
 */

import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './operations/get-workflow.ts';
import type { RestBinding } from './rest-binding.ts';

/**
 * The router stores heterogeneous bindings whose `Input`/`Output` pairs
 * all differ. `RestBinding<Input, Output>` is strictly-typed at the
 * author boundary (so `defineOperation` + binding factories catch
 * mistakes), but at the router level those generics are irrelevant —
 * every binding produces a `Response` regardless of its output type.
 *
 * `RestBinding<any, any>` is the idiomatic way to express "a binding
 * with SOME Input/Output pair the router doesn't care about." A stricter
 * `unknown, unknown` form fails under `exactOptionalPropertyTypes`
 * because `shapeSuccess: (Output) => Response` cannot be safely widened
 * to `(unknown) => Response` (function parameters are contravariant).
 */
// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous registry requires `any` at the storage boundary; individual bindings stay strictly typed at their definition site.
export type UnknownRestBinding = RestBinding<any, any>;

/**
 * Live REST binding set. Each migrated operation contributes exactly
 * one entry. Exported `readonly` so the router cannot mutate it at
 * runtime.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [getWorkflowRestBinding];

/**
 * Live operation registry — populated with every operation that has a
 * `RestBinding`, a JSON-RPC mount, or an stdio mount. Exposed via a
 * factory so tests can spin up a fresh registry without inheriting
 * the live one's state.
 *
 * Concrete `OperationDefinition<Input, Output>` values are directly
 * assignable to `RegistrableOperation` by the variance design in
 * `operation-catalog.ts` — no `as ErasedOperation` cast is needed.
 */
export function createLiveOperationRegistry(): OperationRegistry {
  return createOperationRegistry([getWorkflowOperation]);
}
