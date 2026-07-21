import type { ConnectionOptions } from '../connection.ts';
import { sendJsonRpcRequest, type JsonRpcErrorObject } from './json-rpc-client.ts';

/** JSON-RPC reserved code returned when a server does not know an operation. */
const METHOD_NOT_FOUND_CODE = -32601;

/**
 * Error thrown by the catalog client when an operation call returns a JSON-RPC
 * error. Carries the wire `code` so hand-authored commands can distinguish
 * version-skew (operation absent on an older server) from domain faults without
 * reaching past the generated client to build HTTP requests directly.
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

export type CatalogWeftClient<Operations extends CatalogOperationTypes> = {
  readonly [Name in keyof Operations]: (
    input: Operations[Name]['input'],
  ) => Promise<Operations[Name]['output']>;
};

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
 */
export type CatalogTransport = (operationName: string, input: unknown) => Promise<unknown>;

/** Generated metadata needed to map a typed client operation onto REST. */
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
