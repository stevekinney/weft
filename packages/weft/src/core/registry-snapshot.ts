/**
 * Pure builder that captures a snapshot of the engine's locally-registered
 * workflows and activities, with their JSON Schemas. This is the data source
 * behind the `GET /v1/registry` REST endpoint and (later) the MCP server.
 *
 * The output is a plain object designed to be safe for JSON serialization.
 * Absent metadata fields are omitted (never `null`, never `{}`); converter
 * exceptions surface as a typed {@link RegistrySchemaConversionError} (see
 * its JSDoc for what reaches the wire vs server logs).
 *
 * **Ordering guarantee.** Builder code inserts workflow, activity, signal,
 * update, and query keys in alphabetical (codepoint) order. Workflow and
 * activity names cannot be integer-like (the name grammar requires a leading
 * letter or underscore), but signal/update/query names accept any string, so
 * integer-like message names could theoretically be reordered by JS engines
 * despite the explicit sort. Clients that want to protect themselves from
 * future registry sources should still sort `Object.keys(...)` before
 * presenting or diffing snapshot entries.
 *
 * @module core/registry-snapshot
 */
import type { ActivityMetadata } from './activity-registry.ts';
import type { Engine } from './engine.ts';
import { definitionSchemaToJsonSchema } from './types/definition-schema-to-json.ts';
import type { DefinitionSchema } from './types/definition-schema.ts';
import type { RegisteredWorkflowDefinition } from './types/workflow-registry.ts';
import { WeftError } from './weft-error.ts';

/**
 * Current registry contract version. Future incompatible changes to the
 * snapshot shape must bump this number; the codegen CLI rejects unknown
 * versions with a clear upgrade message.
 */
export const REGISTRY_VERSION = 1;

/** Schema metadata reported for a statically registered workflow message. */
export type RegistryMessageEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

/** Metadata reported per workflow in a registry snapshot. */
export type RegistryWorkflowEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  description?: string;
  tags?: ReadonlyArray<string>;
  signals?: Record<string, RegistryMessageEntry>;
  updates?: Record<string, RegistryMessageEntry>;
  queries?: Record<string, RegistryMessageEntry>;
};

/**
 * Metadata reported per activity in a registry snapshot.
 *
 * `tags` is intentionally omitted: the registry feeds `weft codegen`, which
 * models activities as TypeScript function signatures. Tags are catalog
 * metadata for documentation/observability surfaces and don't appear on a
 * function type. Workflows include tags because the workflow registry
 * augmentation point (`WorkflowRegistry`) is an interface where extra
 * metadata can be attached structurally; activity names are now typed
 * per-workflow via the builder's `.activities({...})` step, so there is no
 * global activity-type registry to attach metadata to.
 */
export type RegistryActivityEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Engine assigns a default queue when none is specified, so this is always populated. */
  queue: string;
  description?: string;
  retry?: ActivityMetadata['retry'];
  timeout?: ActivityMetadata['timeout'];
};

/**
 * Snapshot of every locally-registered workflow and activity, suitable for
 * serialization as the `GET /v1/registry` response body.
 */
export type RegistrySnapshot = {
  registryVersion: 1;
  workflows: Record<string, RegistryWorkflowEntry>;
  activities: Record<string, RegistryActivityEntry>;
};

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

/**
 * Build a registry snapshot from an engine's locally-registered workflows
 * and activities. Remote-only activities (those advertised by a remote
 * worker but never registered with the local engine) are excluded by
 * construction — `engine.listActivityDefinitions()` is the only source.
 *
 * Throws {@link RegistrySchemaConversionError} if any registered schema
 * fails JSON Schema conversion.
 */
