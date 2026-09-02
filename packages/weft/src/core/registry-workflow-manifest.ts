/**
 * Build one registered workflow's {@link WorkflowRevisionManifest} — the
 * per-workflow entry/message/scoped-activity conversion `buildRegistrySnapshot`
 * (`registry-snapshot.ts`) folds into every manifest in a full snapshot, and
 * that {@link buildWorkflowManifestForType} exposes standalone for a caller
 * that wants one or a few workflows' manifests without reading, hashing, or
 * being bounded by the rest of the engine's registrations.
 *
 * Split out of `registry-snapshot.ts` specifically so `buildWorkerManifestFromRegistry`
 * (`worker/manifest/registry-contract-builder.ts`) can depend on
 * {@link buildWorkflowManifestForType} without also inheriting
 * `buildRegistrySnapshot`'s full-snapshot `RegistryWorkflowCountLimitError`
 * aggregate check, or an *unrelated* registered workflow's own
 * {@link RegistryManifestLimitError} — neither is the right contract for a
 * caller that only ever looks up the handful of workflows it names.
 *
 * @module core/registry-workflow-manifest
 */
import { compareCodepoint } from './compare-codepoint.ts';
import {
  buildWorkflowRevisionManifest,
  type WorkflowActivityContract,
  type WorkflowRevisionManifest,
} from './contract/index.ts';
import type { Engine } from './engine.ts';
import { convertSchema } from './registry-schema-conversion.ts';
import { toWorkflowContractDraft } from './registry-workflow-contract-draft.ts';
import type { DefinitionSchema } from './types/definition-schema.ts';
import type { RegisteredWorkflowDefinition } from './types/workflow-registry.ts';
import { WeftError } from './weft-error.ts';

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
 * Thrown when a registered workflow's contract cannot be published as a
 * {@link WorkflowRevisionManifest} because it exceeds one of the WFT-5
 * hostile-input limits (`core/contract/limits.ts`) — an identifier over
 * `MAX_CONTRACT_IDENTIFIER_BYTES`, too many signal/update/query/activity
 * entries, a schema nested past `MAX_CONTRACT_SCHEMA_DEPTH`, or a
 * normalized contract over `MAX_NORMALIZED_CONTRACT_BYTES`. Nothing in
 * engine registration enforces those bounds (`name-grammar.ts` has no
 * length cap; `description`/`tags`/`version`/schema depth are unbounded at
 * registration time), so a registration the engine happily accepts can
 * still fail here, at manifest-build time. Mirrors
 * `RegistrySchemaConversionError`'s masked-500 handling in
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
 * Convert one workflow's `.activities({...})`-scoped registrations
 * (`Engine.listWorkflowActivityDefinitions`, WFT-6) into the
 * `{ inputSchema?, outputSchema? }` pairs `WorkflowContract.activities`
 * carries, sorted alphabetically by name for deterministic output. These
 * are folded into the workflow's own manifest contract — not
 * `RegistrySnapshot.activities`, the flat catalog `buildActivityEntry`
 * (`registry-snapshot.ts`) feeds — so a scoped activity's schema change
 * moves the owning workflow's `contractHash`/`revision`, the same way it
 * moves a worker manifest's contract in
 * `worker/manifest/registry-contract-builder.ts`. An activity with neither
 * schema declared still contributes an empty `{}` entry: its *presence*
 * under this workflow, not just its schema, is part of the contract.
 */
function buildWorkflowScopedActivityContracts(
  engine: Engine,
  workflowType: string,
): Record<string, WorkflowActivityContract> {
  // Null-prototype: an activity literally named `__proto__` is
  // grammar-valid (see name-grammar.ts) — same rationale as `activities`
  // and `activeRevisions` in `registry-snapshot.ts`.
  const activities = Object.create(null) as Record<string, WorkflowActivityContract>;
  const scoped = engine
    .listWorkflowActivityDefinitions(workflowType)
    .toSorted((a, b) => compareCodepoint(a.name, b.name));
  for (const metadata of scoped) {
    const entityName = `${workflowType}.activities.${metadata.name}`;
    const contract: {
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    } = {};
    if (metadata.inputSchema !== undefined) {
      contract.inputSchema = convertSchema(
        'activity',
        entityName,
        'inputSchema',
        metadata.inputSchema,
      );
    }
    if (metadata.outputSchema !== undefined) {
      contract.outputSchema = convertSchema(
        'activity',
        entityName,
        'outputSchema',
        metadata.outputSchema,
      );
    }
    activities[metadata.name] = contract;
  }
  return activities;
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
 * Build one registered workflow's {@link WorkflowRevisionManifest}, folding
 * in its `.activities({...})`-scoped registrations (WFT-6). Shared by
 * `buildRegistrySnapshot`'s per-workflow `Promise.all` and
 * {@link buildWorkflowManifestForType}'s single-workflow lookup, so the two
 * call paths can never disagree on what one workflow's manifest contains.
 *
 * Throws {@link RegistryManifestLimitError} if `definition`'s contract
 * exceeds a WFT-5 hostile-input limit.
 */
export async function buildOneWorkflowManifest(
  engine: Engine,
  definition: RegisteredWorkflowDefinition,
): Promise<WorkflowRevisionManifest> {
  const entry = buildWorkflowEntry(definition);
  const workflowScopedActivities = buildWorkflowScopedActivityContracts(engine, definition.type);
  const contract = toWorkflowContractDraft(
    definition.type,
    definition.version,
    entry,
    workflowScopedActivities,
  );
  try {
    return await buildWorkflowRevisionManifest(contract);
  } catch (cause) {
    throw new RegistryManifestLimitError(definition.type, cause);
  }
}

/**
 * Build a single registered workflow's {@link WorkflowRevisionManifest} —
 * the scoped counterpart to `buildRegistrySnapshot` for a caller that wants
 * one or a few workflows' manifests without reading, hashing, or being
 * bounded by the rest of the engine's registrations.
 * `buildWorkerManifestFromRegistry` (`worker/manifest/registry-contract-builder.ts`)
 * is exactly that caller: it resolves only the workflows its own
 * caller-declared `options.workflows` names, so neither
 * `RegistryWorkflowCountLimitError` (an aggregate, whole-snapshot concern)
 * nor an unrelated registration's own {@link RegistryManifestLimitError}
 * should ever block it from producing an otherwise-valid,
 * independently-bounded worker manifest for the workflows it actually
 * asked for.
 *
 * Returns `undefined` if `workflowType` is not registered on `engine` — the
 * caller decides how to report that (`buildWorkerManifestFromRegistry`
 * throws `WorkerManifestBuildError`, naming the type).
 *
 * Throws a schema-conversion error if the registered schema fails JSON
 * Schema conversion, or {@link RegistryManifestLimitError} if the contract
 * exceeds a WFT-5 hostile-input limit.
 */
export async function buildWorkflowManifestForType(
  engine: Engine,
  workflowType: string,
): Promise<WorkflowRevisionManifest | undefined> {
  const definition = engine.getWorkflowDefinition(workflowType);
  if (definition === undefined) return undefined;
  return buildOneWorkflowManifest(engine, definition);
}
