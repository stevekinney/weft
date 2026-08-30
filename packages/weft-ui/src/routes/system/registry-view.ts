/**
 * Pure view-model mapping for the Registry tab (plan §9.7, T7.2; design
 * `Weft Console.dc.html` "System" § REGISTRY). Turns the wire
 * `GET /v1/registry` snapshot (`weft.system.registry`,
 * `@lostgradient/weft`'s `RegistrySnapshot`) into sorted, render-ready rows —
 * kept framework-free so it is unit-testable without a DOM.
 *
 * ## A known gap this module works around honestly
 *
 * The plan (§9.7) and design reference call for "signal/update/query handler
 * names" and "activity definitions + retry policy" on this tab. Verified
 * against `weft` v0.11.0 (`src/core/registry-snapshot.ts`,
 * `src/core/activity-registry.ts`, `src/core/types/workflow-builder-runtime.ts`):
 * `RegistrySnapshot.workflows[type]` never carries `.signals`/`.updates`/
 * `.queries` even though `workflow({name}).signals({...})` etc. register them
 * statically at build time (the data exists, `buildRegistrySnapshot` just
 * never copies it), and `RegistrySnapshot.activities[name]` drops
 * `ActivityMetadata.retry`/`.timeout` even though `buildActivityEntry` has
 * the full `ActivityMetadata` in hand and only copies `queue`/`inputSchema`/
 * `outputSchema`/`description`. Filed upstream:
 * https://github.com/stevekinney/weft/issues/736 — this module exposes
 * exactly the fields the wire snapshot actually carries and never fabricates
 * the missing ones; `RegistryWorkflowRow.handlers`/
 * `RegistryActivityRow.retry`/`.timeout` are typed `undefined` today by
 * construction, not guessed at.
 */

/** The subset of `RegistrySnapshot`'s workflow entry this module reads. Mirrors `RegistryWorkflowEntry` (`@lostgradient/weft`) structurally rather than importing it, so this module has no runtime dependency on the package. */
export interface RegistryWorkflowEntrySource {
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/** Mirrors `RegistryActivityEntry` (`@lostgradient/weft`) structurally. */
export interface RegistryActivityEntrySource {
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly queue: string;
  readonly description?: string;
}

/** Mirrors `RegistrySnapshot` (`@lostgradient/weft`) structurally. */
export interface RegistrySnapshotSource {
  readonly registryVersion: number;
  readonly workflows: Readonly<Record<string, RegistryWorkflowEntrySource>>;
  readonly activities: Readonly<Record<string, RegistryActivityEntrySource>>;
}

/** One field extracted from a JSON Schema `properties` map, for the Tree/list rendering. */
export interface RegistrySchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string | undefined;
}

export interface RegistryWorkflowRow {
  readonly type: string;
  readonly description: string | undefined;
  readonly tags: readonly string[];
  readonly hasInputSchema: boolean;
  readonly inputFields: readonly RegistrySchemaField[];
  /** Recursive tree for the `Tree`-based detail view (§ REGISTRY DEFINITION DETAIL). */
  readonly inputSchemaTree: readonly SchemaTreeNode[];
  readonly hasOutputSchema: boolean;
  readonly outputFields: readonly RegistrySchemaField[];
  readonly outputSchemaTree: readonly SchemaTreeNode[];
  /** Always `undefined` — see module doc's registry-snapshot gap. */
  readonly handlers: undefined;
}

export interface RegistryActivityRow {
  readonly name: string;
  readonly queue: string;
  readonly description: string | undefined;
  readonly hasInputSchema: boolean;
  readonly inputFields: readonly RegistrySchemaField[];
  /** Always `undefined` — see module doc's registry-snapshot gap. */
  readonly retry: undefined;
  /** Always `undefined` — see module doc's registry-snapshot gap. */
  readonly timeout: undefined;
}

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isJsonSchemaTypeString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Best-effort "type" label for one JSON Schema property fragment — a compact summary, not a full schema renderer. */
function schemaTypeLabel(fragment: unknown): string {
  if (typeof fragment !== 'object' || fragment === null) return 'unknown';
  const record = fragment as Record<string, unknown>;

  if (Array.isArray(record['enum'])) return 'enum';
  if (isJsonSchemaTypeString(record['type'])) return record['type'];
  if (Array.isArray(record['type']) && record['type'].every(isJsonSchemaTypeString)) {
    return record['type'].join(' | ');
  }
  if (record['anyOf'] !== undefined || record['oneOf'] !== undefined) return 'union';
  return 'unknown';
}

function schemaDescription(fragment: unknown): string | undefined {
  if (typeof fragment !== 'object' || fragment === null) return undefined;
  const description = (fragment as Record<string, unknown>)['description'];
  return typeof description === 'string' ? description : undefined;
}

