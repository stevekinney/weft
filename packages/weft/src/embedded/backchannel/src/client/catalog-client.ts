/** JSON-RPC reserved code returned when a server does not know an operation. */
const METHOD_NOT_FOUND_CODE = -32601;

/**
 * The `error` member of a JSON-RPC failure envelope, exactly as the server
 * sent it: the numeric `code`, a human-readable `message`, and whatever
 * optional `data` the operation attached.
 *
 * Codes below `-32000` are JSON-RPC's own reserved range. `-32601` is the one
 * worth recognising, since it means the server has never heard of the
 * operation and is therefore older than the client. {@link CatalogClientError}
 * wraps one of these and exposes that case as `isUnknownOperation`.
 *
 * @example
 * ```ts
 * import { CatalogClientError, type JsonRpcErrorObject } from '@lostgradient/backchannel/client';
 *
 * const wireError: JsonRpcErrorObject = {
 *   code: -32601,
 *   message: 'Method not found',
 * };
 *
 * const error = new CatalogClientError('probe.echo', wireError);
 * console.log(error.isUnknownOperation); // true
 * ```
 */
export type JsonRpcErrorObject = {
  /** The JSON-RPC error code. */
  readonly code: number;
  /** A short description of the error. */
  readonly message: string;
  /** What the server attached to the error, when it did. */
  readonly data?: unknown;
};

/**
 * The outcome of one JSON-RPC call, as a discriminated union rather than a
 * thrown error: `ok: true` carries the operation's result, `ok: false` carries
 * the server's {@link JsonRpcErrorObject}.
 *
 * Narrow on `ok` before reading either side. Note that `result` is `undefined`
 * for an operation that returns nothing, because a server-side `JSON.stringify`
 * drops an undefined result key altogether; `ok: true` with no result is a
 * success, not a malformed response.
 *
 * @example
 * ```ts
 * import type { JsonRpcCallResult } from '@lostgradient/backchannel/client';
 *
 * declare const outcome: JsonRpcCallResult;
 *
 * if (outcome.ok) {
 *   console.log('result', outcome.result);
 * } else {
 *   console.log('failed', outcome.error.code, outcome.error.message);
 * }
 * ```
 */
export type JsonRpcCallResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: JsonRpcErrorObject };

/**
 * Error thrown by a catalog client when a call fails with a JSON-RPC error, or
 * when a subscription's stream reports one. Carries the wire `code` so callers
 * can tell version skew (the operation is absent on an older server) from a
 * domain fault without reaching past the client to build HTTP requests.
 *
 * @example
 * ```ts
 * import { CatalogClientError, type CatalogTransport } from '@lostgradient/backchannel/client';
 *
 * declare const transport: CatalogTransport;
 *
 * try {
 *   await transport('probe.echo', { message: 'hello' });
 * } catch (error) {
 *   if (error instanceof CatalogClientError && error.isUnknownOperation) {
 *     console.log('server predates this operation:', error.operationName);
 *   }
 * }
 * ```
 */
export class CatalogClientError extends Error {
  /** The JSON-RPC error code, or the HTTP status of a failed subscription request. */
  readonly code: number;
  /** The `data` the server attached to the error, when it did. */
  readonly data: unknown;
  /** The operation whose call failed. */
  readonly operationName: string;

  constructor(operationName: string, error: JsonRpcErrorObject) {
    super(error.message);
    this.name = 'CatalogClientError';
    this.code = error.code;
    this.data = error.data;
    this.operationName = operationName;
  }

  /** True when the server did not recognize the operation (version skew). */
  get isUnknownOperation(): boolean {
    return this.code === METHOD_NOT_FOUND_CODE;
  }
}

/**
 * The part of `fetch` a catalog client uses: a request in, a response out. A browser's `fetch`,
 * Bun's and a test double all satisfy it, which `typeof fetch` would not ask of a double in a
 * runtime that adds members to `fetch`.
 *
 * @example
 * ```ts
 * import type { CatalogFetch } from '@lostgradient/backchannel/client';
 *
 * const answer: CatalogFetch = async () => Response.json({ jsonrpc: '2.0', id: 1, result: null });
 * console.log(typeof answer);
 * ```
 */
export type CatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * What one call can carry beyond its input: an abort signal that cancels the
 * request, and a `fetch` to use in place of the transport's own.
 *
 * Both are per call, so a component can cancel its own request when it unmounts
 * and a test can answer one call without replacing the global `fetch`.
 *
 * @example
 * ```ts
 * import type { CatalogCallOptions } from '@lostgradient/backchannel/client';
 *
 * const controller = new AbortController();
 * const options: CatalogCallOptions = {
 *   signal: controller.signal,
 *   fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, result: null }),
 * };
 * console.log(options.signal?.aborted); // false
 * ```
 */
export type CatalogCallOptions = {
  /** Aborting it cancels the request; the call rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** Used for this call instead of the transport's `fetch` and the global one. */
  readonly fetch?: CatalogFetch | undefined;
};

type CatalogOperationTypes = Record<
  string,
  {
    readonly input: unknown;
    readonly output: unknown;
  }
>;

