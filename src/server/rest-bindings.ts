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
 * An `unknown`-typed `RestBinding` suitable for storing in a
 * heterogeneous registry. Each binding's real `Input`/`Output` pair is
 * verified at construction via `defineOperation` + its typed binding
 * factory; the registry itself only needs the runtime-facing surface
 * (`method`, `path`, `operationName`, `extractInput`, `shapeSuccess`).
 */
export type UnknownRestBinding = RestBinding<unknown, unknown>;

/**
 * Live binding set. Empty during Milestone 1; each migrated operation
 * adds a typed entry. Exported `readonly` so the router cannot mutate
 * it at runtime.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [];
