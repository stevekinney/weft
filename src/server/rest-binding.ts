/**
 * `RestBinding<Input, Output>` — the REST-facing wrapper that references
 * a transport-neutral `OperationDefinition` by name. The binding owns
 * all HTTP-specific concerns that don't belong on the operation:
 * method, path, where each input field is extracted from (path /
 * query / header / body), and how the output is shaped into an HTTP
 * response.
 *
 * This module deliberately does NOT import `route-model.ts`: bindings
 * describe operation-backed HTTP routes, while that model describes the
 * remaining REST-only meta and discovery endpoints.
 */

import { WeftError } from '../core/weft-error.ts';
import type { OperationFault } from './operation-fault.ts';
import type { RestBodyReadOptions } from './rest-body.ts';
import type { HttpMethod } from './route-model.ts';

/**
 * Thrown by `bindingPathMatches` when a URL path parameter contains malformed
 * percent-encoding. The top-level handler catches it and returns a 400.
 */
export class MalformedRouteParameterError extends WeftError<'MalformedRouteParameterError'> {
  constructor() {
    super('MalformedRouteParameterError', 'Malformed route parameter encoding');
  }
}

/**
 * Where a single top-level field of the operation's `inputSchema`
 * comes from in a REST request. The OpenAPI generator reads this to
 * emit accurate path / query / header / requestBody schema pieces.
 */
export type ParamSource =
  | { readonly kind: 'path'; readonly pathParam: string }
  | { readonly kind: 'query'; readonly queryParam: string; readonly repeating?: boolean }
  | { readonly kind: 'header'; readonly headerName: string }
  | {
      readonly kind: 'body';
      readonly mediaType?: 'application/json' | 'application/octet-stream';
    }
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
      readonly mediaType: 'text/event-stream' | 'application/octet-stream' | 'application/x-ndjson';
    };

export type RestInputContext = RestBodyReadOptions;

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
   * Long-lived transport specialization for structural catalog checks.
   * Omitted bindings are ordinary unary REST request/response operations.
   */
  readonly transportKind?: 'unary' | 'sse' | 'websocket-subscription';
  /**
   * Declarative map from top-level `Input` field names to their REST
   * source. Fields omitted from this map are not extracted from the
   * request by the OpenAPI generator's schema emission — `extractInput`
   * remains the authoritative runtime source. Keys are constrained to
   * string-typed keys of `Input` so a typo becomes a compile error
   * rather than a silent no-op at generator time.
   */
  readonly inputSources: Partial<Record<Extract<keyof Input, string>, ParamSource>>;
  /**
   * Read the REST request and produce the operation's typed `Input`.
   * Called before `executeOperation`; the returned value is what the
   * pipeline's schema parse step sees.
   */
  readonly extractInput: (
    request: Request,
    pathParams: Record<string, string>,
    context: RestInputContext,
  ) => Promise<Input>;
  /** Canonical response shape — OpenAPI reads this, handler may override via `shapeSuccess`. */
  readonly success: ResponseShape;
  /**
   * Optional override for response construction. When absent, transport
   * adapters default to `Response.json(output, { status: success.status })`
   * (or `new Response(null, { status })` for `empty`). Provide this
   * when the wire representation differs from `output` verbatim.
   *
   * Receives the original `Request` so REST-only response shaping —
   * `Accept` header negotiation (json vs msgpack), redirect URL
   * construction, etc. — can stay in the binding without leaking
   * HTTP-specific state into the operation's `Output` type. Other
   * transports (JSON-RPC HTTP/WS/stdio) never call `shapeSuccess`;
   * they emit `output` directly via the canonical envelope, so the
   * operation contract stays transport-neutral.
   */
  readonly shapeSuccess?: (output: Output, request: Request) => Response;
  /**
   * Optional override for fault → HTTP response mapping. When absent,
   * the transport adapter falls back to `faultToHttpResponse`, which emits
   * the same flat audited `{ error, weftCode?, data? }` body as
   * `shapeRestFault`. This is distinct from the JSON-RPC fault object
   * (`faultToJsonRpcError`), which uses `{ code, message, data }` with a numeric
   * `code` and a broader data projection. REST and JSON-RPC deliberately differ
   * in fault shape, so each transport owns its own projection.
   *
   * REST operations provide this to shape faults the way a REST client
   * expects: most use `shapeRestFault`, which masks an `EngineFailure` to a
   * flat `{ error: "Internal server error" }` with status `500` (never
   * leaking internal detail over REST), adds audited safe context under a
   * `data` sibling for other faults, and maps the remaining fault codes to
   * their HTTP statuses. A few operations supply a bespoke shaper to special-case
   * a particular fault — typically to override its message or to handle one code
   * explicitly — while delegating the rest. The status often matches what the
   * shared map would already produce; the shaper exists for the operation-specific
   * detail (for example, `get-workflow-result` returns the custom message
   * `"Timeout waiting for workflow result"` on a `Timeout`, and `get-stream-chunks`
   * handles `InvalidParams` inline). This per-operation hook is the current
   * contract.
   */
  readonly shapeFault?: (fault: OperationFault) => Response;
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
        // Malformed percent-encoding (e.g. `%` or `%GG`) — the caller
        // (handleRequest) catches this and returns a 400.
        throw new MalformedRouteParameterError();
      }
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
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
