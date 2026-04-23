/**
 * Phase 15 — Live registry of `RestBinding` instances for migrated REST
 * operations.
 *
 * Each entry here is a REST route whose dispatch is ready to flow
 * through `executeOperation` (when the per-operation `restDispatchMode`
 * flag says `'via-execute-operation'`). The array starts empty; per-op
 * migrations add entries one at a time (Phase 15c onward), each with
 * its own parity diff test locking byte-for-byte equivalence between
 * the legacy handler path and the new pipeline path.
 *
 * Resolution rule for the HTTP router: given a concrete `request`, the
 * router matches against `REST_BINDINGS` first; a hit consults
 * `resolveRestDispatchMode(opts.restDispatchMode, binding.operationName)`
 * to choose the pipeline vs. legacy executor. A miss continues to the
 * legacy `ROUTES`/`ROUTE_EXECUTORS` table unchanged.
 *
 * @module server/rest-bindings
 */

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
 * Live binding set. Empty during Milestone 1; each migrated operation
 * adds a typed entry. Exported `readonly` so the router cannot mutate
 * it at runtime.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [];
