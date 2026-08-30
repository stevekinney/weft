# PR 5e: Server, Client, and Observability Splits

This split removes the tracked max-lines and complexity disables from six
oversized modules without changing their import paths.

`src/server/authentication.ts` is now a pure barrel over
`src/server/authentication/`. JWT types and defaults moved to `types.ts`, Web
Crypto and JWT verification moved to `crypto.ts`, API-key principal freezing
moved to `api-key.ts`, and the public factory/configuration functions live in
the directory `index.ts`.

`src/server/handler.ts` is now a pure barrel over `src/server/handler/`.
Route matching, response helpers, binding precedence, route execution, and the
public `handleRequest` boundary are separated into focused files.

`src/server/operation-catalog.ts` is now a pure barrel over
`src/server/operation-catalog/`. Public operation types, registry construction,
pipeline helpers, and the dispatch pipeline are split so unknown-key policy and
operation execution each delegate to smaller named helpers.

`src/server/json-rpc-websocket.ts` keeps the session implementation in place
but delegates frame and subscription validation to
`src/server/json-rpc-websocket-validation.ts`.

`src/client/index.ts` is now the public client barrel. Request plumbing,
workflow list search parameters, workflow handles, schedule handles, and the
`HttpClient` class live in separate client modules.

`src/observability/index.ts` now coordinates shared observability state and
exports. Span helpers, the agent event span listener, workflow lifecycle
cleanup, and workflow/activity interceptor builders live in separate
observability modules.
