/**
 * Deterministic normalization and canonical serialization for workflow
 * contracts.
 *
 * Two contracts that describe the same workflow must produce byte-identical
 * canonical output regardless of how their object keys were ordered in the
 * source, so `contractHash()` and `deriveWorkflowRevision()` identify the
 * *content* rather than an accident of construction. Serialization walks the
 * declared contract shape explicitly instead of generically stringifying the
 * input, which means an unknown extra property can never leak into the
 * canonical bytes and change a hash.
 *
 * @module core/contract/normalize
 */

import { canonicalJsonStringify } from '../../worker/manifest/canonical-json.ts';
import type {
  WorkflowActivityContract,
  WorkflowContract,
  WorkflowMessageContract,
} from './types.ts';
import { WORKFLOW_CONTRACT_VERSION } from './types.ts';

/** Sort record keys by UTF-16 code unit — the same comparator the registry snapshot and the worker manifest use. */
function sortedKeys(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).toSorted();
}

/**
 * Recursively rebuild an arbitrary schema-fragment value on null-prototype
 * objects so no array or object inside it is shared with the caller-owned
 * input, and a property literally named `__proto__` survives as an own
 * entry rather than mutating the prototype chain.
 *
 * Schema fragments are `Record<string, unknown>` rather than `JSONValue`
 * because `definitionSchemaToJsonSchema()`'s output is structurally
 * JSON-safe by construction without necessarily satisfying that type at the
 * TypeScript level — the same rationale `canonicalJsonStringify()` documents.
 */
function cloneSchemaFragment(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneSchemaFragment(entry));

  const record = value as Readonly<Record<string, unknown>>;
  const cloned: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    cloned[key] = cloneSchemaFragment(record[key]);
  }
  return cloned;
}

function cloneSchemaRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : (cloneSchemaFragment(value) as Record<string, unknown>);
}

function normalizeMessageContract(entry: WorkflowMessageContract): WorkflowMessageContract {
  const normalized: {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  } = {};
  const inputSchema = cloneSchemaRecord(entry.inputSchema);
  if (inputSchema !== undefined) normalized.inputSchema = inputSchema;
  const outputSchema = cloneSchemaRecord(entry.outputSchema);
  if (outputSchema !== undefined) normalized.outputSchema = outputSchema;
  return normalized;
}

function normalizeActivityContract(entry: WorkflowActivityContract): WorkflowActivityContract {
  return normalizeMessageContract(entry);
}

/**
 * Sort and rebuild a message/activity map on a null-prototype object,
 * omitting the field entirely (returning `undefined`) when the source map is
 * absent or empty — normalized contracts never carry a present-but-empty
 * `{}` record, matching the registry snapshot's omission convention.
 */
function sortedContractRecord<In, Out>(
  record: Readonly<Record<string, In>> | undefined,
  normalizeValue: (value: In) => Out,
): Readonly<Record<string, Out>> | undefined {
  if (record === undefined) return undefined;
  const keys = sortedKeys(record);
  if (keys.length === 0) return undefined;

  const normalized: Record<string, Out> = Object.create(null) as Record<string, Out>;
  for (const key of keys) {
    normalized[key] = normalizeValue(record[key] as In);
  }
  return normalized;
}

/** Mutable draft of a {@link WorkflowContract}, built up field by field before being frozen by the return type. */
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

function applyDescriptionAndTags(draft: ContractDraft, contract: WorkflowContract): void {
  if (contract.description !== undefined) draft.description = contract.description;
  if (contract.tags !== undefined && contract.tags.length > 0) {
    draft.tags = [...contract.tags].toSorted();
  }
}

function applySchemas(draft: ContractDraft, contract: WorkflowContract): void {
  const inputSchema = cloneSchemaRecord(contract.inputSchema);
  if (inputSchema !== undefined) draft.inputSchema = inputSchema;
  const outputSchema = cloneSchemaRecord(contract.outputSchema);
  if (outputSchema !== undefined) draft.outputSchema = outputSchema;
}

function applyMessageRecords(draft: ContractDraft, contract: WorkflowContract): void {
  const signals = sortedContractRecord(contract.signals, normalizeMessageContract);
  if (signals !== undefined) draft.signals = signals;
  const updates = sortedContractRecord(contract.updates, normalizeMessageContract);
  if (updates !== undefined) draft.updates = updates;
  const queries = sortedContractRecord(contract.queries, normalizeMessageContract);
  if (queries !== undefined) draft.queries = queries;
}

/**
 * Normalize a workflow contract into its canonical in-memory form.
 *
 * Field order follows the declared shape, every open-ended record is
 * rebuilt with its keys sorted (and omitted entirely when empty), and every
 * schema fragment is deep-cloned onto a null-prototype object. The result is
 * a fresh value; the input is not mutated.
 *
 * @example
 * ```ts
 * import { normalizeWorkflowContract } from '@lostgradient/weft';
 *
 * const normalized = normalizeWorkflowContract({
 *   name: 'checkout',
 *   workflowVersion: '2.1.0',
 *   signals: {
 *     zeta: {},
 *     alpha: {},
 *   },
 * });
 * console.log(Object.keys(normalized.signals ?? {})); // ['alpha', 'zeta']
 * ```
 */
