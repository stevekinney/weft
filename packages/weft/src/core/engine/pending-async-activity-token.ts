/**
 * The sanctioned, read-only boundary `server/` crosses to ask whether a
 * durable task's `operationId` is also a workflow's remote-mode `ctx.run()`
 * token (COR-152).
 *
 * **Why this is its own module.** `internals.ts` is importable only from
 * `core/engine/**` — the rule
 * `documentation/internal-imports-allowlist.json` states and
 * `scripts/check-internal-imports.ts` enforces — because it hands out
 * `EngineInternals`, the engine's whole mutable state object. This predicate
 * was always meant to be the opposite of that: a single boolean, no state
 * escaping, explicitly so `server/` would never need `getInternals`. Living
 * in `internals.ts` made it indistinguishable from the thing it exists to
 * avoid, and made the one legitimate caller look like a violation. Splitting
 * it out is what lets the gate stay strict while the intended crossing stays
 * legal.
 *
 * @module core/engine/pending-async-activity-token
 */

import { peekInternals } from './internals.ts';

/**
 * Whether `token` currently identifies a live pending async activity —
 * registered (`registerPendingAsyncActivity`) and not yet consumed
 * (`completeAsyncActivity`/`failAsyncActivity`).
 *
 * Used by COR-152's remote-activity result bridge
 * (`server/runtime/remote-activity-result-bridge.ts`) to tell "this durable
 * task's operationId is also a workflow's remote-mode `ctx.run()` token"
 * apart from "this is a standalone task dispatched directly through
 * `WeftServer.dispatchTask`, unrelated to any workflow".
 *
 * `false` for an object that never went through `new Engine()` — a test
 * fixture stubbing only part of the `ServeOptions.engine` surface — which is
 * the correct answer: such an object cannot durably hold a pending token.
 */
export function isPendingAsyncActivityToken(engine: object, token: string): boolean {
  const internals = peekInternals(engine);
  return internals !== undefined && internals.pendingAsyncActivities.has(token);
}
