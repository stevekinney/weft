/**
 * The `schemas` engine option: whether every registered definition must
 * declare its schemas. Under the default `'optional'` a schema is metadata a
 * definition may omit. Under `'required'` registration rejects a definition
 * that leaves one undeclared with {@link DefinitionSchemaRequiredError}.
 *
 * The check runs at registration time only and never validates payloads.
 * It is deliberately separate from `buildRegistrationEntry()` and
 * `buildPerWorkflowActivityRegistry()`: the dynamic-source validation
 * pipeline calls those inside a `catch` that maps any error to
 * `invalid-definition`, which would hide which schema is missing.
 *
 * A payload-less message or activity is not exempt. At runtime a
 * `SignalDefinition<void>` is `{ name }`, indistinguishable from one whose
 * author forgot the schema, so it declares a schema that accepts
 * `undefined` instead, such as `z.undefined()`.
 *
 * @module core/engine/schema-policy
 */

import type { WorkflowDefinition } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import type { EngineConstructorOptions, ResolvedOptions } from './engine-internal-types.ts';

/**
 * Thrown when an engine constructed with `schemas: 'required'` is given a
 * workflow or activity definition that leaves a schema undeclared. Raised by
 * `engine.register()`, `Engine.create({ workflows, activities })`, and the
 * dynamic-source load behind `engine.resolveWorkflowSource()`, before anything
 * is registered or installed. When `engine.start()` loads a dynamic source, it
 * arrives as the `cause` of a `DynamicWorkflowSourceUnavailableError`.
 * `missing` lists every undeclared schema as a dotted path relative to the
 * definition, such as `inputSchema`, `finalizer.outputSchema`,
 * `signals.approve.inputSchema`, or `activities.charge.outputSchema`.
 *
 * @example
 * ```ts
 * import { DefinitionSchemaRequiredError, Engine, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine({ schemas: 'required' });
 * try {
 *   engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * } catch (error) {
 *   if (error instanceof DefinitionSchemaRequiredError) {
 *     console.error(error.definitionName, error.missing);
 *   }
 * }
 * ```
 */
export class DefinitionSchemaRequiredError extends WeftError<'DefinitionSchemaRequiredError'> {
  readonly definitionKind: 'workflow' | 'activity';
  readonly definitionName: string;
  readonly missing: ReadonlyArray<string>;

  constructor(
    definitionKind: 'workflow' | 'activity',
    definitionName: string,
    missing: ReadonlyArray<string>,
  ) {
    super(
      'DefinitionSchemaRequiredError',
      `The engine requires schemas (schemas: 'required'), but ${definitionKind} "${definitionName}" ` +
        `does not declare: ${missing.join(', ')}. A payload-less message or activity declares a ` +
        'schema that accepts undefined, such as z.undefined().',
    );
    this.definitionKind = definitionKind;
    this.definitionName = definitionName;
    this.missing = Object.freeze([...missing]);
  }
}

type SchemaFields = {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
};

type NamedSchemaFields = SchemaFields & { readonly name: string };

export function resolveSchemaPolicy(
  options: EngineConstructorOptions | undefined,
): ResolvedOptions['schemaPolicy'] {
  const policy = options?.schemas ?? 'optional';
  if (policy !== 'optional' && policy !== 'required') {
    throw new Error('options.schemas must be "optional" or "required" when provided');
  }
  return policy;
}

export function resolvePayloadValidation(
  options: EngineConstructorOptions | undefined,
): ResolvedOptions['payloadValidation'] {
  const mode = options?.payloadValidation ?? 'none';
  if (mode !== 'none' && mode !== 'inbound') {
    throw new Error('options.payloadValidation must be "none" or "inbound" when provided');
  }
  return mode;
}

/** Whether a schema field leaves a gap the active policy rejects. */
type SchemaGap = (schema: unknown) => boolean;

const isUndeclared: SchemaGap = (schema) => schema === undefined;

/** A declared schema with no runtime validator: it describes JSON Schema only. */
const cannotValidate: SchemaGap = (schema) =>
  schema !== undefined &&
  typeof (schema as { '~standard'?: { validate?: unknown } })['~standard']?.validate !== 'function';

function collectFields(
  gaps: string[],
  prefix: string,
  definition: SchemaFields,
  fields: ReadonlyArray<keyof SchemaFields>,
  isGap: SchemaGap,
): void {
  for (const field of fields) {
    if (isGap(definition[field])) gaps.push(`${prefix}${field}`);
  }
}

