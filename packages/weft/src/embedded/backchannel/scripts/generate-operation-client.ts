/**
 * Generates a typed client for any operation catalog.
 *
 * The core, {@link createOperationClientSources}, takes a catalog snapshot and the options that
 * name the catalog's package, its server and its connection, and returns the generated files as a
 * map from file name to source. It reads no file and imports no formatter: the caller writes the
 * files and passes the formatter, so the package depends on neither `prettier` nor a file system.
 * The generated client imports `@lostgradient/backchannel/client` for its runtime.
 *
 * @module generator
 */

import type { CatalogOperationSnapshot, CatalogSnapshot } from '../src/index.ts';
import { compareStrings } from '../src/internals.ts';

import { join } from 'node:path';

import { renderAliasDeclarations, selectAliases } from './operation-client-aliases.ts';
import {
  GENERATED_HEADER,
  operationDomains,
  operationDomainSource,
  subscriptionTypesSource,
  type OperationDomainName,
} from './operation-client-domains.ts';
import { schemaToNode } from './operation-client-schema.ts';

export type { OperationDomainName } from './operation-client-domains.ts';

/**
 * How the generated factory reaches its server: the connection type the factory takes, the
 * function that turns a connection into a transport, and the words that document both.
 *
 * @example
 * ```ts
 * import type { OperationClientConnection } from '@lostgradient/backchannel/generator';
 *
 * const connection: OperationClientConnection = {
 *   typeName: 'JsonRpcHttpConnection',
 *   transportName: 'httpJsonRpcTransport',
 *   importSpecifier: '@lostgradient/backchannel/client',
 *   description: ['Pass the base URL of the handler.'],
 *   example: "{ baseUrl: 'https://api.example.test' }",
 * };
 * console.log(connection.typeName);
 * ```
 */
export type OperationClientConnection = {
  /** The name of the connection type the generated factory takes. */
  readonly typeName: string;
  /** The name of the function that turns a connection into a `CatalogTransport`. */
  readonly transportName: string;
  /** The module the connection type and the transport function are imported from. */
  readonly importSpecifier: string;
  /** The factory parameter's default, such as `{}`; absent when the connection is required. */
  readonly defaultValue?: string | undefined;
  /** The lines of prose that say how the connection resolves, for the factory's documentation. */
  readonly description: readonly string[];
  /** The source of an example connection, for the factory's documentation; may span lines. */
  readonly example: string;
};

/**
 * Operation names the generated documentation uses in its examples. Each defaults to a name the
 * snapshot holds, so a catalog that names none still gets examples that refer to its own
 * operations.
 *
 * @example
 * ```ts
 * import type { OperationClientExamples } from '@lostgradient/backchannel/generator';
 *
 * const examples: OperationClientExamples = { list: 'probe.list', cancel: 'probe.cancel' };
 * console.log(examples.list);
 * ```
 */
export type OperationClientExamples = {
  /** An operation callable over JSON-RPC that takes and returns data. */
  readonly list?: string | undefined;
  /** An operation callable over JSON-RPC, for the example that checks callability. */
  readonly callable?: string | undefined;
  /** An operation whose input type the examples name. */
  readonly cancel?: string | undefined;
  /** An operation served over REST only, for the example of a client over every operation. */
  readonly restOnly?: string | undefined;
  /** A subscription, for the example that iterates its events. */
  readonly subscription?: string | undefined;
};

/**
 * Which subscriptions get a generated method, and where their route is served. A catalog composed
 * from two hosts lists the subscriptions of both, but only one host serves the route its client
 * reaches, so `include` picks that host's operations and `pathPrefix` names where it mounts them.
 *
 * @example
 * ```ts
 * import type { OperationClientSubscriptionRoutes } from '@lostgradient/backchannel/generator';
 *
 * const routes: OperationClientSubscriptionRoutes = {
 *   include: (operation) => operation.name.startsWith('probe.'),
 *   pathPrefix: '/probe/v1/subscriptions',
 * };
 * console.log(routes.pathPrefix);
 * ```
 */
