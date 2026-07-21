import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import { compareStrings, normalizeJsonObject } from '../server/json-schema-utilities.ts';
import type {
  ErasedOperation,
  OperationKind,
  TransportAvailability,
} from '../server/operation-catalog.ts';
import type { FaultCode } from '../server/operation-fault.ts';
import type { ParamSource, ResponseShape } from '../server/rest-binding.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from '../server/rest-bindings.ts';

export type CatalogRestBindingSnapshot = {
  readonly method: string;
  readonly path: string;
  readonly inputSources: Readonly<Record<string, ParamSource>>;
  readonly success: ResponseShape;
};

export type CatalogAccessSnapshot =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'optionalAuth'; readonly scopes: ReadonlyArray<string> }
  | { readonly kind: 'scoped'; readonly scopes: ReadonlyArray<string> }
  | {
      readonly kind: 'scopedAlternatives';
      readonly alternatives: ReadonlyArray<ReadonlyArray<string>>;
    };

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

export type CatalogSnapshot = {
  readonly generatedBy: 'weft catalog snapshot';
  readonly version: 1;
  readonly operations: ReadonlyArray<CatalogOperationSnapshot>;
};

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
