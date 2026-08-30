/**
 * HTTP catalog transport for {@link HttpClient}.
 *
 * Posts JSON-RPC requests to the client's own `${baseUrl}/jsonrpc` endpoint
 * using the client's configured headers. Unlike the CLI's
 * {@link httpJsonRpcTransport}, this transport does not consult on-disk CLI
 * profiles or run lockfiles — a programmatic {@link HttpClient} is constructed
 * with an explicit `baseUrl` and headers, so connection resolution would be
 * wrong here.
 *
 * @module client/http-operations
 */

import type {
  CatalogTransport,
  ClientRestOperationBinding,
} from '../cli/operation-client-runtime.ts';
import { isFaultCode } from '../core/fault-code.ts';
import { HttpClientError, request } from './http-request.ts';

type JsonRpcSuccess = { readonly result: unknown };
type JsonRpcFailure = {
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: {
      readonly weftCode?: unknown;
      readonly httpStatus?: unknown;
      readonly [key: string]: unknown;
    };
  };
};

function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  );
}

function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  return typeof value === 'object' && value !== null && 'result' in value;
}

/**
 * Narrow an untrusted JSON-RPC `error.data` value to a plain object so it can
 * be surfaced on {@link HttpClientError.data}. The envelope is server-
 * controlled but crosses a network boundary, so it is shape-checked rather
 * than trusted as-is.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a {@link CatalogTransport} that dispatches catalog operations as
 * JSON-RPC requests to a remote Weft server at `${baseUrl}/jsonrpc`.
 *
 * A JSON-RPC error envelope is surfaced as an {@link HttpClientError} so faults
 * reach callers through the same error type the ergonomic HTTP methods use.
 *
 * The JSON-RPC endpoint always responds with HTTP 200 — even for operation
 * faults — so the status for `HttpClientError` is taken from
 * `error.data.httpStatus` in the envelope rather than `response.status`.
 * Transport-level errors (405 Method Not Allowed, 415 Unsupported Media Type,
 * 413 Payload Too Large, auth short-circuits) return non-JSON bodies;
 * `response.json()` is wrapped in a try/catch to surface those as
 * `HttpClientError` rather than a raw `SyntaxError`.
 */
export function httpClientCatalogTransport(
  baseUrl: string,
  headers: Record<string, string>,
): CatalogTransport {
  const endpoint = `${baseUrl}/jsonrpc`;
  return async (operationName, input) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: operationName,
        params: input,
        id: operationName,
      }),
    });

    // Transport-level failures (405, 415, 413, auth short-circuits) return
    // non-JSON text bodies. Catch any parse failure and surface as HttpClientError.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HttpClientError(
        response.status,
        response.statusText || `HTTP ${response.status} from ${endpoint}`,
      );
    }

    if (isJsonRpcFailure(body)) {
      const { message, data } = body.error;
      // The /jsonrpc endpoint always returns HTTP 200, even for operation faults.
      // The true HTTP-equivalent status lives in error.data.httpStatus; fall back
      // to response.status (which will be 200) only if the envelope omits it.
      const httpStatus = typeof data?.httpStatus === 'number' ? data.httpStatus : response.status;
      const faultCode = isFaultCode(data?.weftCode) ? data.weftCode : undefined;
      // Surface the full envelope `data` object verbatim on HttpClientError.data
      // (#711) — it carries the fault-specific payload (e.g. InvalidParams'
      // `issues`, NotFound's `resource`/`identifier`) alongside the envelope's
      // own `weftCode`/`httpStatus` keys. `data.weftCode` here is the coarse
      // `FaultCode` the envelope writes last (`faultToJsonRpcError`), not a
      // fine-grained `WeftErrorCode` — JSON-RPC does not currently carry the
      // fine-grained code at all, so `HttpClientError.weftCode` stays
      // undefined for this transport (a pre-existing gap, not addressed here).
      throw new HttpClientError(httpStatus, message, {
        faultCode,
        data: isRecord(data) ? data : undefined,
      });
    }

    if (isJsonRpcSuccess(body)) return body.result;
    throw new HttpClientError(response.status, `Invalid JSON-RPC response from ${endpoint}`);
  };
}

function inputRecord(operationName: string, input: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(input)) return input;
  throw new HttpClientError(400, `Operation ${operationName} input must be an object.`);
}