/**
 * The shape a catalog client takes: one method per operation name, each
 * accepting that operation's input and an optional {@link CatalogCallOptions},
 * and resolving to its output.
 *
 * {@link createCatalogClient} produces a value of this type. Name the type when
 * you pass a client between functions: anything written against a
 * `CatalogClient` works equally against a remote server, an in-process engine,
 * or a stub, because the transport is already bound.
 *
 * @example
 * ```ts
 * import type { CatalogClient } from '@lostgradient/backchannel/client';
 *
 * type Operations = {
 *   'probe.echo': {
 *     readonly input: { message: string };
 *     readonly output: { message: string };
 *   };
 * };
 *
 * declare const client: CatalogClient<Operations>;
 * const echo = await client['probe.echo']({ message: 'hello' }, { signal: AbortSignal.timeout(5000) });
 * console.log(echo.message);
 * ```
 */
export type CatalogClient<Operations extends CatalogOperationTypes> = {
  readonly [Name in keyof Operations]: (
    input: Operations[Name]['input'],
    options?: CatalogCallOptions,
  ) => Promise<Operations[Name]['output']>;
};

/**
 * Transport seam for a catalog client. Every generated operation method
 * resolves to one call into a `CatalogTransport`, which carries the operation
 * name, its input and the per-call {@link CatalogCallOptions}, and returns the
 * operation's result.
 *
 * {@link httpJsonRpcTransport} speaks JSON-RPC over HTTP. Writing your own is
 * the supported way to intercept every call in one place: recording them in a
 * test, adding tracing, or routing to a fake or an in-process host.
 *
 * @example
 * ```ts
 * import { createCatalogClient, type CatalogTransport } from '@lostgradient/backchannel/client';
 *
 * const recording: CatalogTransport = async (operationName, input, options) => {
 *   console.log('calling', operationName, input, options?.signal?.aborted);
 *   return { message: 'hello' };
 * };
 *
 * const client = createCatalogClient<{
 *   'probe.echo': { readonly input: { message: string }; readonly output: { message: string } };
 * }>(['probe.echo'], recording);
 * console.log(typeof client['probe.echo']);
 * ```
 */
export type CatalogTransport = (
  operationName: string,
  input: unknown,
  options?: CatalogCallOptions,
) => Promise<unknown>;

/**
 * Metadata needed to map a typed client operation onto REST: the HTTP method
 * and path template, where each input field travels (path, query, header,
 * whole body, or one body field), and what a success looks like.
 *
 * A generated client consumes this for you. Read it directly only when you are
 * reproducing the server's routes outside the client: a gateway, a proxy, or
 * documentation generated from the live surface.
 *
 * @example
 * ```ts
 * import type { ClientRestOperationBinding } from '@lostgradient/backchannel/client';
 *
 * const binding: ClientRestOperationBinding = {
 *   method: 'GET',
 *   path: '/probe/:id',
 *   inputSources: { id: { kind: 'path', pathParam: 'id' } },
 *   success: { kind: 'json', status: 200 },
 * };
 * console.log(binding.method + ' ' + binding.path);
 * ```
 */
export type ClientRestOperationBinding = {
  /** The HTTP method. */
  readonly method: string;
  /** The path template, with `:name` parameters. */
  readonly path: string;
  /** Where each input field travels. */
  readonly inputSources: Readonly<
    Record<
      string,
      | { readonly kind: 'path'; readonly pathParam: string }
      | { readonly kind: 'query'; readonly queryParam: string; readonly repeating?: boolean }
      | { readonly kind: 'header'; readonly headerName: string }
      | { readonly kind: 'body'; readonly mediaType?: 'application/json' }
      | { readonly kind: 'body-field'; readonly bodyField: string }
    >
  >;
  /** What a successful response looks like. */
  readonly success:
    | { readonly kind: 'json'; readonly status: number }
    | { readonly kind: 'empty'; readonly status: number };
};

/**
 * Build a catalog client from a list of operation names and a transport. Each
 * name becomes a method that forwards its input and its per-call options
 * through the transport, so the full catalog is reachable without
 * hand-authoring a method per operation.
 *
 * A generated `create...Client` function is the shortcut that pairs the
 * generated catalog with {@link httpJsonRpcTransport}. Call this directly when
 * you supply the transport yourself, or when you want a client over a
 * deliberately narrowed set of operations.
 *
 * @example
 * ```ts
 * import {
 *   createCatalogClient,
 *   httpJsonRpcTransport,
 * } from '@lostgradient/backchannel/client';
 *
 * const client = createCatalogClient<{
 *   'probe.echo': { readonly input: { message: string }; readonly output: { message: string } };
 * }>(['probe.echo'], httpJsonRpcTransport({ baseUrl: 'http://localhost:7233' }));
 *
 * console.log(typeof client['probe.echo']);
 * ```
 */
export function createCatalogClient<Operations extends CatalogOperationTypes>(
  operationNames: readonly (keyof Operations & string)[],
  transport: CatalogTransport,
): CatalogClient<Operations> {
  const methods: Partial<
    Record<keyof Operations, (input: unknown, options?: CatalogCallOptions) => unknown>
  > = {};
  for (const operationName of operationNames) {
    methods[operationName] = (input: unknown, options?: CatalogCallOptions) =>
      transport(operationName, input, options);
  }
  return methods as CatalogClient<Operations>;
}
