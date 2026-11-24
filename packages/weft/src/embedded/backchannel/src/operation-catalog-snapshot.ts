import type { FaultCode } from './fault-code.ts';
import { compareStrings, normalizeJsonObject } from './json-schema-utilities.ts';
import type { ErasedOperation, OperationKind, TransportAvailability } from './operation-catalog.ts';
import type { ParamSource, ResponseShape, RestBindingDescription } from './rest-binding.ts';
import { zodToJsonSchema } from './zod-json-schema.ts';

/**
 * One operation's REST route as the catalog records it: the HTTP method and
 * server-side path, where each input field travels, and the shape of a
 * successful response.
 *
 * This is the snapshot's own record of the route. The generated client carries
 * the same facts in `CLIENT_REST_OPERATION_BINDINGS`, with the `/v1` prefix
 * already stripped — use that one to call Weft, and this one to describe it.
 *
 * @example
 * ```ts
 * import { type CatalogRestBindingSnapshot } from '@lostgradient/backchannel';
 * import { createCatalogSnapshot } from '@lostgradient/weft';
 *
 * const routes = createCatalogSnapshot()
 *   .operations.map((operation) => operation.rest)
 *   .filter((rest): rest is CatalogRestBindingSnapshot => rest !== undefined);
 *
 * console.log(routes.length, 'operations are reachable over REST');
 * ```
 */
export type CatalogRestBindingSnapshot = {
  /** The HTTP method. */
  readonly method: string;
  /** The path template, with `:name` parameters. */
  readonly path: string;
  /** Where each input field travels: path, query, header or body. */
  readonly inputSources: Readonly<Record<string, ParamSource>>;
  /** What a successful response looks like. */
  readonly success: ResponseShape;
};

/**
 * What an operation demands of its caller, as a discriminated union on `kind`:
 * nothing (`public`), any valid token (`authenticated`), specific scopes
 * (`scoped`), scopes only when a token is present (`optionalAuth`), or any one
 * of several scope sets (`scopedAlternatives`).
 *
 * Narrow on `kind` before reading `scopes` or `alternatives` — only some
 * variants carry them. `scopedAlternatives` is a disjunction: holding every
 * scope in any single inner array is enough.
 *
 * @example
 * ```ts
 * import type { CatalogAccessSnapshot } from '@lostgradient/backchannel';
 *
 * declare const access: CatalogAccessSnapshot;
 *
 * switch (access.kind) {
 *   case 'public':
 *     console.log('no credentials needed');
 *     break;
 *   case 'scoped':
 *     console.log('requires all of:', access.scopes.join(', '));
 *     break;
 *   case 'scopedAlternatives':
 *     console.log('requires any one set of:', access.alternatives.length);
 *     break;
 *   default:
 *     console.log('requires a token');
 * }
 * ```
 */
export type CatalogAccessSnapshot =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'optionalAuth'; readonly scopes: ReadonlyArray<string> }
  | { readonly kind: 'scoped'; readonly scopes: ReadonlyArray<string> }
  | {
      readonly kind: 'scopedAlternatives';
      readonly alternatives: ReadonlyArray<ReadonlyArray<string>>;
    };

/**
 * Everything the catalog records about one operation: its name and summary,
 * the access it demands, which transports serve it, the faults it can raise,
 * and JSON Schema for its input and output.
 *
 * This is the unit the code generators consume — `weft codegen` and the
 * generated operation client both read these records rather than reaching into
 * the live registry. Read one when you need to answer a question about an
 * operation without calling it: whether it is destructive, whether it is
 * reachable over JSON-RPC, what shape its input takes.
 *
 * @example
 * ```ts
 * import { type CatalogOperationSnapshot } from '@lostgradient/backchannel';
 * import { createCatalogSnapshot } from '@lostgradient/weft';
 *
 * const byName = new Map<string, CatalogOperationSnapshot>(
 *   createCatalogSnapshot().operations.map((operation) => [operation.name, operation]),
 * );
 *
 * const alerts = byName.get('weft.alerts.list');
 * console.log(alerts?.summary, alerts?.transports.jsonRpcHttp);
 * ```
 */