export function normalizeWorkflowContract(contract: WorkflowContract): WorkflowContract {
  const draft: ContractDraft = {
    name: contract.name,
    workflowVersion: contract.workflowVersion,
  };

  applyDescriptionAndTags(draft, contract);
  applySchemas(draft, contract);
  applyMessageRecords(draft, contract);

  const activities = sortedContractRecord(contract.activities, normalizeActivityContract);
  if (activities !== undefined) draft.activities = activities;

  if (contract.finalizer !== undefined) {
    draft.finalizer = normalizeActivityContract(contract.finalizer);
  }

  return draft;
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Serialize one signal/update/query/activity contract's schema pair.
 * Shared between {@link canonicalWorkflowContractJson} (the full-identity
 * form) and `hash.ts`'s payload-only serialization, since both walk the same
 * `{ inputSchema?, outputSchema? }` shape — the only difference between the
 * two identities is which *top-level* fields are included, not how a single
 * message/activity entry serializes.
 *
 * @internal Exported for reuse within `core/contract/*`; not part of the
 * package's public API.
 */
export function canonicalMessageContractJson(entry: WorkflowMessageContract): string {
  const fields: string[] = [];
  if (entry.inputSchema !== undefined) {
    fields.push(`"inputSchema":${canonicalJsonStringify(entry.inputSchema)}`);
  }
  if (entry.outputSchema !== undefined) {
    fields.push(`"outputSchema":${canonicalJsonStringify(entry.outputSchema)}`);
  }
  return `{${fields.join(',')}}`;
}

/**
 * @internal Exported for reuse within `core/contract/*`; not part of the
 * package's public API.
 */
export function canonicalContractRecordJson(
  record: Readonly<Record<string, WorkflowMessageContract>>,
): string {
  const entries = sortedKeys(record).map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalMessageContractJson(record[key] as WorkflowMessageContract)}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * @internal Exported for reuse within `core/contract/*` (`hash.ts`'s
 * payload-only serialization shares this field-appending logic); not part of
 * the package's public API.
 */
export function appendContractRecordField(
  fields: string[],
  label: 'signals' | 'updates' | 'queries' | 'activities',
  record: Readonly<Record<string, WorkflowMessageContract>> | undefined,
): void {
  if (record === undefined || Object.keys(record).length === 0) return;
  fields.push(`"${label}":${canonicalContractRecordJson(record)}`);
}

/**
 * @internal Exported for reuse within `core/contract/*`; not part of the
 * package's public API.
 */
export function appendSchemaField(
  fields: string[],
  label: 'inputSchema' | 'outputSchema',
  schema: Record<string, unknown> | undefined,
): void {
  if (schema === undefined) return;
  fields.push(`"${label}":${canonicalJsonStringify(schema)}`);
}

function appendTagsField(fields: string[], tags: ReadonlyArray<string> | undefined): void {
  if (tags === undefined || tags.length === 0) return;
  const sortedTags = [...tags].toSorted().map((tag) => JSON.stringify(tag));
  fields.push(`"tags":[${sortedTags.join(',')}]`);
}

/**
 * Serialize a workflow contract to its canonical, full-identity JSON string
 * — the digest input {@link deriveWorkflowRevision} uses, and the value
 * returned as `WorkflowRevisionManifestParseSuccess.canonicalJson`.
 *
 * This is a *different* identity from {@link contractHash}'s payload-only
 * serialization: it includes `name`, `workflowVersion`, `description`, and
 * `tags`, so a documentation edit changes this output (and therefore
 * `revision`) without changing `contractHash`. The output is byte-identical
 * for equivalent contracts regardless of source key order, and every field
 * this project cares about changes it.
 *
 * @example
 * ```ts
 * import { canonicalWorkflowContractJson } from '@lostgradient/weft';
 *
 * const left = canonicalWorkflowContractJson({
 *   name: 'checkout',
 *   workflowVersion: '2.1.0',
 *   signals: { alpha: {}, zeta: {} },
 * });
 * const right = canonicalWorkflowContractJson({
 *   name: 'checkout',
 *   workflowVersion: '2.1.0',
 *   signals: { zeta: {}, alpha: {} },
 * });
 * console.log(left === right); // true
 * ```
 */
export function canonicalWorkflowContractJson(contract: WorkflowContract): string {
  const fields: string[] = [
    `"contractVersion":${JSON.stringify(WORKFLOW_CONTRACT_VERSION)}`,
    `"name":${JSON.stringify(contract.name)}`,
    `"workflowVersion":${JSON.stringify(contract.workflowVersion)}`,
  ];
  if (contract.description !== undefined) {
    fields.push(`"description":${JSON.stringify(contract.description)}`);
  }
  appendTagsField(fields, contract.tags);
  appendSchemaField(fields, 'inputSchema', contract.inputSchema);
  appendSchemaField(fields, 'outputSchema', contract.outputSchema);
  appendContractRecordField(fields, 'signals', contract.signals);
  appendContractRecordField(fields, 'updates', contract.updates);
  appendContractRecordField(fields, 'queries', contract.queries);
  appendContractRecordField(fields, 'activities', contract.activities);
  if (contract.finalizer !== undefined) {
    fields.push(`"finalizer":${canonicalMessageContractJson(contract.finalizer)}`);
  }
  return `{${fields.join(',')}}`;
}
