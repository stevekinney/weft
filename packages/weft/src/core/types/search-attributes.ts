// ---------------------------------------------------------------------------
// Search attributes
// ---------------------------------------------------------------------------

/**
 * Union of scalar types accepted as search attribute values. Pass when calling
 * `engine.setAttributes` or in {@link StartOptions.searchAttributes}. The
 * engine indexes values of these types so callers can filter via
 * `engine.list({ attributes: [...] })`.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type SearchAttributeValue } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'order' }).execute(async function* () { return 'shipped'; }));
 * const handle = await engine.start('order', null, {
 *   searchAttributes: { region: 'us-east' as SearchAttributeValue },
 * });
 * void handle;
 * ```
 */
export type SearchAttributeValue = string | number | boolean | Date | string[];

export type JsonSchemaPrimitiveType = 'array' | 'boolean' | 'integer' | 'number' | 'string';

export type StringSearchAttributeDefinition = {
  type: 'string';
  format?: string;
};

export type NumberSearchAttributeDefinition = {
  type: 'number' | 'integer';
};

export type BooleanSearchAttributeDefinition = {
  type: 'boolean';
};

export type StringArraySearchAttributeDefinition = {
  type: 'array';
  items?: StringSearchAttributeDefinition;
};

/**
 * JSON Schema fragment accepted by the search attribute registry. The engine
 * supports the scalar and string-array shapes it can index today while keeping
 * definitions compatible with future schema tooling.
 *
 * @example
 * ```ts
 * import type { SearchAttributeDefinition } from '@lostgradient/weft';
 *
 * const createdAt: SearchAttributeDefinition = { type: 'string', format: 'date-time' };
 * const tags: SearchAttributeDefinition = {
 *   type: 'array',
 *   items: { type: 'string' },
 * };
 * void createdAt;
 * void tags;
 * ```
 */
export type SearchAttributeDefinition =
  | BooleanSearchAttributeDefinition
  | NumberSearchAttributeDefinition
  | StringArraySearchAttributeDefinition
  | StringSearchAttributeDefinition;

export type SearchAttributePrimitiveValueMap = {
  array: string[];
  boolean: boolean;
  integer: number;
  number: number;
  string: string;
};

export type SearchAttributeValueForDefinition<TDefinition> =
  TDefinition extends keyof SearchAttributePrimitiveValueMap
    ? SearchAttributePrimitiveValueMap[TDefinition]
    : TDefinition extends { type: 'string'; format: 'date-time' }
      ? Date
      : TDefinition extends { type: infer TType }
        ? TType extends keyof SearchAttributePrimitiveValueMap
          ? SearchAttributePrimitiveValueMap[TType]
          : SearchAttributeValue
        : SearchAttributeValue;

/**
 * Named search attribute handle returned by {@link searchAttribute}. The
 * runtime value carries `name` and a JSON Schema fragment.
 *
 * @example
 * ```ts
 * import { searchAttribute, type SearchAttributeHandle } from '@lostgradient/weft';
 *
 * declare const ctx: {
 *   setAttribute(attribute: SearchAttributeHandle<string>, value: string): void;
 * };
 * const customerId: SearchAttributeHandle<string> = searchAttribute('customerId', 'string');
 * ctx.setAttribute(customerId, 'cust_123');
 * ```
 */
export interface SearchAttributeHandle<TValue extends SearchAttributeValue = SearchAttributeValue> {
  name: string;
  type: JsonSchemaPrimitiveType;
  format?: string;
  items?: StringSearchAttributeDefinition;
  readonly _value?: () => TValue;
}

/**
 * Registry of named search attribute definitions for a workflow type. Each key
 * is an attribute name; each value is a `SearchAttributeDefinition` describing
 * the expected type. Pass via the workflow builder's `searchAttributes` option
 * (or `WorkflowDefinition.searchAttributes` on a hand-rolled definition) so
 * the engine validates and indexes attributes at runtime.
 *
 * @example
 * ```ts
 * import { Engine, workflow, type SearchAttributeSchema } from '@lostgradient/weft';
 *
 * const schema: SearchAttributeSchema = {
 *   customerId: { type: 'string' },
 *   orderValue:  { type: 'number' },
 *   isPriority:  { type: 'boolean' },
 * };
 * const order = workflow({ name: 'order' })
 *   .searchAttributes(schema)
 *   .execute(async function* () { return 'ok'; });
 * const engine = new Engine();
 * engine.register(order);
 * void engine;
 * ```
 */
export type SearchAttributeSchema = Record<string, SearchAttributeDefinition>;

/**
 * Create a named search attribute definition.
 *
 * @example
 * ```ts
 * import { searchAttribute } from '@lostgradient/weft';
 *
 * const createdAt = searchAttribute('createdAt', { type: 'string', format: 'date-time' });
 * ```
 */
export function searchAttribute<
  const TDefinition extends JsonSchemaPrimitiveType | SearchAttributeDefinition,
>(
  name: string,
  type: TDefinition,
): SearchAttributeHandle<SearchAttributeValueForDefinition<TDefinition>> {
  if (typeof type === 'string') {
    return { name, type };
  }

  return { name, ...type };
}

export function searchAttributeName(attribute: string | { readonly name: string }): string {
  return typeof attribute === 'string' ? attribute : attribute.name;
}
