/**
 * The dev harness's shared credential — `scripts/dev-server.ts` configures
 * `serve({ auth })` with it, and `vite.config.ts` attaches it to every
 * proxied request so the console boots as a real, fully-scoped principal.
 *
 * ## Why the harness is authenticated at all (weft 0.18.0)
 *
 * Before `weft.system.principal` shipped, `src/lib/scopes.svelte.ts` could
 * not ask the server who the caller was, so it optimistically granted all
 * scopes and degraded on observed `403`s. Under that model an unauthenticated
 * dev server was survivable: gated controls rendered enabled and the scoped
 * operations behind them (schedules, storage, system, workers) simply failed
 * at click time with a fault banner.
 *
 * `resolvePrincipal()` now reports the server's real answer, and an
 * unauthenticated weft answers "anonymous, zero scopes" — so the same harness
 * would render every scope-gated surface disabled-with-reason. That is
 * *truthful* (those operations genuinely reject anonymous callers) but it
 * makes the harness useless for building and reviewing exactly the surfaces
 * that need it.
 *
 * `dev-server.ts`'s module doc had already identified the fix — "`serve({
 * auth: { apiKeys: […] } })` plus a matching token the console itself sends"
 * — and deferred it as "a real design decision (touches the frozen
 * `index.html`/`client.ts` runtime-config contract)". It turns out not to:
 * the Vite dev proxy is a dev-only seam that can attach the header on the way
 * through, so the runtime-config contract, `index.html`, and the built bundle
 * are all untouched. No token is ever baked into a build artifact.
 *
 * Net effect: the dev harness gains working scoped surfaces it never had.
 *
 * **Not a secret.** A fixed, well-known string for a localhost-only,
 * `MemoryStorage`-backed dev server seeded with fixtures. It grants nothing
 * anywhere else, and deliberately does not read from the environment — a
 * harness that silently picked up an ambient credential would be a footgun.
 *
 * @module scripts/dev-credentials
 */

/** Bearer token the dev proxy attaches and the dev server accepts. */
export const DEV_API_KEY = 'weft-console-dev-key';
