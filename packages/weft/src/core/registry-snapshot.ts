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
 * **v2.** Each registered workflow's schema/description/tags/message
 * metadata is packaged as a {@link WorkflowRevisionManifest} (`core/contract`,
 * WFT-5) rather than a flat `Record<name, entry>` — `workflows` is a sorted
 * array and `activeRevisions` is the `name -> revision` pointer map a
 * consumer resolves the "currently active" manifest through. Building a
 * manifest hashes the normalized contract (`crypto.subtle`), so this module
 * is async where v1 was not.
 *
 * **Ordering guarantee.** `workflows` is sorted by `(name, revision)` via
 * {@link compareWorkflowManifests} — see that export's JSDoc for why the
 * revision tiebreak can never actually fire through this builder.
 * `activities` keys are inserted in alphabetical (codepoint) order, and
 * signal/update/query keys inside each manifest's `contract` the same way.
 * Workflow and activity names cannot be integer-like (the name grammar
 * requires a leading letter or underscore), but signal/update/query names
 * accept any string, so integer-like message names could theoretically be
 * reordered by JS engines despite the explicit sort. Clients that want to
 * protect themselves from future registry sources should still sort
 * `Object.keys(...)` before presenting or diffing snapshot entries.
 *
 * @module core/registry-snapshot
 */
import type { ActivityMetadata } from './activity-registry.ts';
import {
  buildWorkflowRevisionManifest,
  type WorkflowContract,
  type WorkflowRevisionManifest,
} from './contract/index.ts';
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
export const REGISTRY_VERSION = 2;

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
  /** Schema metadata for the workflow's definition-level finalizer activity, when registered. */
  finalizer?: RegistryMessageEntry;
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
 *
 * `workflows` carries one {@link WorkflowRevisionManifest} per registered
 * workflow, sorted by {@link compareWorkflowManifests}. `activeRevisions`
 * points each workflow name at the `revision` of its currently active
 * manifest in `workflows` — today that is always the manifest a consumer
 * resolves, since the engine registers exactly one implementation per name;
 * the pointer exists so a future multi-revision registry source does not
 * require another wire-shape bump. `activities` is unchanged from v1: a
 * flat `Record<name, entry>`, since activities are not versioned contracts.
 */
export type RegistrySnapshot = {
  registryVersion: typeof REGISTRY_VERSION;
  /** ISO-8601 generation timestamp. Informational only — excluded from codegen input validation and any determinism/drift comparison. */
  generatedAt: string;
  workflows: readonly WorkflowRevisionManifest[];
  activeRevisions: Readonly<Record<string, string>>;
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
 * Thrown when a registered workflow's contract cannot be published as a
 * {@link WorkflowRevisionManifest} because it exceeds one of the WFT-5
 * hostile-input limits (`core/contract/limits.ts`) — an identifier over
 * `MAX_CONTRACT_IDENTIFIER_BYTES`, too many signal/update/query/activity
 * entries, a schema nested past `MAX_CONTRACT_SCHEMA_DEPTH`, or a
 * normalized contract over `MAX_NORMALIZED_CONTRACT_BYTES`. Nothing in
 * engine registration enforces those bounds (`name-grammar.ts` has no
 * length cap; `description`/`tags`/`version`/schema depth are unbounded at
 * registration time), so a registration the engine happily accepts can
 * still fail here, at snapshot build time. Mirrors
 * {@link RegistrySchemaConversionError}'s masked-500 handling in
 * `server/operations/get-registry.ts`: the wire response stays a generic
 * `500 / Internal server error`, and `workflowType` plus the underlying
 * limit reason reach server-side logs only.
 */
export class RegistryManifestLimitError extends WeftError<'RegistryManifestLimitError'> {
  readonly workflowType: string;

  constructor(workflowType: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      'RegistryManifestLimitError',
      `Registered workflow "${workflowType}" cannot be published to the registry: ${causeMessage}`,
      { cause },
    );
    this.workflowType = workflowType;
  }
}

/**
 * Order two workflow revision manifests by `(name, revision)`. `workflows`
 * is sorted with this comparator so registry output is deterministic
 * regardless of registration order.
 *
 * The `revision` tiebreak can never actually fire through
 * {@link buildRegistrySnapshot}: the engine registers at most one
 * implementation per workflow name, so `name` alone is already unique
 * within one snapshot. It exists, and is exported, so a future
 * multi-revision registry source (or this function in isolation) has a
 * total order to rely on, and so the tiebreak itself has direct unit-test
 * coverage independent of engine registration uniqueness.
 */
export function compareWorkflowManifests(
  a: Pick<WorkflowRevisionManifest, 'name' | 'revision'>,
  b: Pick<WorkflowRevisionManifest, 'name' | 'revision'>,
): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.revision < b.revision) return -1;
  if (a.revision > b.revision) return 1;
  return 0;
}

/** Mutable draft of the {@link WorkflowContract} one registry workflow entry projects into. */
type WorkflowContractDraft = {
  name: string;
  workflowVersion: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  signals?: Readonly<Record<string, RegistryMessageEntry>>;
  updates?: Readonly<Record<string, RegistryMessageEntry>>;
  queries?: Readonly<Record<string, RegistryMessageEntry>>;
  finalizer?: RegistryMessageEntry;
};

function applyDraftIdentityAndSchemas(
  draft: WorkflowContractDraft,
  entry: RegistryWorkflowEntry,
): void {
  if (entry.description !== undefined) draft.description = entry.description;
  if (entry.tags !== undefined && entry.tags.length > 0) draft.tags = entry.tags;
  if (entry.inputSchema !== undefined) draft.inputSchema = entry.inputSchema;
  if (entry.outputSchema !== undefined) draft.outputSchema = entry.outputSchema;
}

