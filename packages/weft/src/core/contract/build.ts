/**
 * Convert an authoring-time workflow definition into a {@link WorkflowContract}.
 *
 * Every `DefinitionSchema` (workflow input/output, every signal/update/query,
 * every activity, the finalizer) is converted through the existing
 * `definitionSchemaToJsonSchema()` — this module does not reimplement schema
 * conversion, and it does not reimplement the "unsupported construct emits
 * `unknown`" behavior, which lives entirely in `weft codegen`'s emitter.
 *
 * @module core/contract/build
 */

import { definitionSchemaToJsonSchema } from '../types/definition-schema-to-json.ts';
import type { DefinitionSchema } from '../types/definition-schema.ts';
import { DEFAULT_WORKFLOW_VERSION } from '../versioning.ts';
import { WeftError } from '../weft-error.ts';
import { normalizeWorkflowContract } from './normalize.ts';
import type {
  WorkflowActivityContract,
  WorkflowContract,
  WorkflowContractActivitySource,
  WorkflowContractMessageSource,
  WorkflowContractSource,
  WorkflowMessageContract,
} from './types.ts';

/** Discriminates which part of a workflow contract source failed conversion. */
type ContractEntityKind = 'workflow' | 'signal' | 'update' | 'query' | 'activity' | 'finalizer';

/**
 * Thrown when {@link buildWorkflowContract} cannot convert a registered
 * `DefinitionSchema` to JSON Schema — no built-in vendor adapter and no
 * structural `~standard.jsonSchema` converter. Mirrors
 * `RegistrySchemaConversionError`'s `entityKind`/`entityName`/`direction`
 * fields; not root-exported, matching that error's precedent (build-tooling
 * errors surfaced to the caller of the builder, not part of the public error
 * vocabulary).
 *
 * @example
 * ```ts
 * import { WorkflowContractConversionError } from '@lostgradient/weft';
 *
 * try {
 *   throw new WorkflowContractConversionError('activity', 'charge', 'inputSchema', new Error('boom'));
 * } catch (error) {
 *   console.log(error instanceof WorkflowContractConversionError); // true
 * }
 * ```
 */
export class WorkflowContractConversionError extends WeftError<'WorkflowContractConversionError'> {
  readonly entityKind: ContractEntityKind;
  readonly entityName: string;
  readonly direction: 'inputSchema' | 'outputSchema';

  constructor(
    entityKind: ContractEntityKind,
    entityName: string,
    direction: 'inputSchema' | 'outputSchema',
    cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      'WorkflowContractConversionError',
      `Failed to convert ${direction} for ${entityKind} "${entityName}": ${causeMessage}`,
      { cause },
    );
    this.entityKind = entityKind;
    this.entityName = entityName;
    this.direction = direction;
  }
}

function convertSchema(
  entityKind: ContractEntityKind,
  entityName: string,
  direction: 'inputSchema' | 'outputSchema',
  schema: DefinitionSchema,
): Record<string, unknown> {
  try {
    return definitionSchemaToJsonSchema(schema, direction === 'inputSchema' ? 'input' : 'output');
  } catch (cause) {
    throw new WorkflowContractConversionError(entityKind, entityName, direction, cause);
  }
}

function buildMessageContract(
  entityKind: ContractEntityKind,
  entityName: string,
  source: WorkflowContractMessageSource,
): WorkflowMessageContract {
  const entry: { inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> } =
    {};
  if (source.inputSchema !== undefined) {
    entry.inputSchema = convertSchema(entityKind, entityName, 'inputSchema', source.inputSchema);
  }
  if (source.outputSchema !== undefined) {
    entry.outputSchema = convertSchema(entityKind, entityName, 'outputSchema', source.outputSchema);
  }
  return entry;
}

function buildActivityContract(
  workflowName: string,
  activityName: string,
  source: WorkflowContractActivitySource,
): WorkflowActivityContract {
  return buildMessageContract('activity', `${workflowName}.${activityName}`, source);
}