export type OperationClientSubscriptionRoutes = {
  /** Whether a subscription gets a method. Defaults to every subscription with an HTTP route. */
  readonly include?: ((operation: CatalogOperationSnapshot) => boolean) | undefined;
  /** The path the routes are served under, before the operation name. Defaults to `/v1/subscriptions`. */
  readonly pathPrefix?: string | undefined;
};

/**
 * What {@link createOperationClientSources} needs to know about the catalog's package, beyond its
 * snapshot. Nothing here is specific to one catalog: a package names itself, its server, its
 * factory and its connection, and says where the generated files go and how to format them.
 *
 * @example
 * ```ts
 * import type { OperationClientOptions } from '@lostgradient/backchannel/generator';
 *
 * const options: OperationClientOptions = {
 *   packageName: '@example/probe',
 *   serverName: 'Probe',
 *   factoryName: 'createProbeClient',
 *   outputDirectory: 'src/client/generated',
 *   format: async (source) => source,
 * };
 * console.log(options.factoryName);
 * ```
 */
export type OperationClientOptions = {
  /** The package the generated examples import from. */
  readonly packageName: string;
  /** What the documentation calls the server: `a remote ${serverName} server`. */
  readonly serverName: string;
  /** The name of the generated factory, such as `createProbeClient`. */
  readonly factoryName: string;
  /** The directory the files are written to, which the formatter resolves its configuration from. */
  readonly outputDirectory: string;
  /** The name of the main generated file. Defaults to `operation-client.generated.ts`. */
  readonly outputFile?: string | undefined;
  /** The module the generated client imports its runtime from. Defaults to `@lostgradient/backchannel/client`. */
  readonly runtimeSpecifier?: string | undefined;
  /** The prefix the server serves its REST paths under, which the client's paths omit. Defaults to none. */
  readonly restPathPrefix?: string | undefined;
  /** Catalog tags whose REST-only operations the generic JSON request transport cannot carry. */
  readonly excludedRestTags?: readonly string[] | undefined;
  /** How the factory reaches its server. Defaults to a base URL and headers over JSON-RPC HTTP. */
  readonly connection?: OperationClientConnection | undefined;
  /** Operation names for the examples. */
  readonly examples?: OperationClientExamples | undefined;
  /** Groups operations into generated files. Defaults to the operation's first tag. */
  readonly domainName?: OperationDomainName | undefined;
  /**
   * Whether to emit a method for each subscription the generic handler serves over Server-Sent
   * Events at `GET ${routePrefix}/:operationName`. `'generic'` emits one for every operation of kind
   * `subscription` whose HTTP route is enabled; `'none'`, the default, emits none. The methods open
   * their stream with the connection's `baseUrl`, `headers` and `fetch`, so a custom `connection`
   * must have them.
   */
  readonly subscriptions?: 'generic' | 'none' | undefined;
  /** Narrows the subscription methods, and says where their route is served. */
  readonly subscriptionRoutes?: OperationClientSubscriptionRoutes | undefined;
  /** Formats one generated file. The package imports no formatter, so the caller brings it. */
  readonly format: (source: string, filePath: string) => Promise<string>;
};

const DEFAULT_RUNTIME_SPECIFIER = '@lostgradient/backchannel/client';
const DEFAULT_OUTPUT_FILE = 'operation-client.generated.ts';
const SUBSCRIPTION_TYPES_FILE = 'subscription-operations.generated.ts';
const DEFAULT_SUBSCRIPTION_ROUTE_PREFIX = '/v1/subscriptions';

/**
 * Generate a typed client from a catalog snapshot: one file of types per domain, a file of shared
 * type aliases when any repeat, and the main file that holds the operation names, the REST
 * bindings, the type maps and the factory. Output is deterministic for a given snapshot and
 * options, so a checked-in copy can be compared against a fresh run.
 *
 * @example
 * ```ts
 * import { createOperationClientSources } from '@lostgradient/backchannel/generator';
 *
 * const sources = await createOperationClientSources(
 *   { generatedBy: 'weft catalog snapshot', version: 1, operations: [] },
 *   {
 *     packageName: '@example/probe',
 *     serverName: 'Probe',
 *     factoryName: 'createProbeClient',
 *     outputDirectory: 'src/client/generated',
 *     format: async (source) => source,
 *   },
 * );
 * console.log([...sources.keys()]);
 * ```
 */
