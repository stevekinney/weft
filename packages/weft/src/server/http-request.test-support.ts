/**
 * Shared test-only helper for constructing JSON REST requests in server
 * operation and transport behavior tests. The HTTP method and path are always
 * supplied by the call site so method/binding regressions stay observable; only
 * the repeated JSON-body framing (content-type header + `JSON.stringify`) is
 * shared.
 *
 * This module is test-only (`.test-support.ts` is excluded from the production
 * build) and must never be imported by production server code.
 */

/** Build a `Request` with an optional JSON body, defaulting the host to localhost. */
export function createJsonRequest({
  method,
  path,
  body,
}: {
  method: string;
  path: string;
  body?: unknown;
}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}