function buildMessageRecord(
  workflowName: string,
  entityKind: 'signal' | 'update' | 'query',
  sources: Readonly<Record<string, WorkflowContractMessageSource>> | undefined,
): Readonly<Record<string, WorkflowMessageContract>> | undefined {
  if (sources === undefined) return undefined;
  const localKeys = Object.keys(sources);
  if (localKeys.length === 0) return undefined;

  // Key by each definition's own `.name` — the wire name
  // `normalizeMessageDefinitions()` (`core/engine/registration.ts`) actually
  // registers under — not by the JS object key the caller used in
  // `.signals({...})`/`.updates({...})`/`.queries({...})`, which may alias a
  // different local name (e.g. `.signals({ localAlias: signal('wireName') })`).
  const built: Record<string, WorkflowMessageContract> = Object.create(null) as Record<
    string,
    WorkflowMessageContract
  >;
  for (const localKey of localKeys) {
    const source = sources[localKey] as WorkflowContractMessageSource;
    const wireName = source.name;
    built[wireName] = buildMessageContract(
      entityKind,
      `${workflowName}.${entityKind}.${wireName}`,
      source,
    );
  }
  return built;
}

function buildActivityRecord(
  workflowName: string,
  sources: Readonly<Record<string, WorkflowContractActivitySource>> | undefined,
): Readonly<Record<string, WorkflowActivityContract>> | undefined {
  if (sources === undefined) return undefined;
  const names = Object.keys(sources);
  if (names.length === 0) return undefined;

  const built: Record<string, WorkflowActivityContract> = Object.create(null) as Record<
    string,
    WorkflowActivityContract
  >;
  for (const name of names) {
    built[name] = buildActivityContract(
      workflowName,
      name,
      sources[name] as WorkflowContractActivitySource,
    );
  }
  return built;
}

/** Mutable draft of a {@link WorkflowContract}, built up field by field before being returned. */
type ContractDraft = {
  name: string;
  workflowVersion: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  signals?: Readonly<Record<string, WorkflowMessageContract>>;
  updates?: Readonly<Record<string, WorkflowMessageContract>>;
  queries?: Readonly<Record<string, WorkflowMessageContract>>;
  activities?: Readonly<Record<string, WorkflowActivityContract>>;
  finalizer?: WorkflowActivityContract;
};

function applyDescriptionAndTags(draft: ContractDraft, source: WorkflowContractSource): void {
  if (source.description !== undefined) draft.description = source.description;
  if (source.tags !== undefined && source.tags.length > 0) draft.tags = [...source.tags];
}

function applySchemas(draft: ContractDraft, source: WorkflowContractSource): void {
  if (source.inputSchema !== undefined) {
    draft.inputSchema = convertSchema('workflow', source.name, 'inputSchema', source.inputSchema);
  }
  if (source.outputSchema !== undefined) {
    draft.outputSchema = convertSchema(
      'workflow',
      source.name,
      'outputSchema',
      source.outputSchema,
    );
  }
}

function applyMessageRecords(draft: ContractDraft, source: WorkflowContractSource): void {
  const signals = buildMessageRecord(source.name, 'signal', source.signals);
  if (signals !== undefined) draft.signals = signals;
  const updates = buildMessageRecord(source.name, 'update', source.updates);
  if (updates !== undefined) draft.updates = updates;
  const queries = buildMessageRecord(source.name, 'query', source.queries);
  if (queries !== undefined) draft.queries = queries;
}

/**
 * Build a normalized {@link WorkflowContract} from an authoring-time workflow
 * definition.
 *
 * Accepts anything structurally matching {@link WorkflowContractSource} —
 * both `WorkflowDefinition` and `BuiltWorkflowDefinition` (the return type
 * of `workflow({...}).execute(fn)`) satisfy it directly, with no cast.
 *
 * Throws {@link WorkflowContractConversionError} if any declared schema
 * (workflow input/output, a signal/update/query input/output, an activity
 * input/output, or the finalizer's input/output) cannot be converted to JSON
 * Schema.
 *
 * @example
 * ```ts
 * import { buildWorkflowContract } from '@lostgradient/weft';
 *
 * const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
 * console.log(contract.name, contract.workflowVersion); // checkout 2.1.0
 * ```
 */
export function buildWorkflowContract(source: WorkflowContractSource): WorkflowContract {
  const draft: ContractDraft = {
    name: source.name,
    workflowVersion: source.version ?? DEFAULT_WORKFLOW_VERSION,
  };

  applyDescriptionAndTags(draft, source);
  applySchemas(draft, source);
  applyMessageRecords(draft, source);

  const activities = buildActivityRecord(source.name, source.activities);
  if (activities !== undefined) draft.activities = activities;

  if (source.finalizer !== undefined) {
    draft.finalizer = buildMessageContract(
      'finalizer',
      `${source.name}.finalizer`,
      source.finalizer,
    );
  }

  return normalizeWorkflowContract(draft);
}