export async function createOperationClientSources(
  snapshot: CatalogSnapshot,
  options: OperationClientOptions,
): Promise<ReadonlyMap<string, string>> {
  const outputFile = options.outputFile ?? DEFAULT_OUTPUT_FILE;
  const runtimeSpecifier = options.runtimeSpecifier ?? DEFAULT_RUNTIME_SPECIFIER;
  const restPathPrefix = options.restPathPrefix ?? '';
  const excludedRestTags = options.excludedRestTags ?? [];
  const connection = options.connection ?? defaultConnection(runtimeSpecifier);

  const catalogOperations = snapshot.operations
    .filter((operation) => operation.kind === 'unary' && operation.transports.jsonRpcHttp)
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const restOnlyOperations = snapshot.operations
    .filter((operation) => isGenericRestClientOperation(operation, excludedRestTags))
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const clientOperations = [...catalogOperations, ...restOnlyOperations].toSorted((left, right) =>
    compareStrings(left.name, right.name),
  );
  const catalogNames = catalogOperations.map((operation) => `  '${operation.name}',`);
  const clientNames = clientOperations.map((operation) => `  '${operation.name}',`);
  const restBindings = restOnlyOperations.map((operation) => {
    const rest = operation.rest;
    if (rest === undefined) throw new Error(`missing REST binding for ${operation.name}`);
    const clientPath =
      restPathPrefix !== '' && rest.path.startsWith(restPathPrefix)
        ? rest.path.slice(restPathPrefix.length)
        : rest.path;
    return `  '${operation.name}': ${JSON.stringify({ ...rest, path: clientPath })},`;
  });

  const subscriptionOperations = selectSubscriptions(snapshot, options);

  const roots = [
    ...clientOperations.flatMap((operation) => [
      schemaToNode(operation.inputSchema),
      schemaToNode(operation.outputSchema),
    ]),
    ...subscriptionOperations.flatMap((operation) => [
      schemaToNode(operation.inputSchema),
      schemaToNode(operation.eventSchema ?? {}),
    ]),
  ];

  const { aliasNameByKey, nodeByKey } = selectAliases(roots);
  const domains = operationDomains(clientOperations, options.domainName);
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

  if (subscriptionOperations.length)
    sources.set(
      SUBSCRIPTION_TYPES_FILE,
      subscriptionTypesSource(subscriptionOperations, aliasNameByKey),
    );

  const names = exampleNames(
    options.examples,
    catalogOperations,
    restOnlyOperations,
    subscriptionOperations,
  );
  sources.set(
    outputFile,
    mainSource({
      options,
      connection,
      runtimeSpecifier,
      restPathPrefix,
      imports,
      types,
      catalogNames,
      clientNames,
      restBindings,
      subscriptionNames: subscriptionOperations.map((operation) => `  '${operation.name}',`),
      names,
    }),
  );

  const formatted = new Map<string, string>();
  for (const [fileName, contents] of sources) {
    formatted.set(
      fileName,
      await options.format(contents, join(options.outputDirectory, fileName)),
    );
  }
  return formatted;
}

/**
 * The subscriptions that get a method: with `subscriptions: 'generic'`, every operation of kind
 * `subscription` whose HTTP route is enabled and that the route options let through.
 */
function selectSubscriptions(
  snapshot: CatalogSnapshot,
  options: OperationClientOptions,
): CatalogOperationSnapshot[] {
  if (options.subscriptions !== 'generic') return [];
  const include = options.subscriptionRoutes?.include ?? (() => true);
  return snapshot.operations
    .filter(
      (operation) =>
        operation.kind === 'subscription' && operation.transports.http && include(operation),
    )
    .toSorted((left, right) => compareStrings(left.name, right.name));
}

