import type { ConnectionOptions } from '../connection.ts';
import { sendJsonRpcRequest, type JsonRpcErrorObject } from './json-rpc-request.ts';

/** JSON-RPC reserved code returned when a server does not know an operation. */
const METHOD_NOT_FOUND_CODE = -32601;

/**
 * Error thrown by the catalog client when an operation call returns a JSON-RPC
 * error. Carries the wire `code` so hand-authored commands can distinguish
 * version-skew (operation absent on an older server) from domain faults without
 * reaching past the generated client to build HTTP requests directly.
 *
 * @example
 * ```ts
 * import {
 *   CatalogClientError,
 *   createWeftClient,
 *   type ClientOperationTypes,
 * } from '@lostgradient/weft';
 *
 * const client = createWeftClient({ includeRunLockfile: false });
 * declare const input: ClientOperationTypes['weft.alerts.list']['input'];
 *
 * try {
 *   await client['weft.alerts.list'](input);
 * } catch (error) {
 *   if (error instanceof CatalogClientError && error.isUnknownOperation) {
 *     console.log('server predates this operation:', error.operationName);
 *   }
 * }
 * ```
 */
export class CatalogClientError extends Error {
  readonly code: number;
  readonly data: unknown;
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

type CatalogOperationTypes = Record<
  string,
  {
    readonly input: unknown;
    readonly output: unknown;
  }
>;

/**
 * The shape a catalog client takes: one method per operation name, each
 * accepting that operation's input and resolving to its output.
 *
 * {@link createCatalogWeftClient} produces a value of this type. Name the type
 * when you pass a client between functions — anything written against a
 * `CatalogWeftClient` works equally against a remote server, an in-process
 * engine, or a stub, because the transport is already bound.
 *
 * @example
 * ```ts
 * import type { CatalogWeftClient, CatalogOperationTypes } from '@lostgradient/weft';
 *
 * declare const client: CatalogWeftClient<CatalogOperationTypes>;
 * const listAlerts = client['weft.alerts.list'];
 * console.log(typeof listAlerts);
 * ```
 */
export type CatalogWeftClient<Operations extends CatalogOperationTypes> = {
  readonly [Name in keyof Operations]: (
    input: Operations[Name]['input'],
  ) => Promise<Operations[Name]['output']>;
};

/**
 * How a client reaches a Weft server — the same settings `ConnectionOptions`
 * describes, under the name the client surface uses.
 *
 * Every field is optional, so `{}` means "resolve everything from the
 * environment, profile, or default address". Library code should set
 * `includeRunLockfile: false`, so a local `weft serve` lockfile left behind on
 * a developer's machine cannot silently become the target.
 *
 * @example
 * ```ts
 * import { createWeftClient, type WeftClientConnection } from '@lostgradient/weft';
 *
 * const connection: WeftClientConnection = {
 *   server: 'https://weft.internal:7233',
 *   includeRunLockfile: false,
 * };
 *
 * const client = createWeftClient(connection);
 * console.log(typeof client);
 * ```
 */
export type WeftClientConnection = ConnectionOptions;

/**
 * Transport seam for the catalog client. Every generated operation method
 * resolves to one call into a `CatalogTransport`, which carries the operation
 * name plus its validated input and returns the operation's result.
 *
 * The HTTP transport ({@link httpJsonRpcTransport}) speaks JSON-RPC over the
 * wire; an in-process transport routes the same calls straight into a local
 * `Engine` so the embedded `LocalClient` and the remote CLI/`HttpClient` share
 * one generated surface instead of drifting apart.
 *
 * Writing your own is the supported way to intercept every call in one place —
 * recording them in a test, adding tracing, or routing to a fake.
 *
 * @example
 * ```ts
 * import {
 *   createCatalogWeftClient,
 *   type CatalogOperationTypes,
 *   type CatalogTransport,
 * } from '@lostgradient/weft';
 *
 * const recording: CatalogTransport = async (operationName, input) => {
 *   console.log('calling', operationName, input);
 *   return { alerts: [] };
 * };
 *
 * const client = createCatalogWeftClient<CatalogOperationTypes>(
 *   ['weft.alerts.list'],
 *   recording,
 * );
 * console.log(typeof client);
 * ```
 */
export type CatalogTransport = (operationName: string, input: unknown) => Promise<unknown>;

/**
 * Generated metadata needed to map a typed client operation onto REST: the
 * HTTP method and path template, where each input field travels (path, query,
 * header, whole body, or one body field), and what a success looks like.
 *
 * The generated client consumes this for you. Read it directly only when you
 * are reproducing Weft's routes outside the client — a gateway, a proxy, or
 * documentation generated from the live surface.
 *
 * @example
 * ```ts
 * import {
 *   CLIENT_REST_OPERATION_BINDINGS,
 *   type ClientRestOperationBinding,
 * } from '@lostgradient/weft';
 *
 * const bindings: Readonly<Record<string, ClientRestOperationBinding>> =
 *   CLIENT_REST_OPERATION_BINDINGS;
 *
 * for (const [operation, binding] of Object.entries(bindings)) {
 *   if (binding.success.kind === 'empty') {
 *     console.log(operation, 'answers', binding.success.status, 'with no body');
 *   }
 * }
 * ```
 */
export type ClientRestOperationBinding = {
  readonly method: string;
  readonly path: string;
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
  readonly success:
    | { readonly kind: 'json'; readonly status: number }
    | { readonly kind: 'empty'; readonly status: number };
};

/**
 * Build a catalog client from a list of operation names and a transport. Each
 * name becomes a method that forwards its input through the transport, so the
 * full catalog is reachable without hand-authoring a method per operation.
 *
 * {@link createWeftClient} is the shortcut that pairs the generated catalog
 * with the HTTP transport. Call this directly when you supply the transport
 * yourself, or when you want a client over a deliberately narrowed set of
 * operations.
 *
 * @example
 * ```ts
 * import {
 *   createCatalogWeftClient,
 *   httpJsonRpcTransport,
 *   type CatalogOperationTypes,
 * } from '@lostgradient/weft';
 *
 * const client = createCatalogWeftClient<CatalogOperationTypes>(
 *   ['weft.alerts.list'],
 *   httpJsonRpcTransport({ server: 'http://localhost:7233', includeRunLockfile: false }),
 * );
 *
 * console.log(typeof client['weft.alerts.list']);
 * ```
 */
export function createCatalogWeftClient<Operations extends CatalogOperationTypes>(
  operationNames: readonly (keyof Operations & string)[],
  transport: CatalogTransport,
): CatalogWeftClient<Operations> {
  const methods: Partial<Record<keyof Operations, (input: unknown) => unknown>> = {};
  for (const operationName of operationNames) {
    methods[operationName] = (input: unknown) => transport(operationName, input);
  }
  return methods as CatalogWeftClient<Operations>;
}

/**
 * Transport that dispatches catalog operations as JSON-RPC requests to a
 * remote Weft server, resolving the connection (server URL + token) per call.
 *
 * Because the connection resolves per call rather than once at construction, a
 * token that rotates, or a profile that changes between calls, is picked up
 * without rebuilding the client. Failures arrive as {@link CatalogClientError}.
 *
 * @example
 * ```ts
 * import { httpJsonRpcTransport } from '@lostgradient/weft';
 *
 * const transport = httpJsonRpcTransport({
 *   server: 'http://localhost:7233',
 *   includeRunLockfile: false,
 * });
 *
 * const alerts = await transport('weft.alerts.list', {});
 * console.log(alerts);
 * ```
 */
export function httpJsonRpcTransport(
  connectionOptions: WeftClientConnection = {},
): CatalogTransport {
  return (operationName, input) => callJsonRpc(operationName, input, connectionOptions);
}

async function callJsonRpc(
  operationName: string,
  input: unknown,
  connectionOptions: WeftClientConnection,
): Promise<unknown> {
  const result = await sendJsonRpcRequest(connectionOptions, operationName, input, 'weft-client');
  if (!result.ok) throw new CatalogClientError(operationName, result.error);
  return result.result;
}
