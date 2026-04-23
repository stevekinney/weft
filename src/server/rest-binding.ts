/**
 * `RestBinding<Input, Output>` — the REST-facing wrapper that references
 * a transport-neutral `OperationDefinition` by name. The binding owns
 * all HTTP-specific concerns that don't belong on the operation:
 * method, path, where each input field is extracted from (path /
 * query / header / body), and how the output is shaped into an HTTP
 * response.
 *
 * Phase 9 introduces the type, helpers, and compatibility check.
 * Phase 15 migrates individual REST routes onto bindings one at a time
 * behind the per-operation `restDispatchMode` flag, with byte-for-byte
 * parity diff tests gating each migration.
 *
 * This module deliberately does NOT import the existing `route-model.ts`
 * — bindings are additive. The legacy `ROUTES` array and the new
 * `REST_BINDINGS` can coexist during Milestone 1 of Track 8, with the
 * OpenAPI generator picking per-operation which source to read from.
 */

import type { HttpMethod } from './route-model.ts';

/**
 * Where a single top-level field of the operation's `inputSchema`
 * comes from in a REST request. The OpenAPI generator reads this to
 * emit accurate path / query / header / requestBody schema pieces.
 */
export type ParamSource =
  | { readonly kind: 'path'; readonly pathParam: string }
  | { readonly kind: 'query'; readonly queryParam: string; readonly repeating?: boolean }
  | { readonly kind: 'header'; readonly headerName: string }
  | { readonly kind: 'body' }
  | { readonly kind: 'body-field'; readonly bodyField: string };

/**
 * How the operation's output is turned into an HTTP response.
 *   - `json` — standard `Response.json(output, { status })`.
 *   - `empty` — 204 No Content; output is ignored.
 *   - `streaming` — the operation's output is an async iterable of
 *     bytes/events; the transport adapter streams directly.
 */
export type ResponseShape =
  | { readonly kind: 'json'; readonly status: number }
  | { readonly kind: 'empty'; readonly status: number }
  | {
      readonly kind: 'streaming';
      readonly mediaType: 'text/event-stream' | 'application/octet-stream';
    };

/**
 * Binds a REST mount point to an `OperationDefinition`. Generic over
 * `Input` / `Output` so `extractInput` returns a value the operation's
 * schema accepts, and `shapeSuccess` consumes the output without casts.
 */
export type RestBinding<Input, Output> = {
  readonly method: HttpMethod;
  /** Express-style path with `:name` placeholders (e.g., `/v1/workflows/:id`). */
  readonly path: string;
  /** Ordered list of path param names; must match the `:name` tokens in `path`. */
  readonly pathParamNames: ReadonlyArray<string>;
  /** Operation-catalog name this binding dispatches to. */
  readonly operationName: string;
  /**
   * Declarative map from each top-level `Input` field to its REST
   * source. Used by the OpenAPI generator to emit schema; the runtime
   * `extractInput` is the source of truth for actual extraction.
   */
  readonly inputSources: Partial<Record<string, ParamSource>>;
  /**
   * Read the REST request and produce the operation's typed `Input`.
   * Called before `executeOperation`; the returned value is what the
   * pipeline's schema parse step sees.
   */
  readonly extractInput: (request: Request, pathParams: Record<string, string>) => Promise<Input>;
  /** Canonical response shape — OpenAPI reads this, handler may override via `shapeSuccess`. */
  readonly success: ResponseShape;
  /**
   * Optional override for response construction. When absent, transport
   * adapters default to `Response.json(output, { status: success.status })`
   * (or `new Response(null, { status })` for `empty`). Provide this
   * when the wire representation differs from `output` verbatim.
   */
  readonly shapeSuccess?: (output: Output) => Response;
};

/**
 * Match a binding's `:name` path pattern against a concrete URL path.
 * Returns a map of path-param names → URL-decoded values, or `null`
 * when the path does not match the pattern's structure.
 *
 * An empty segment (`/foo//bar`) is treated as a non-match: an empty
 * path param would propagate to the engine as a confusingly-shaped
 * "missing" identifier, and surfacing the shape error at the router
 * (404) produces a cleaner wire response than a downstream 400.
 */
export function bindingPathMatches(
  pattern: string,
  actualPath: string,
): Record<string, string> | null {
  const patternSegments = pattern.split('/');
  const actualSegments = actualPath.split('/');
  if (patternSegments.length !== actualSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index] ?? '';
    const actualSegment = actualSegments[index] ?? '';
    if (patternSegment.startsWith(':')) {
      if (actualSegment.length === 0) return null;
      const name = patternSegment.slice(1);
      try {
        params[name] = decodeURIComponent(actualSegment);
      } catch {
        return null;
      }
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Build a closure that extracts path parameters for a specific pattern
 * + param-name list. Returns null when the input path does not match.
 */
export function extractPathParameters(
  pattern: string,
  _paramNames: ReadonlyArray<string>,
): (actualPath: string) => Record<string, string> | null {
  return (actualPath) => bindingPathMatches(pattern, actualPath);
}

/**
 * Runtime guard: a `RestBinding` is only dispatchable if it references
 * a live `OperationDefinition` that declares `transports.http === true`
 * AND the binding's `operationName` matches the operation's name. The
 * OpenAPI generator and the REST router consult this to exclude
 * bindings whose operation no longer mounts on HTTP.
 *
 * The binding and operation are typed independently here. Structural
 * compatibility between `Input`/`Output` is not checked at the type
 * level — that's the registry's job at registration, and enforcing it
 * here would require the caller to thread matching generics through
 * every call site. This runtime guard only asserts the two concrete
 * runtime properties the router depends on: name equality and HTTP
 * availability.
 */
export function isRestBindingCompatibleWithOperation(
  binding: { readonly operationName: string },
  operation: { readonly name: string; readonly transports: { readonly http: boolean } },
): boolean {
  if (binding.operationName !== operation.name) return false;
  if (!operation.transports.http) return false;
  return true;
}