function defaultConnection(runtimeSpecifier: string): OperationClientConnection {
  return {
    typeName: 'JsonRpcHttpConnection',
    transportName: 'httpJsonRpcTransport',
    importSpecifier: runtimeSpecifier,
    description: [
      'Pass the base URL of the handler, absolute or a path the browser resolves, and any',
      'headers every call needs.',
    ],
    example: "{ baseUrl: 'https://api.example.test' }",
  };
}

type ExampleNames = {
  readonly list: string;
  readonly callable: string;
  readonly cancel: string;
  readonly restOnly: string;
  readonly subscription: string;
};

/** Each example name the caller left out falls back to an operation the snapshot holds. */
function exampleNames(
  examples: OperationClientExamples | undefined,
  catalogOperations: readonly CatalogOperationSnapshot[],
  restOnlyOperations: readonly CatalogOperationSnapshot[],
  subscriptionOperations: readonly CatalogOperationSnapshot[],
): ExampleNames {
  const first = catalogOperations[0]?.name ?? 'example.operation';
  return {
    list: examples?.list ?? first,
    callable: examples?.callable ?? first,
    cancel: examples?.cancel ?? first,
    restOnly: examples?.restOnly ?? restOnlyOperations[0]?.name ?? first,
    subscription: examples?.subscription ?? subscriptionOperations[0]?.name ?? first,
  };
}

type MainSourceInput = {
  readonly options: OperationClientOptions;
  readonly connection: OperationClientConnection;
  readonly runtimeSpecifier: string;
  readonly restPathPrefix: string;
  readonly imports: string;
  readonly types: string;
  readonly catalogNames: readonly string[];
  readonly clientNames: readonly string[];
  readonly restBindings: readonly string[];
  readonly subscriptionNames: readonly string[];
  readonly names: ExampleNames;
};

function importList(names: readonly string[]): string {
  return names.map((name) => `  ${name},`).join('\n');
}

function runtimeImports(input: MainSourceInput): string {
  const { connection, runtimeSpecifier } = input;
  const runtimeNames = [
    'createCatalogClient',
    'type ClientRestOperationBinding',
    'type CatalogClient',
    ...(input.subscriptionNames.length > 0
      ? ['createSubscriptionClient', 'sseSubscriptionTransport', 'type SubscriptionClient']
      : []),
  ];
  const connectionNames = [connection.transportName, `type ${connection.typeName}`];
  if (connection.importSpecifier === runtimeSpecifier) {
    return `import {\n${importList([...runtimeNames, ...connectionNames])}\n} from '${runtimeSpecifier}';`;
  }
  return `import {\n${importList(runtimeNames)}\n} from '${runtimeSpecifier}';\nimport {\n${importList(connectionNames)}\n} from '${connection.importSpecifier}';`;
}

function pathNote(restPathPrefix: string): string {
  return restPathPrefix === ''
    ? 'Paths are as the server serves them.'
    : `Paths are client-relative: the server's \`${restPathPrefix}\` prefix is stripped.`;
}