export type CatalogOperationSnapshot = {
  /** The operation's name. */
  readonly name: string;
  /** Whether the operation is unary, a stream or a subscription. */
  readonly kind: OperationKind;
  /** A one-line description of the operation. */
  readonly summary: string;
  /** Optional longer-form prose; present only for the interactive subset. */
  readonly description?: string;
  /** The groups the operation belongs to; the first names its domain. */
  readonly tags: ReadonlyArray<string>;
  /** Whether the operation changes or deletes state. */
  readonly destructive: boolean;
  /**
   * `true` when the operation's input takes a boolean `dryRun` that performs its authorization
   * and validation, writes nothing, and answers what the call would do; absent otherwise.
   */
  readonly supportsDryRun?: true;
  /** The operation's access policy. */
  readonly access: CatalogAccessSnapshot;
  /** The input field the required scope depends on, with its variants. */
  readonly parameterizedAccess?: {
    readonly discriminator: string;
    readonly defaultValue?: string;
    readonly variants: ReadonlyArray<{
      readonly value: string;
      readonly access: CatalogAccessSnapshot;
    }>;
  };
  /** Which transports serve the operation. */
  readonly transports: TransportAvailability;
  /** The fault codes the operation can produce. */
  readonly producibleFaults: ReadonlyArray<FaultCode>;
  /** The JSON Schema of the operation's input. */
  readonly inputSchema: Record<string, unknown>;
  /** The JSON Schema of the operation's output. */
  readonly outputSchema: Record<string, unknown>;
  /** The JSON Schema of each event, for a stream or subscription operation. */
  readonly eventSchema?: Record<string, unknown>;
  /** Declarative REST route metadata for generated client transports. */
  readonly rest?: CatalogRestBindingSnapshot;
};

/**
 * A complete, serialisable description of a server's operation surface: every
 * {@link CatalogOperationSnapshot}, sorted by name, under a version stamp.
 *
 * Think of it as the API's contract in data form. Vendor one into a repository
 * and `weft codegen --from` will generate a client against exactly that
 * surface, so builds stay reproducible and a server upgrade becomes a visible
 * diff instead of a silent change. `version` is the snapshot format's own
 * version, not the server's.
 *
 * @example
 * ```ts
 * import { type CatalogSnapshot } from '@lostgradient/backchannel';
 * import { createCatalogSnapshot } from '@lostgradient/weft';
 *
 * const snapshot: CatalogSnapshot = createCatalogSnapshot();
 * console.log(snapshot.version, snapshot.operations.length);
 * ```
 */
export type CatalogSnapshot = {
  /** The tool that wrote the snapshot. */
  readonly generatedBy: 'weft catalog snapshot';
  /** The snapshot format version. */
  readonly version: 1;
  /** Every operation in the catalog. */
  readonly operations: ReadonlyArray<CatalogOperationSnapshot>;
};

/**
 * Capture a set of operations, and the REST routes that serve them, as a
 * {@link CatalogSnapshot}.
 *
 * The result is deterministic: operations sorted by name, schemas normalised,
 * so two snapshots of the same surface are byte-identical and a real surface
 * change is the only thing that shows up in a diff. That is what makes it safe
 * to commit one and regenerate clients from it.
 *
 * A server supplies its own `operations` and `restBindings`. Weft's
 * `createCatalogSnapshot` supplies every operation and route this build
 * registers.
 */
export function snapshotOperationCatalog(options: {
  readonly operations: ReadonlyArray<ErasedOperation>;
  readonly restBindings: ReadonlyArray<RestBindingDescription>;
}): CatalogSnapshot {
  const sourceOperations = options.operations;
  const restBindings = new Map(
    options.restBindings.map((binding) => [binding.operationName, binding] as const),
  );
  const operations = sourceOperations
    .map((operation) =>
      operationToSnapshot(
        operation,
        (operation.kind ?? 'unary') === 'unary' &&
          operation.transports.http &&
          !operation.transports.jsonRpcHttp &&
          !operation.tags.includes('Storage')
          ? restBindings.get(operation.name)
          : undefined,
      ),
    )
    .toSorted((left, right) => compareStrings(left.name, right.name));

  return {
    generatedBy: 'weft catalog snapshot',
    version: 1,
    operations,
  };
}

