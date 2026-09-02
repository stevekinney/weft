/**
 * Shared JSON Schema conversion for the registry snapshot builder
 * (`core/registry-snapshot.ts`) and its sibling projection module
 * (`core/registry-workflow-contract-draft.ts`'s workflow-scoped-activity
 * folding). Lives in a leaf module — the same placement rationale as
 * `worker/manifest/limits.ts` — so both can depend on it without forming an
 * import cycle between them.
 *
 * @module core/registry-schema-conversion
 */
import { definitionSchemaToJsonSchema } from './types/definition-schema-to-json.ts';
import type { DefinitionSchema } from './types/definition-schema.ts';
import { WeftError } from './weft-error.ts';

/**
 * Thrown when a registered workflow or activity schema cannot be converted
 * to JSON Schema. Carries the offending entity name and direction so
 * server-side observability (logs and telemetry) and non-HTTP callers
 * (the in-process MCP builder, programmatic users of `buildRegistrySnapshot`)
 * can identify which registration is broken. The HTTP REST binding
 * deliberately masks this on the wire as a generic `500 / Internal server
 * error` so a misbehaving registration cannot leak schema layout to clients
 * that only have `system:read`.
 */
export class RegistrySchemaConversionError extends WeftError<'RegistrySchemaConversionError'> {
  readonly entityKind: 'workflow' | 'activity';
  readonly entityName: string;
  readonly direction: 'inputSchema' | 'outputSchema';

  constructor(
    entityKind: 'workflow' | 'activity',
    entityName: string,
    direction: 'inputSchema' | 'outputSchema',
    cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      'RegistrySchemaConversionError',
      `Failed to convert ${direction} for ${entityKind} "${entityName}": ${causeMessage}`,
      { cause },
    );
    this.entityKind = entityKind;
    this.entityName = entityName;
    this.direction = direction;
  }
}

/** Convert one `DefinitionSchema` fragment to JSON Schema, wrapping a conversion failure as {@link RegistrySchemaConversionError}. */
export function convertSchema(
  entityKind: 'workflow' | 'activity',
  entityName: string,
  field: 'inputSchema' | 'outputSchema',
  schema: DefinitionSchema,
): Record<string, unknown> {
  try {
    const direction = field === 'inputSchema' ? 'input' : 'output';
    return definitionSchemaToJsonSchema(schema, direction);
  } catch (cause) {
    throw new RegistrySchemaConversionError(entityKind, entityName, field, cause);
  }
}