function mainSource(input: MainSourceInput): string {
  const { options, connection, restPathPrefix, names } = input;
  const packageName = options.packageName;
  const server = options.serverName;
  const factory = options.factoryName;
  const exampleLines = connection.example
    .split('\n')
    .map((line, index) => (index === 0 ? line : ` * ${line}`))
    .join('\n');
  const description = connection.description
    .map((line, index) => (index === 0 ? line : ` * ${line}`))
    .join('\n');
  const parameter = `connection: ${connection.typeName}${
    connection.defaultValue === undefined ? '' : ` = ${connection.defaultValue}`
  }`;

  const subscribed = input.subscriptionNames.length > 0;
  const subscriptionTypesImport = subscribed
    ? `\nimport type { SubscriptionOperationTypes } from './${SUBSCRIPTION_TYPES_FILE}';`
    : '';
  const routePrefix = options.subscriptionRoutes?.pathPrefix ?? DEFAULT_SUBSCRIPTION_ROUTE_PREFIX;

  return `${GENERATED_HEADER}
${input.imports}${subscriptionTypesImport}

${runtimeImports(input)}

/**
 * Every unary operation this server exposes over JSON-RPC, sorted by name.
 *
 * This is exactly the set {@link ${factory}} turns into client methods,
 * so it also answers "can I call this over JSON-RPC?" at runtime — worth
 * checking when the name arrived as a string from a CLI argument or a queued
 * job, before you hand it to the client.
 *
 * @example
 * \`\`\`ts
 * import { CATALOG_OPERATION_NAMES } from '${packageName}';
 *
 * const requested = '${names.callable}';
 * const callable = CATALOG_OPERATION_NAMES.some((name) => name === requested);
 * console.log(callable); // true
 * \`\`\`
 */
export const CATALOG_OPERATION_NAMES = [
${input.catalogNames.join('\n')}
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
 * const operation: CatalogOperationName = '${names.list}';
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
${input.clientNames.join('\n')}
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
 * const operation: ClientOperationName = '${names.list}';
 * console.log(operation);
 * \`\`\`
 */
export type ClientOperationName = (typeof CLIENT_OPERATION_NAMES)[number];

/**
 * HTTP method, path template and input placement for each operation the client
 * reaches over REST rather than JSON-RPC.
 *
 * The generated client already uses this table to build its requests, so read
 * it directly only when you are working outside the client — proxying ${server}
 * behind your own router, or writing a gateway that has to reproduce the same
 * routes. ${pathNote(restPathPrefix)}
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
${input.restBindings.join('\n')}
} as const satisfies Readonly<Record<string, ClientRestOperationBinding>>;

/**
 * Input and output types for every operation the client can reach, keyed by
 * operation name and assembled from the per-domain generated modules.
 *
 * You seldom name this directly — {@link ${factory}} applies it for you.
 * It earns its keep when you write code generic over operations, such as a
 * logging or retry wrapper that has to preserve each operation's own input and
 * output types instead of widening them to \`unknown\`.
 *
 * @example
 * \`\`\`ts
 * import type { ClientOperationTypes } from '${packageName}';
 *
 * type CancelInput = ClientOperationTypes['${names.cancel}']['input'];
 *
 * declare const input: CancelInput;
 * console.log(input);
 * \`\`\`
 */
export type ClientOperationTypes = ${input.types};

/**
 * The {@link ClientOperationTypes} entries for operations reachable over
 * JSON-RPC, which is the surface {@link ${factory}} builds against.
 *
 * Use this rather than {@link ClientOperationTypes} when your code runs
 * against a JSON-RPC transport and should not reference an operation that only
 * exists over REST.
 *
 * @example
 * \`\`\`ts
 * import type { CatalogOperationTypes } from '${packageName}';
 *
 * type AlertsOutput = CatalogOperationTypes['${names.list}']['output'];
 *
 * declare const alerts: AlertsOutput;
 * console.log(alerts);
 * \`\`\`
 */
export type CatalogOperationTypes = Pick<ClientOperationTypes, CatalogOperationName>;

/**
 * A client shaped over the JSON-RPC operations in {@link CatalogOperationTypes}.
 * This is the type returned by {@link ${factory}}.
 *
 * @example
 * \`\`\`ts
 * import type { CatalogOperations } from '${packageName}';
 *
 * declare const client: CatalogOperations;
 * const listAlerts = client['${names.list}'];
 * console.log(typeof listAlerts);
 * \`\`\`
 */
export type CatalogOperations = CatalogClient<CatalogOperationTypes>;

/**
 * A client shaped over every operation, REST included: each operation name is
 * a method taking that operation's input and resolving to its output.
 *
 * {@link ${factory}} returns the narrower {@link CatalogOperations} shape. Name this
 * one when you build a client over a transport that also covers the REST-only
 * operations.
 *
 * @example
 * \`\`\`ts
 * import type { ClientOperations } from '${packageName}';
 *
 * declare const client: ClientOperations;
 * const diagnostics = client['${names.restOnly}'];
 * console.log(typeof diagnostics);
 * \`\`\`
 */
export type ClientOperations = CatalogClient<ClientOperationTypes>;
${subscribed ? subscriptionBlock(input) : ''}
/**
 * Build a typed client for a remote ${server} server, with one method per operation
 * in {@link CATALOG_OPERATION_NAMES}${subscribed ? ' and one per subscription in {@link SUBSCRIPTION_OPERATION_NAMES}' : ''}.
 *
 * Calls travel as JSON-RPC over HTTP. ${description}
 *
 * @example
 * \`\`\`ts
 * import { ${factory}, type ClientOperationTypes } from '${packageName}';
 *
 * const client = ${factory}(${exampleLines});
 *
 * declare const input: ClientOperationTypes['${names.list}']['input'];
 * const alerts = await client['${names.list}'](input);
 * console.log(alerts);
 * \`\`\`
 */
${
  subscribed
    ? `export function ${factory}(${parameter}): CatalogOperations & SubscriptionOperations {
  return {
    ...createCatalogClient<CatalogOperationTypes>(
      CATALOG_OPERATION_NAMES,
      ${connection.transportName}(connection),
    ),
    ...createSubscriptionClient<SubscriptionOperationTypes>(
      SUBSCRIPTION_OPERATION_NAMES,
      sseSubscriptionTransport({ ...connection, routePrefix: ${JSON.stringify(routePrefix)} }),
    ),
  };
}`
    : `export function ${factory}(${parameter}): CatalogOperations {
  return createCatalogClient<CatalogOperationTypes>(
    CATALOG_OPERATION_NAMES,
    ${connection.transportName}(connection),
  );
}`
}
`;
}