/**
 * Serialise a {@link CatalogSnapshot} the way Weft writes it to disk:
 * two-space indentation and a trailing newline.
 *
 * Use this rather than `JSON.stringify` when the output is going into a file.
 * The formatting is part of the contract — a vendored snapshot written any
 * other way produces a whole-file diff on the next regeneration, which buries
 * the surface change you actually wanted to review.
 *
 * @example
 * ```ts
 * import { stringifyCatalogSnapshot } from '@lostgradient/backchannel';
 * import { createCatalogSnapshot } from '@lostgradient/weft';
 *
 * const serialized = stringifyCatalogSnapshot(createCatalogSnapshot());
 *
 * console.log(serialized.endsWith('\n')); // true
 * ```
 */
export function stringifyCatalogSnapshot(snapshot: CatalogSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function operationToSnapshot(
  operation: ErasedOperation,
  restBinding: RestBindingDescription | undefined,
): CatalogOperationSnapshot {
  const eventSchema = operation.eventSchema;
  return {
    name: operation.name,
    kind: operation.kind ?? 'unary',
    summary: operation.summary,
    ...(operation.description === undefined ? {} : { description: operation.description }),
    tags: [...operation.tags].toSorted(compareStrings),
    destructive: operation.destructive ?? false,
    ...(operation.supportsDryRun === true ? { supportsDryRun: true as const } : {}),
    access: accessToSnapshot(operation.access),
    ...(operation.parameterizedAccess === undefined
      ? {}
      : { parameterizedAccess: parameterizedAccessToSnapshot(operation.parameterizedAccess) }),
    transports: { ...operation.transports },
    producibleFaults: [...(operation.producibleFaults ?? [])].toSorted(compareStrings),
    inputSchema: normalizeJsonObject(zodToJsonSchema(operation.inputSchema, 'input')),
    outputSchema: normalizeJsonObject(zodToJsonSchema(operation.outputSchema, 'output')),
    ...(eventSchema === undefined
      ? {}
      : { eventSchema: normalizeJsonObject(zodToJsonSchema(eventSchema, 'output')) }),
    ...(restBinding === undefined
      ? {}
      : {
          rest: {
            method: restBinding.method,
            path: restBinding.path,
            inputSources: Object.fromEntries(
              Object.entries(restBinding.inputSources).filter(
                (entry): entry is [string, ParamSource] => entry[1] !== undefined,
              ),
            ),
            success: { ...restBinding.success },
          },
        }),
  };
}

function parameterizedAccessToSnapshot(
  hint: NonNullable<ErasedOperation['parameterizedAccess']>,
): NonNullable<CatalogOperationSnapshot['parameterizedAccess']> {
  return {
    discriminator: hint.discriminator,
    ...(hint.defaultValue === undefined ? {} : { defaultValue: hint.defaultValue }),
    variants: hint.variants
      .map((variant) => ({
        value: variant.value,
        access: accessToSnapshot(variant.access),
      }))
      .toSorted((left, right) => compareStrings(left.value, right.value)),
  };
}

function accessToSnapshot(access: ErasedOperation['access']): CatalogAccessSnapshot {
  if (access.kind === 'public') return { kind: 'public' };
  if (access.kind === 'authenticated') return { kind: 'authenticated' };
  if (access.kind === 'scoped') {
    return { kind: 'scoped', scopes: [...access.scopes.scopes].toSorted(compareStrings) };
  }
  if (access.kind === 'optionalAuth') {
    return {
      kind: 'optionalAuth',
      scopes: [...access.authenticatedScopes.scopes].toSorted(compareStrings),
    };
  }
  return {
    kind: 'scopedAlternatives',
    alternatives: access.alternatives.map((alternative) =>
      [...alternative.scopes].toSorted(compareStrings),
    ),
  };
}