function requiredString(operationName: string, field: string, value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new HttpClientError(
    400,
    `Operation ${operationName} requires a non-empty string "${field}" field.`,
  );
}

function restParameterValue(operationName: string, field: string, value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new HttpClientError(
    400,
    `Operation ${operationName} requires a string, number, or boolean "${field}" field.`,
  );
}

type RestRequestProjection = {
  path: string;
  readonly searchParameters: URLSearchParams;
  readonly requestHeaders: Headers;
  readonly bodyFields: Record<string, unknown>;
  directBody: unknown;
  directBodyMediaType: 'application/json' | undefined;
};

function appendQueryValues(
  projection: RestRequestProjection,
  operationName: string,
  field: string,
  queryParameter: string,
  value: unknown,
  repeating: boolean,
): void {
  if (repeating && Array.isArray(value)) {
    for (const entry of value) {
      projection.searchParameters.append(
        queryParameter,
        restParameterValue(operationName, field, entry),
      );
    }
    return;
  }
  projection.searchParameters.set(queryParameter, restParameterValue(operationName, field, value));
}

function projectRestInput(
  projection: RestRequestProjection,
  operationName: string,
  field: string,
  source: ClientRestOperationBinding['inputSources'][string],
  value: unknown,
): void {
  if (source.kind === 'path') {
    const pathValue = requiredString(operationName, field, value);
    projection.path = projection.path.replaceAll(
      `:${source.pathParam}`,
      encodeURIComponent(pathValue),
    );
    return;
  }
  if (value === undefined) return;
  if (source.kind === 'query') {
    appendQueryValues(
      projection,
      operationName,
      field,
      source.queryParam,
      value,
      source.repeating === true,
    );
    return;
  }
  if (source.kind === 'header') {
    projection.requestHeaders.set(
      source.headerName,
      restParameterValue(operationName, field, value),
    );
    return;
  }
  if (source.kind === 'body-field') {
    projection.bodyFields[source.bodyField] = value;
    return;
  }
  projection.directBody = value;
  projection.directBodyMediaType = source.mediaType ?? 'application/json';
}

/**
 * Build the ordinary JSON REST request described by generated binding metadata.
 * Binary bodies and streaming outputs are deliberately absent from this seam;
 * raw storage uses the byte-oriented `client.storage` facade instead.
 */
async function callRestOperation(
  baseUrl: string,
  headers: Record<string, string>,
  operationName: string,
  binding: ClientRestOperationBinding,
  input: unknown,
): Promise<unknown> {
  const fields = inputRecord(operationName, input);
  const projection: RestRequestProjection = {
    path: binding.path,
    searchParameters: new URLSearchParams(),
    requestHeaders: new Headers(),
    bodyFields: {},
    directBody: undefined,
    directBodyMediaType: undefined,
  };

  for (const [field, source] of Object.entries(binding.inputSources)) {
    projectRestInput(projection, operationName, field, source, fields[field]);
  }

  const query = projection.searchParameters.toString();
  if (query.length > 0) projection.path += `?${query}`;
  const hasBodyFields = Object.keys(projection.bodyFields).length > 0;
  const body =
    projection.directBody === undefined
      ? hasBodyFields
        ? projection.bodyFields
        : undefined
      : projection.directBody;
  if (body !== undefined) {
    projection.requestHeaders.set(
      'content-type',
      projection.directBodyMediaType ?? 'application/json',
    );
  }

  return request<unknown>(baseUrl, projection.path, headers, {
    method: binding.method,
    ...([...projection.requestHeaders].length === 0 ? {} : { headers: projection.requestHeaders }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Route generated client operations over JSON-RPC or ordinary REST metadata. */
export function httpClientOperationTransport(
  baseUrl: string,
  headers: Record<string, string>,
  restBindings: Readonly<Record<string, ClientRestOperationBinding>>,
): CatalogTransport {
  const jsonRpc = httpClientCatalogTransport(baseUrl, headers);
  return (operationName, input) => {
    const restBinding = restBindings[operationName];
    return restBinding === undefined
      ? jsonRpc(operationName, input)
      : callRestOperation(baseUrl, headers, operationName, restBinding, input);
  };
}
