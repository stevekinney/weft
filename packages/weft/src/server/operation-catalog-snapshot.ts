import type { FaultCode } from '../core/fault-code.ts';
import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import { compareStrings, normalizeJsonObject } from './json-schema-utilities.ts';
import type { ErasedOperation, OperationKind, TransportAvailability } from './operation-catalog.ts';
import type { ParamSource, ResponseShape } from './rest-binding.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';

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
 * import { createCatalogSnapshot, type CatalogRestBindingSnapshot } from '@lostgradient/weft';
 *
 * const routes = createCatalogSnapshot()
 *   .operations.map((operation) => operation.rest)
 *   .filter((rest): rest is CatalogRestBindingSnapshot => rest !== undefined);
 *
 * console.log(routes.length, 'operations are reachable over REST');
 * ```
 */
export type CatalogRestBindingSnapshot = {
  readonly method: string;
  readonly path: string;
  readonly inputSources: Readonly<Record<string, ParamSource>>;
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
 * import type { CatalogAccessSnapshot } from '@lostgradient/weft';
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
 * import { createCatalogSnapshot, type CatalogOperationSnapshot } from '@lostgradient/weft';
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
  readonly name: string;
  readonly kind: OperationKind;
  readonly summary: string;
  /** Optional longer-form prose; present only for the interactive subset. */
  readonly description?: string;
  readonly tags: ReadonlyArray<string>;
  readonly destructive: boolean;
  readonly access: CatalogAccessSnapshot;
  readonly parameterizedAccess?: {
    readonly discriminator: string;
    readonly defaultValue?: string;
    readonly variants: ReadonlyArray<{
      readonly value: string;
      readonly access: CatalogAccessSnapshot;
    }>;
  };
  readonly transports: TransportAvailability;
  readonly producibleFaults: ReadonlyArray<FaultCode>;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
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
 * import { createCatalogSnapshot, type CatalogSnapshot } from '@lostgradient/weft';
 *
 * const snapshot: CatalogSnapshot = createCatalogSnapshot();
 * console.log(snapshot.version, snapshot.operations.length);
 * ```
 */
export type CatalogSnapshot = {
  readonly generatedBy: 'weft catalog snapshot';
  readonly version: 1;
  readonly operations: ReadonlyArray<CatalogOperationSnapshot>;
};

/**
 * Capture the operation surface as a {@link CatalogSnapshot}, defaulting to
 * every operation this build registers.
 *
 * The result is deterministic — operations sorted by name, schemas normalised
 * — so two snapshots of the same build are byte-identical and a real surface
 * change is the only thing that shows up in a diff. That is what makes it safe
 * to commit one and regenerate clients from it.
 *
 * Pass `sourceOperations` to snapshot a deliberately narrowed set, which is
 * mainly useful in tests that assert on one operation's recorded shape.
 *
 * @example
 * ```ts
 * import { createCatalogSnapshot } from '@lostgradient/weft';
 *
 * const snapshot = createCatalogSnapshot();
 * const destructive = snapshot.operations
 *   .filter((operation) => operation.destructive)
 *   .map((operation) => operation.name);
 *
 * console.log('guard these behind confirmation:', destructive);
 * ```
 */
export function createCatalogSnapshot(
  sourceOperations: ReadonlyArray<ErasedOperation> = createLiveOperationRegistry().list(),
): CatalogSnapshot {
  const restBindings = new Map(
    createLiveRestBindings().map((binding) => [binding.operationName, binding] as const),
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
 * import { createCatalogSnapshot, stringifyCatalogSnapshot } from '@lostgradient/weft';
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
  restBinding: ReturnType<typeof createLiveRestBindings>[number] | undefined,
): CatalogOperationSnapshot {
  const eventSchema = operation.eventSchema;
  return {
    name: operation.name,
    kind: operation.kind ?? 'unary',
    summary: operation.summary,
    ...(operation.description === undefined ? {} : { description: operation.description }),
    tags: [...operation.tags].toSorted(compareStrings),
    destructive: operation.destructive ?? false,
    access: accessToSnapshot(operation.access),
    ...(operation.parameterizedAccess === undefined
      ? {}
      : { parameterizedAccess: parameterizedAccessToSnapshot(operation.parameterizedAccess) }),
    transports: { ...operation.transports },
    producibleFaults: [...(operation.producibleFaults ?? [])].toSorted(compareStrings),
    inputSchema: normalizeJsonObject(definitionSchemaToJsonSchema(operation.inputSchema, 'input')),
    outputSchema: normalizeJsonObject(
      definitionSchemaToJsonSchema(operation.outputSchema, 'output'),
    ),
    ...(eventSchema === undefined
      ? {}
      : { eventSchema: normalizeJsonObject(definitionSchemaToJsonSchema(eventSchema, 'output')) }),
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