function applyDraftMessageRecords(
  draft: WorkflowContractDraft,
  entry: RegistryWorkflowEntry,
): void {
  if (entry.signals !== undefined && Object.keys(entry.signals).length > 0) {
    draft.signals = entry.signals;
  }
  if (entry.updates !== undefined && Object.keys(entry.updates).length > 0) {
    draft.updates = entry.updates;
  }
  if (entry.queries !== undefined && Object.keys(entry.queries).length > 0) {
    draft.queries = entry.queries;
  }
}

/**
 * Project a converted {@link RegistryWorkflowEntry} (schemas already turned
 * into JSON Schema by {@link buildWorkflowEntry}) into the
 * `core/contract` {@link WorkflowContract} shape `buildWorkflowRevisionManifest`
 * consumes. Deliberately does not re-run schema conversion — `entry`'s
 * schemas are already `Record<string, unknown>` JSON Schema, structurally
 * identical to what `WorkflowContract` expects, so re-converting through
 * `buildWorkflowContract` (which expects raw `DefinitionSchema`) would
 * double-convert and risk a different error shape for the same failure.
 * Never sets `activities`: the registry's activity catalog is a flat,
 * workflow-independent map (`RegistrySnapshot.activities`), not scoped per
 * workflow, so there is nothing here to attach.
 */
function toWorkflowContractDraft(
  workflowType: string,
  workflowVersion: string,
  entry: RegistryWorkflowEntry,
): WorkflowContract {
  const draft: WorkflowContractDraft = { name: workflowType, workflowVersion };
  applyDraftIdentityAndSchemas(draft, entry);
  applyDraftMessageRecords(draft, entry);
  if (entry.finalizer !== undefined) draft.finalizer = entry.finalizer;
  return draft;
}

/** Options accepted by {@link buildRegistrySnapshot}. */
export interface BuildRegistrySnapshotOptions {
  /**
   * Clock used for `generatedAt`. Defaults to `Date.now`; exists solely so
   * tests can pin `generatedAt` for exact-equality assertions. Production
   * call sites never pass this.
   */
  now?: () => number;
}

/**
 * Build a registry snapshot from an engine's locally-registered workflows
 * and activities. Remote-only activities (those advertised by a remote
 * worker but never registered with the local engine) are excluded by
 * construction — `engine.listActivityDefinitions()` is the only source.
 *
 * `engine.listWorkflowDefinitions()`/`listActivityDefinitions()` are read
 * synchronously in one eager pass before any `await`, so a workflow
 * registered concurrently mid-build simply does not appear in that call's
 * snapshot — the same eventual-consistency behavior v1's fully-synchronous
 * builder had. No torn or partial manifest is possible.
 *
 * Throws {@link RegistrySchemaConversionError} if any registered schema
 * fails JSON Schema conversion, or {@link RegistryManifestLimitError} if a
 * registered workflow's contract exceeds a WFT-5 hostile-input limit.
 */
export async function buildRegistrySnapshot(
  engine: Engine,
  options?: BuildRegistrySnapshotOptions,
): Promise<RegistrySnapshot> {
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

  const manifests: WorkflowRevisionManifest[] = [];
  // Null-prototype: a workflow literally named `__proto__` is grammar-valid
  // (see name-grammar.ts) and must be stored as an own property rather than
  // mutate the prototype chain, which would silently drop it from JSON
  // output — same rationale as `workflows`/`activities` below.
  const activeRevisions = Object.create(null) as Record<string, string>;
  for (const definition of sortedWorkflows) {
    const entry = buildWorkflowEntry(definition);
    const contract = toWorkflowContractDraft(definition.type, definition.version, entry);
    let manifest: WorkflowRevisionManifest;
    try {
      manifest = await buildWorkflowRevisionManifest(contract);
    } catch (cause) {
      throw new RegistryManifestLimitError(definition.type, cause);
    }
    manifests.push(manifest);
    activeRevisions[definition.type] = manifest.revision;
  }
  const sortedManifests = manifests.toSorted(compareWorkflowManifests);

  const activities = Object.create(null) as Record<string, RegistryActivityEntry>;
  for (const metadata of sortedActivities) {
    activities[metadata.name] = buildActivityEntry(metadata);
  }

  const now = options?.now ?? Date.now;

  return {
    registryVersion: REGISTRY_VERSION,
    generatedAt: new Date(now()).toISOString(),
    workflows: sortedManifests,
    activeRevisions,
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
  addFinalizerEntry(entry, definition);
  return entry;
}

function addFinalizerEntry(
  entry: RegistryWorkflowEntry,
  definition: RegisteredWorkflowDefinition,
): void {
  if (definition.finalizer === undefined) return;
  const entityName = `${definition.type}.finalizer`;
  const finalizerEntry: RegistryMessageEntry = {};
  if (definition.finalizer.inputSchema !== undefined) {
    finalizerEntry.inputSchema = convertSchema(
      'workflow',
      entityName,
      'inputSchema',
      definition.finalizer.inputSchema,
    );
  }
  if (definition.finalizer.outputSchema !== undefined) {
    finalizerEntry.outputSchema = convertSchema(
      'workflow',
      entityName,
      'outputSchema',
      definition.finalizer.outputSchema,
    );
  }
  entry.finalizer = finalizerEntry;
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

/**
 * Convert one activity's catalog metadata to its `RegistryActivityEntry`
 * projection (schema pair plus queue/description/retry/timeout). Exported
 * so build tooling that resolves a single activity outside a full
 * {@link buildRegistrySnapshot} pass — see
 * `worker/manifest/registry-contract-builder.ts`'s workflow-scoped-first
 * activity resolution — can reuse the same conversion rather than
 * reimplementing it.
 */
export function buildActivityEntry(metadata: ActivityMetadata): RegistryActivityEntry {
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