/** The names, the type and the type map of the subscription methods, with their documentation. */
function subscriptionBlock(input: MainSourceInput): string {
  const { options, names } = input;
  const packageName = options.packageName;
  return `
/**
 * Every subscription this server streams over Server-Sent Events, sorted by name.
 *
 * This is exactly the set {@link ${options.factoryName}} turns into subscription methods.
 *
 * @example
 * \`\`\`ts
 * import { SUBSCRIPTION_OPERATION_NAMES } from '${packageName}';
 *
 * console.log(SUBSCRIPTION_OPERATION_NAMES.length);
 * \`\`\`
 */
export const SUBSCRIPTION_OPERATION_NAMES = [
${input.subscriptionNames.join('\n')}
] as const;

/**
 * The name of any subscription the generated client opens — the union behind
 * {@link SUBSCRIPTION_OPERATION_NAMES}.
 *
 * @example
 * \`\`\`ts
 * import type { SubscriptionOperationName } from '${packageName}';
 *
 * const operation: SubscriptionOperationName = '${names.subscription}';
 * console.log(operation);
 * \`\`\`
 */
export type SubscriptionOperationName = (typeof SUBSCRIPTION_OPERATION_NAMES)[number];

/**
 * A client shaped over the subscriptions in {@link SubscriptionOperationTypes}: each name is a
 * method taking that operation's input and an optional \`{ signal, fetch, lastEventId }\`, and
 * returning an \`AsyncIterable\` of its typed events and one replay-complete marker.
 *
 * @example
 * \`\`\`ts
 * import type { SubscriptionOperations } from '${packageName}';
 *
 * declare const client: SubscriptionOperations;
 * const controller = new AbortController();
 *
 * for await (const message of client['${names.subscription}']({}, { signal: controller.signal })) {
 *   if (message.type === 'event') console.log(message.id, message.data);
 * }
 * \`\`\`
 */
export type SubscriptionOperations = SubscriptionClient<SubscriptionOperationTypes>;
`;
}

/**
 * Ordinary REST-only unary operations can use the generated JSON request
 * transport. A tag in `excludedTags` marks operations whose octet-stream and NDJSON wire formats
 * need a byte-oriented facade rather than schema-shaped JSON.
 */
function isGenericRestClientOperation(
  operation: CatalogOperationSnapshot,
  excludedTags: readonly string[],
): boolean {
  if (operation.kind !== 'unary') return false;
  if (!operation.transports.http || operation.transports.jsonRpcHttp) return false;
  if (excludedTags.some((tag) => operation.tags.includes(tag))) return false;
  const rest = operation.rest;
  if (rest === undefined || rest.success.kind === 'streaming') return false;
  return Object.values(rest.inputSources).every(
    (source) => source.kind !== 'body' || source.mediaType !== 'application/octet-stream',
  );
}
