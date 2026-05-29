import type { CliConnectionOptions } from './connection.ts';
import { sendJsonRpcRequest } from './json-rpc-client.ts';

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
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
