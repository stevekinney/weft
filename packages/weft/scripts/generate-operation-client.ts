#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import packageJson from '../package.json' with { type: 'json' };

import { format, resolveConfig } from 'prettier';

import { compareStrings } from '../src/server/json-schema-utilities.ts';
import type {
  CatalogOperationSnapshot,
  CatalogSnapshot,
} from '../src/server/operation-catalog-snapshot.ts';
import { createCatalogSnapshot } from '../src/server/operation-catalog-snapshot.ts';

import { renderAliasDeclarations, selectAliases } from './operation-client-aliases.ts';
import {
  GENERATED_HEADER,
  operationDomains,
  operationDomainSource,
} from './operation-client-domains.ts';
import { schemaToNode } from './operation-client-schema.ts';

/**
 * The name the generated examples import from — read from the manifest rather than written
 * here, because this generator is published alongside the package it describes and a mirror of
 * it carries a different name. A hardcoded name would make the generated file drift the moment
 * the package was renamed, and the drift test would report the generator as wrong.
 */
const packageName: string = packageJson.name;

export const OPERATION_CLIENT_DIRECTORY = 'src/client/generated';
export const OPERATION_CLIENT_FILE = 'operation-client.generated.ts';

export async function createOperationClientSources(
  snapshot: CatalogSnapshot,
): Promise<ReadonlyMap<string, string>> {
  const catalogOperations = snapshot.operations
    .filter((operation) => operation.kind === 'unary' && operation.transports.jsonRpcHttp)
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const restOnlyOperations = snapshot.operations
    .filter(isGenericRestClientOperation)
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const clientOperations = [...catalogOperations, ...restOnlyOperations].toSorted((left, right) =>
    compareStrings(left.name, right.name),
  );
  const catalogNames = catalogOperations.map((operation) => `  '${operation.name}',`);
  const clientNames = clientOperations.map((operation) => `  '${operation.name}',`);
  const restBindings = restOnlyOperations.map((operation) => {
    const rest = operation.rest;
    if (rest === undefined) throw new Error(`missing REST binding for ${operation.name}`);
    const clientPath = rest.path.replace(/^\/v1/, '');
    return `  '${operation.name}': ${JSON.stringify({ ...rest, path: clientPath })},`;
  });

  const roots = clientOperations.flatMap((operation) => [
    schemaToNode(operation.inputSchema),
    schemaToNode(operation.outputSchema),
  ]);

  const { aliasNameByKey, nodeByKey } = selectAliases(roots);
  const domains = operationDomains(clientOperations);
  const imports = domains
    .map((domain) => `import type { ${domain.typeName} } from './${domain.fileName}';`)
    .join('\n');
  const types = domains.map((domain) => domain.typeName).join(' & ') || '{}';
  const aliasDeclarations = renderAliasDeclarations(aliasNameByKey, nodeByKey);

  const sources = new Map<string, string>();
  for (const domain of domains)
    sources.set(domain.fileName, operationDomainSource(domain, aliasNameByKey));
  if (aliasDeclarations.length)
    sources.set(
      'shared-operation-types.generated.ts',
      `${GENERATED_HEADER}\n${aliasDeclarations.map((declaration) => `export ${declaration}`).join('\n')}\n`,
    );

  const source = `${GENERATED_HEADER}
${imports}

import {
  createCatalogWeftClient,
  httpJsonRpcTransport,
  type ClientRestOperationBinding,
  type CatalogWeftClient,
  type WeftClientConnection,
} from '../operation-client-runtime.ts';

/**
 * Every unary operation this server exposes over JSON-RPC, sorted by name.
 *
 * This is exactly the set {@link createWeftClient} turns into client methods,
 * so it also answers "can I call this over JSON-RPC?" at runtime — worth
 * checking when the name arrived as a string from a CLI argument or a queued
 * job, before you hand it to the client.
 *
 * @example
 * \`\`\`ts
 * import { CATALOG_OPERATION_NAMES } from '${packageName}';
 *
 * const requested = 'weft.activities.complete';
 * const callable = CATALOG_OPERATION_NAMES.some((name) => name === requested);
 * console.log(callable); // true
 * \`\`\`
 */
export const CATALOG_OPERATION_NAMES = [
${catalogNames.join('\n')}
] as const;

/**
 * The name of any operation callable over JSON-RPC — the union behind
 * {@link CATALOG_OPERATION_NAMES}.
 *
 * Annotate with this when an operation name reaches you from somewhere
 * untyped and you would rather the compiler reject a name this server does
 * not serve than discover it on the first round trip.
 *
 * @example
 * \`\`\`ts
 * import type { CatalogOperationName } from '${packageName}';
 *
 * const operation: CatalogOperationName = 'weft.alerts.list';
 * console.log(operation);
 * \`\`\`
 */
export type CatalogOperationName = (typeof CATALOG_OPERATION_NAMES)[number];

/**
 * Every operation the generated client can reach, sorted by name: the JSON-RPC
 * catalog in {@link CATALOG_OPERATION_NAMES} plus those served only over REST.
 *
 * Reach for this when you want the client's whole surface — building a
 * permission table, generating documentation, checking coverage — and for
 * {@link CATALOG_OPERATION_NAMES} when you specifically need the JSON-RPC
 * subset.
 *
 * @example
 * \`\`\`ts
 * import { CATALOG_OPERATION_NAMES, CLIENT_OPERATION_NAMES } from '${packageName}';
 *
 * const restOnly = CLIENT_OPERATION_NAMES.filter(
 *   (name) => !CATALOG_OPERATION_NAMES.some((catalogName) => catalogName === name),
 * );
 * console.log(restOnly.length);
 * \`\`\`
 */
export const CLIENT_OPERATION_NAMES = [
${clientNames.join('\n')}
] as const;

/**
 * The name of any operation the generated client can reach — the union behind
 * {@link CLIENT_OPERATION_NAMES}.
 *
 * Wider than {@link CatalogOperationName}, which covers only the JSON-RPC
 * subset. Use this one for code that handles REST-only operations too.
 *
 * @example
 * \`\`\`ts
 * import type { ClientOperationName } from '${packageName}';
 *
 * const operation: ClientOperationName = 'weft.alerts.list';
 * console.log(operation);
 * \`\`\`
 */
export type ClientOperationName = (typeof CLIENT_OPERATION_NAMES)[number];

/**
 * HTTP method, path template and input placement for each operation the client
 * reaches over REST rather than JSON-RPC.
 *
 * The generated client already uses this table to build its requests, so read
 * it directly only when you are working outside the client — proxying Weft
 * behind your own router, or writing a gateway that has to reproduce the same
 * routes. Paths are client-relative: the server's \`/v1\` prefix is stripped.
 *
 * @example
 * \`\`\`ts
 * import { CLIENT_REST_OPERATION_BINDINGS } from '${packageName}';
 *
 * for (const [operation, binding] of Object.entries(CLIENT_REST_OPERATION_BINDINGS)) {
 *   console.log(binding.method + ' ' + binding.path + '  ' + operation);
 * }
 * \`\`\`
 */
export const CLIENT_REST_OPERATION_BINDINGS = {
${restBindings.join('\n')}
} as const satisfies Readonly<Record<string, ClientRestOperationBinding>>;

/**
 * Input and output types for every operation the client can reach, keyed by
 * operation name and assembled from the per-domain generated modules.
 *
 * You seldom name this directly — {@link createWeftClient} applies it for you.
 * It earns its keep when you write code generic over operations, such as a
 * logging or retry wrapper that has to preserve each operation's own input and
 * output types instead of widening them to \`unknown\`.
 *
 * @example
 * \`\`\`ts
 * import type { ClientOperationTypes } from '${packageName}';
 *
 * type CancelInput = ClientOperationTypes['weft.workflows.cancel']['input'];
 *
 * declare const input: CancelInput;
 * console.log(input);
 * \`\`\`
 */
export type ClientOperationTypes = ${types};

/**
 * The {@link ClientOperationTypes} entries for operations reachable over
 * JSON-RPC, which is the surface {@link createWeftClient} builds against.
 *
 * Use this rather than {@link ClientOperationTypes} when your code runs
 * against a JSON-RPC transport and should not reference an operation that only
 * exists over REST.
 *
 * @example
 * \`\`\`ts
 * import type { CatalogOperationTypes } from '${packageName}';
 *
 * type AlertsOutput = CatalogOperationTypes['weft.alerts.list']['output'];
 *
 * declare const alerts: AlertsOutput;
 * console.log(alerts);
 * \`\`\`
 */
export type CatalogOperationTypes = Pick<ClientOperationTypes, CatalogOperationName>;

export type WeftClient = CatalogWeftClient<CatalogOperationTypes>;

/**
 * A client shaped over every operation, REST included: each operation name is
 * a method taking that operation's input and resolving to its output.
 *
 * {@link createWeftClient} returns the narrower JSON-RPC-only shape. Name this
 * one when you build a client over a transport that also covers the REST-only
 * operations.
 *
 * @example
 * \`\`\`ts
 * import type { ClientOperations } from '${packageName}';
 *
 * declare const client: ClientOperations;
 * const diagnostics = client['weft.catalog.diagnostics'];
 * console.log(typeof diagnostics);
 * \`\`\`
 */
export type ClientOperations = CatalogWeftClient<ClientOperationTypes>;

/**
 * Build a typed client for a remote Weft server, with one method per operation
 * in {@link CATALOG_OPERATION_NAMES}.
 *
 * Calls travel as JSON-RPC over HTTP. Connection settings resolve in the usual
 * order — explicit options, environment, named profile, then the default
 * address — so passing nothing is right when the environment already describes
 * the server. In library code pass \`includeRunLockfile: false\`, so a stray
 * local \`weft serve\` lockfile cannot quietly redirect your calls.
 *
 * @example
 * \`\`\`ts
 * import { createWeftClient, type ClientOperationTypes } from '${packageName}';
 *
 * const client = createWeftClient({
 *   server: 'http://localhost:7233',
 *   includeRunLockfile: false,
 * });
 *
 * declare const input: ClientOperationTypes['weft.alerts.list']['input'];
 * const alerts = await client['weft.alerts.list'](input);
 * console.log(alerts);
 * \`\`\`
 */
export function createWeftClient(connection: WeftClientConnection = {}): WeftClient {
  return createCatalogWeftClient<CatalogOperationTypes>(
    CATALOG_OPERATION_NAMES,
    httpJsonRpcTransport(connection),
  );
}
`;
  sources.set(OPERATION_CLIENT_FILE, source);
  const formatted = new Map<string, string>();
  for (const [fileName, contents] of sources) {
    const filePath = join(OPERATION_CLIENT_DIRECTORY, fileName);
    const configuration = await resolveConfig(filePath);
    formatted.set(fileName, await format(contents, { ...configuration, filepath: filePath }));
  }
  return formatted;
}

/**
 * Ordinary REST-only unary operations can use the generated JSON request
 * transport. Storage stays on `client.storage`: its octet-stream and NDJSON
 * wire formats require a byte-oriented facade rather than schema-shaped JSON.
 */
function isGenericRestClientOperation(operation: CatalogOperationSnapshot): boolean {
  if (operation.kind !== 'unary') return false;
  if (!operation.transports.http || operation.transports.jsonRpcHttp) return false;
  if (operation.tags.includes('Storage')) return false;
  const rest = operation.rest;
  if (rest === undefined || rest.success.kind === 'streaming') return false;
  return Object.values(rest.inputSources).every(
    (source) => source.kind !== 'body' || source.mediaType !== 'application/octet-stream',
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { 'output-directory': { type: 'string' } },
    strict: true,
  });
  const directory = values['output-directory'] ?? OPERATION_CLIENT_DIRECTORY;
  const sources = await createOperationClientSources(createCatalogSnapshot());
  await mkdir(directory, { recursive: true });
  for (const [fileName, source] of sources) {
    const path = join(directory, fileName);
    await Bun.write(path, source);
    console.log(`wrote ${path}`);
  }
}