function collectNamed(
  gaps: string[],
  group: string,
  definitions: Readonly<Record<string, NamedSchemaFields>> | undefined,
  fields: ReadonlyArray<keyof SchemaFields>,
  isGap: SchemaGap,
): void {
  if (definitions === undefined) return;
  const sorted = Object.values(definitions).toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const definition of sorted) {
    collectFields(gaps, `${group}.${definition.name}.`, definition, fields, isGap);
  }
}

const BOTH = ['inputSchema', 'outputSchema'] as const;
const INPUT = ['inputSchema'] as const;

type WorkflowMessageMaps = {
  readonly activities?: Readonly<Record<string, NamedSchemaFields>>;
  readonly signals?: Readonly<Record<string, NamedSchemaFields>>;
  readonly updates?: Readonly<Record<string, NamedSchemaFields>>;
  readonly queries?: Readonly<Record<string, NamedSchemaFields>>;
  readonly uses?: Readonly<Record<string, NamedSchemaFields>>;
};

/**
 * Every schema `definition` leaves undeclared, as dotted paths: its own input
 * and output, its finalizer's, each signal's input, each update's and
 * query's input and output, and each per-workflow or `.uses()` activity's
 * input and output. A hand-rolled definition without the builder's message maps is
 * checked for what it has.
 */
export function collectMissingWorkflowSchemas(definition: WorkflowDefinition): string[] {
  const missing: string[] = [];
  collectFields(missing, '', definition, BOTH, isUndeclared);
  if (definition.finalizer !== undefined) {
    collectFields(missing, 'finalizer.', definition.finalizer as SchemaFields, BOTH, isUndeclared);
  }
  const maps = definition as WorkflowMessageMaps;
  collectNamed(missing, 'signals', maps.signals, INPUT, isUndeclared);
  collectNamed(missing, 'updates', maps.updates, BOTH, isUndeclared);
  collectNamed(missing, 'queries', maps.queries, BOTH, isUndeclared);
  collectNamed(missing, 'activities', maps.activities, BOTH, isUndeclared);
  collectNamed(missing, 'uses', maps.uses, BOTH, isUndeclared);
  return missing;
}

/**
 * Every inbound schema `definition` declares without a runtime validator: its
 * own input, and each signal's, update's, and query's input.
 */
function collectUnvalidatableInboundSchemas(definition: WorkflowDefinition): string[] {
  const gaps: string[] = [];
  collectFields(gaps, '', definition, INPUT, cannotValidate);
  const maps = definition as WorkflowMessageMaps;
  collectNamed(gaps, 'signals', maps.signals, INPUT, cannotValidate);
  collectNamed(gaps, 'updates', maps.updates, INPUT, cannotValidate);
  collectNamed(gaps, 'queries', maps.queries, INPUT, cannotValidate);
  return gaps;
}

/**
 * Enforce the registration-time half of both schema options: throw
 * {@link DefinitionSchemaRequiredError} when `schemaPolicy` is `'required'`
 * and `definition` omits a schema, and a `TypeError` when `payloadValidation`
 * is `'inbound'` and an inbound schema has no runtime validator to run.
 */
export function assertWorkflowSchemas(
  options: Pick<ResolvedOptions, 'schemaPolicy' | 'payloadValidation'>,
  definition: WorkflowDefinition,
): void {
  if (options.schemaPolicy === 'required') {
    const missing = collectMissingWorkflowSchemas(definition);
    if (missing.length > 0) {
      throw new DefinitionSchemaRequiredError('workflow', definition.name, missing);
    }
  }
  if (options.payloadValidation === 'inbound') {
    const unvalidatable = collectUnvalidatableInboundSchemas(definition);
    if (unvalidatable.length > 0) {
      throw new TypeError(
        `The engine validates inbound payloads (payloadValidation: 'inbound'), but workflow ` +
          `"${definition.name}" declares schemas with no runtime validator: ` +
          `${unvalidatable.join(', ')}. Use a Standard Schema validator such as Zod or Valibot.`,
      );
    }
  }
}

/** Throw {@link DefinitionSchemaRequiredError} when `policy` is `'required'` and an engine-level activity omits a schema. */
export function assertActivitySchemas(
  policy: ResolvedOptions['schemaPolicy'],
  definition: NamedSchemaFields,
): void {
  if (policy !== 'required') return;
  const missing: string[] = [];
  collectFields(missing, '', definition, BOTH, isUndeclared);
  if (missing.length > 0) {
    throw new DefinitionSchemaRequiredError('activity', definition.name, missing);
  }
}