/**
 * Extracts a flat field list from a top-level JSON Schema `object` fragment's
 * `properties`/`required`. Non-object schemas (a bare string/number input
 * schema) yield an empty list rather than throwing — the Tree view falls
 * back to a "no fields" note in that case.
 */
export function extractSchemaFields(
  schema: Record<string, unknown> | undefined,
): readonly RegistrySchemaField[] {
  if (!schema) return [];
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null) return [];

  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  return Object.entries(properties as Record<string, unknown>)
    .map(([name, fragment]): RegistrySchemaField => ({
      name,
      type: schemaTypeLabel(fragment),
      required: required.has(name),
      description: schemaDescription(fragment),
    }))
    .toSorted((a, b) => compareCodepoint(a.name, b.name));
}

/** One node in the recursive schema tree the Registry tab renders via Cinder's `Tree` (plan §9.7: "expandable inputSchema Tree"). */
export interface SchemaTreeNode extends RegistrySchemaField {
  readonly id: string;
  readonly children: readonly SchemaTreeNode[];
}

function objectPropertiesOf(fragment: unknown): Record<string, unknown> | undefined {
  if (typeof fragment !== 'object' || fragment === null) return undefined;
  const record = fragment as Record<string, unknown>;
  if (record['type'] !== 'object') return undefined;
  const properties = record['properties'];
  return typeof properties === 'object' && properties !== null
    ? (properties as Record<string, unknown>)
    : undefined;
}

/**
 * Recursively builds a `Tree`-ready node list from a JSON Schema `object`
 * fragment. Only `type: 'object'` fragments with a `properties` map expand
 * into children — arrays, unions, and primitives stay leaves (their `type`
 * label already summarizes them; a full array-item/union-branch renderer is
 * out of scope for a registry preview).
 */
export function buildSchemaTree(
  schema: Record<string, unknown> | undefined,
  idPrefix = 'field',
): readonly SchemaTreeNode[] {
  if (!schema) return [];
  const properties = objectPropertiesOf(schema) ?? schema['properties'];
  if (typeof properties !== 'object' || properties === null) return [];

  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  return Object.entries(properties as Record<string, unknown>)
    .map(([name, fragment]): SchemaTreeNode => {
      const id = `${idPrefix}.${name}`;
      const nestedProperties = objectPropertiesOf(fragment);
      return {
        id,
        name,
        type: schemaTypeLabel(fragment),
        required: required.has(name),
        description: schemaDescription(fragment),
        children: nestedProperties ? buildSchemaTree(fragment as Record<string, unknown>, id) : [],
      };
    })
    .toSorted((a, b) => compareCodepoint(a.name, b.name));
}

function toWorkflowRow(type: string, entry: RegistryWorkflowEntrySource): RegistryWorkflowRow {
  return {
    type,
    description: entry.description,
    tags: entry.tags ?? [],
    hasInputSchema: entry.inputSchema !== undefined,
    inputFields: extractSchemaFields(entry.inputSchema),
    inputSchemaTree: buildSchemaTree(entry.inputSchema, `${type}.input`),
    hasOutputSchema: entry.outputSchema !== undefined,
    outputFields: extractSchemaFields(entry.outputSchema),
    outputSchemaTree: buildSchemaTree(entry.outputSchema, `${type}.output`),
    handlers: undefined,
  };
}

function toActivityRow(name: string, entry: RegistryActivityEntrySource): RegistryActivityRow {
  return {
    name,
    queue: entry.queue,
    description: entry.description,
    hasInputSchema: entry.inputSchema !== undefined,
    inputFields: extractSchemaFields(entry.inputSchema),
    retry: undefined,
    timeout: undefined,
  };
}

/** Sorted (codepoint order) workflow rows ready for the definitions list. */
export function registryWorkflowRows(
  snapshot: RegistrySnapshotSource,
): readonly RegistryWorkflowRow[] {
  return Object.entries(snapshot.workflows)
    .map(([type, entry]) => toWorkflowRow(type, entry))
    .toSorted((a, b) => compareCodepoint(a.type, b.type));
}

/** Sorted (codepoint order) activity rows ready for the activity-definitions grid. */
export function registryActivityRows(
  snapshot: RegistrySnapshotSource,
): readonly RegistryActivityRow[] {
  return Object.entries(snapshot.activities)
    .map(([name, entry]) => toActivityRow(name, entry))
    .toSorted((a, b) => compareCodepoint(a.name, b.name));
}

/** `true` when the registry has nothing registered at all — drives the 3-step onboarding empty state (plan §10.7, Appendix B). */
export function isRegistryEmpty(snapshot: RegistrySnapshotSource): boolean {
  return (
    Object.keys(snapshot.workflows).length === 0 && Object.keys(snapshot.activities).length === 0
  );
}