export function buildRegistrySnapshot(engine: Engine): RegistrySnapshot {
  const workflowDefinitions = engine.listWorkflowDefinitions();
  const activityDefinitions = engine.listActivityDefinitions();

  // Sort with explicit codepoint comparators rather than `localeCompare`
  // (project rule: deterministic comparisons in runtime logic).
  const sortedWorkflows = workflowDefinitions.toSorted((a, b) => {
    if (a.type < b.type) return -1;
    if (a.type > b.type) return 1;
    return 0;
  });
  const sortedActivities = activityDefinitions.toSorted((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  // Use null-prototype objects so a workflow or activity literally named
  // `__proto__` is stored as an own property rather than mutating the
  // prototype chain (which would silently drop the entry from JSON output).
  const workflows = Object.create(null) as Record<string, RegistryWorkflowEntry>;
  for (const definition of sortedWorkflows) {
    workflows[definition.type] = buildWorkflowEntry(definition);
  }

  const activities = Object.create(null) as Record<string, RegistryActivityEntry>;
  for (const metadata of sortedActivities) {
    activities[metadata.name] = buildActivityEntry(metadata);
  }

  return {
    registryVersion: REGISTRY_VERSION,
    workflows,
    activities,
  };
}

function buildWorkflowEntry(definition: RegisteredWorkflowDefinition): RegistryWorkflowEntry {
  const entry: RegistryWorkflowEntry = {};
  if (definition.inputSchema !== undefined) {
    entry.inputSchema = convertSchema(
      'workflow',
      definition.type,
      'inputSchema',
      definition.inputSchema,
    );
  }
  if (definition.outputSchema !== undefined) {
    entry.outputSchema = convertSchema(
      'workflow',
      definition.type,
      'outputSchema',
      definition.outputSchema,
    );
  }
  if (definition.description !== undefined) {
    entry.description = definition.description;
  }
  if (definition.tags.length > 0) {
    entry.tags = [...definition.tags];
  }
  addWorkflowMessageEntries(entry, definition);
  return entry;
}

function addWorkflowMessageEntries(
  entry: RegistryWorkflowEntry,
  definition: RegisteredWorkflowDefinition,
): void {
  if (definition.signals !== undefined && Object.keys(definition.signals).length > 0) {
    entry.signals = buildMessageEntries(definition.type, 'signal', definition.signals);
  }
  if (definition.updates !== undefined && Object.keys(definition.updates).length > 0) {
    entry.updates = buildMessageEntries(definition.type, 'update', definition.updates);
  }
  if (definition.queries !== undefined && Object.keys(definition.queries).length > 0) {
    entry.queries = buildMessageEntries(definition.type, 'query', definition.queries);
  }
}

type RegisteredMessageDefinition = {
  readonly inputSchema?: DefinitionSchema;
  readonly outputSchema?: DefinitionSchema;
};

function buildMessageEntries(
  workflowType: string,
  messageKind: 'signal' | 'update' | 'query',
  definitions: Readonly<Record<string, RegisteredMessageDefinition>>,
): Record<string, RegistryMessageEntry> {
  const entries = Object.create(null) as Record<string, RegistryMessageEntry>;
  for (const name of Object.keys(definitions).toSorted()) {
    const definition = definitions[name];
    if (definition === undefined) continue;
    const entry: RegistryMessageEntry = {};
    const entityName = `${workflowType}.${messageKind}.${name}`;
    if (definition.inputSchema !== undefined) {
      entry.inputSchema = convertSchema(
        'workflow',
        entityName,
        'inputSchema',
        definition.inputSchema,
      );
    }
    if (definition.outputSchema !== undefined) {
      entry.outputSchema = convertSchema(
        'workflow',
        entityName,
        'outputSchema',
        definition.outputSchema,
      );
    }
    entries[name] = entry;
  }
  return entries;
}

function buildActivityEntry(metadata: ActivityMetadata): RegistryActivityEntry {
  const entry: RegistryActivityEntry = { queue: metadata.queue };
  if (metadata.inputSchema !== undefined) {
    entry.inputSchema = convertSchema(
      'activity',
      metadata.name,
      'inputSchema',
      metadata.inputSchema,
    );
  }
  if (metadata.outputSchema !== undefined) {
    entry.outputSchema = convertSchema(
      'activity',
      metadata.name,
      'outputSchema',
      metadata.outputSchema,
    );
  }
  if (metadata.description !== undefined) {
    entry.description = metadata.description;
  }
  if (metadata.retry !== undefined) {
    entry.retry = metadata.retry;
  }
  if (metadata.timeout !== undefined) {
    entry.timeout = metadata.timeout;
  }
  return entry;
}

function convertSchema(
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
