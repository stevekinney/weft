import type { CliConnectionOptions } from './connection.ts';
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

export type WeftClientConnection = CliConnectionOptions;

export function createCatalogWeftClient<Operations extends CatalogOperationTypes>(
  operationNames: readonly (keyof Operations & string)[],
  connectionOptions: WeftClientConnection = {},
): CatalogWeftClient<Operations> {
  const methods: Partial<Record<keyof Operations, (input: unknown) => unknown>> = {};
  for (const operationName of operationNames) {
    methods[operationName] = (input: unknown) =>
      callJsonRpc(operationName, input, connectionOptions);
  }
  return methods as CatalogWeftClient<Operations>;
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
