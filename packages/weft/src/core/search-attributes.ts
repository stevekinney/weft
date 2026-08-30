import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import type { SearchAttributeDefinition, SearchAttributeValue } from './types.ts';

export { searchAttribute, searchAttributeName } from './types.ts';

const SIGN_BIT = 1n << 63n;
const ALL_BITS = (1n << 64n) - 1n;

/**
 * Maximum size in bytes for an encoded attribute value. Values exceeding this
 * limit produce storage keys that may blow past backend size constraints.
 */
export const MAX_ENCODED_VALUE_BYTES = 1024;

/**
 * Encode an IEEE 754 float64 to a sortable hex string.
 *
 * The approach:
 * 1. Write the float64 into a DataView and read back its bits as a BigInt.
 * 2. If the sign bit is 0 (positive or +0), flip the sign bit so positives sort after negatives.
 * 3. If the sign bit is 1 (negative or -0), flip ALL bits to reverse the negative ordering.
 * 4. Return a 16-character zero-padded hex string.
 */
function floatToSortableHex(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);

  if (bits & SIGN_BIT) {
    // Negative: flip all bits
    bits = bits ^ ALL_BITS;
  } else {
    // Positive: flip only sign bit
    bits = bits ^ SIGN_BIT;
  }

  return bits.toString(16).padStart(16, '0');
}

/**
 * Decode a sortable hex string back to an IEEE 754 float64.
 */
function sortableHexToFloat(hex: string): number {
  let bits = BigInt(`0x${hex}`);

  if (bits & SIGN_BIT) {
    // Was positive: flip sign bit back
    bits = bits ^ SIGN_BIT;
  } else {
    // Was negative: flip all bits back
    bits = bits ^ ALL_BITS;
  }

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/**
 * Encode a search attribute value to a sortable string for index keys.
 *
 * @example
 * ```ts
 * import { encodeAttributeValue } from '@lostgradient/weft';
 *
 * console.log(encodeAttributeValue('acme'));        // 's:acme'
 * console.log(encodeAttributeValue(42));            // 'n:...' (sortable hex)
 * console.log(encodeAttributeValue(true));          // 'b:1'
 * console.log(encodeAttributeValue(new Date('2026-01-01'))); // 'd:2026-01-01T00:00:00.000Z'
 * ```
 */
export function encodeAttributeValue(value: SearchAttributeValue): string {
  let encoded: string;

  if (typeof value === 'string') {
    encoded = `s:${value}`;
  } else if (typeof value === 'number') {
    encoded = `n:${floatToSortableHex(value)}`;
  } else if (typeof value === 'boolean') {
    encoded = `b:${value ? '1' : '0'}`;
  } else if (value instanceof Date) {
    encoded = `d:${value.toISOString()}`;
  } else {
    // string[] — should not be called directly for keyword lists in index ops,
    // but provided for completeness. Each element is encoded separately.
    throw new Error(
      'Cannot encode a keyword list as a single value; encode elements individually.',
    );
  }

  return encoded;
}

/**
 * Validate that an encoded attribute value does not exceed the storage key size limit.
 * Call this in the attribute-setting path, NOT in the general-purpose encoder — the encoder
 * is also used to reconstruct old keys for deletion, and throwing there would prevent
 * cleanup of pre-existing oversized values.
 */
export function validateEncodedValueSize(encoded: string, attributeName: string): void {
  const byteLength = new TextEncoder().encode(encoded).byteLength;
  if (byteLength > MAX_ENCODED_VALUE_BYTES) {
    throw new Error(
      `Encoded search attribute "${attributeName}" exceeds the ${MAX_ENCODED_VALUE_BYTES}-byte limit ` +
        `(got ${byteLength} bytes). Reduce the value size before setting the attribute.`,
    );
  }
}

/**
 * Decode an encoded attribute value back to its original type.
 *
 * @example
 * ```ts
 * import { encodeAttributeValue, decodeAttributeValue } from '@lostgradient/weft';
 *
 * const encoded = encodeAttributeValue('acme');
 * const decoded = decodeAttributeValue(encoded, 'string');
 * console.log(decoded); // 'acme'
 *
 * const num = encodeAttributeValue(42);
 * console.log(decodeAttributeValue(num, 'number')); // 42
 * ```
 */
export function decodeAttributeValue(encoded: string, type: string): SearchAttributeValue {
  const colonIndex = encoded.indexOf(':');
  const payload = encoded.slice(colonIndex + 1);

  switch (type) {
    case 'string':
      return payload;
    case 'number':
      return sortableHexToFloat(payload);
    case 'boolean':
      return payload === '1';
    case 'date-time':
    case 'datetime':
      return new Date(payload);
    default:
      throw new Error(`Unknown search attribute type: ${type}`);
  }
}

/**
 * Validate that a value's runtime type matches the declared schema type.
 * Throws a descriptive error on mismatch.
 */
export function validateAttributeType(
  attributeName: string,
  value: SearchAttributeValue,
  definition: SearchAttributeDefinition,
): void {
  const { type: declaredType } = definition;

  switch (declaredType) {
    case 'string':
      validateStringAttribute(attributeName, value, definition);
      break;
    case 'integer':
      validateIntegerAttribute(attributeName, value);
      break;
    case 'number':
      validateNumberAttribute(attributeName, value);
      break;
    case 'boolean':
      validateBooleanAttribute(attributeName, value);
      break;
    case 'array':
      validateArrayAttribute(attributeName, value);
      break;
    default: {
      const _exhaustive: never = declaredType;
      throw new Error(`Unknown search attribute type declaration: ${String(_exhaustive)}`);
    }
  }
}

function validateStringAttribute(
  attributeName: string,
  value: SearchAttributeValue,
  definition: Extract<SearchAttributeDefinition, { type: 'string' }>,
): void {
  if (definition.format === 'date-time') {
    if (!(value instanceof Date)) {
      throw new Error(
        `Search attribute "${attributeName}" is declared as "string" with format "date-time" but received ${typeof value}.`,
      );
    }
    return;
  }

  if (typeof value !== 'string') {
    throw new Error(
      `Search attribute "${attributeName}" is declared as "string" but received ${typeof value}.`,
    );
  }
}

function validateIntegerAttribute(attributeName: string, value: SearchAttributeValue): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(
      `Search attribute "${attributeName}" is declared as "integer" but received ${typeof value}.`,
    );
  }
}

function validateNumberAttribute(attributeName: string, value: SearchAttributeValue): void {
  if (typeof value !== 'number') {
    throw new Error(
      `Search attribute "${attributeName}" is declared as "number" but received ${typeof value}.`,
    );
  }
}

function validateBooleanAttribute(attributeName: string, value: SearchAttributeValue): void {
  if (typeof value !== 'boolean') {
    throw new Error(
      `Search attribute "${attributeName}" is declared as "boolean" but received ${typeof value}.`,
    );
  }
}

function validateArrayAttribute(attributeName: string, value: SearchAttributeValue): void {
  if (!Array.isArray(value)) {
    throw new Error(
      `Search attribute "${attributeName}" is declared as "array" but received ${typeof value}.`,
    );
  }
  if (!value.every((element) => typeof element === 'string')) {
    throw new Error(
      `Search attribute "${attributeName}" is declared as "array" but array contains non-string elements.`,
    );
  }
}

function valuesEqual(a: SearchAttributeValue, b: SearchAttributeValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

const EMPTY_VALUE = new Uint8Array(0);

/**
 * Compute the diff between old and new attributes, returning BatchOperations for index updates.
 *
 * @example
 * ```ts
 * import { buildIndexOperations } from '@lostgradient/weft';
 *
 * const ops = buildIndexOperations(
 *   'wf-123',
 *   { status: 'pending' },
 *   { status: 'completed', customerId: 'acme' },
 * );
 * // ops: delete old 'status' index key, put new 'status' key, put 'customerId' key
 * console.log(ops.length > 0); // true
 * ```
 */
export function buildIndexOperations(
  workflowId: string,
  previous: Record<string, SearchAttributeValue>,
  current: Record<string, SearchAttributeValue>,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);

  for (const attributeName of allKeys) {
    operations.push(...buildAttributeIndexOperations(attributeName, workflowId, previous, current));
  }

  return operations;
}

function buildAttributeIndexOperations(
  attributeName: string,
  workflowId: string,
  previous: Record<string, SearchAttributeValue>,
  current: Record<string, SearchAttributeValue>,
): BatchOperation[] {
  const oldValue = previous[attributeName];
  const newValue = current[attributeName];
  const hadOld = attributeName in previous;
  const hasNew = attributeName in current;

  if (Array.isArray(oldValue) || Array.isArray(newValue)) {
    return buildArrayTransitionOperations({
      attributeName,
      workflowId,
      oldValue,
      newValue,
      hadOld,
      hasNew,
    });
  }

  return buildScalarTransitionOperations({
    attributeName,
    workflowId,
    oldValue,
    newValue,
    hadOld,
    hasNew,
  });
}

function buildScalarTransitionOperations(parameters: {
  attributeName: string;
  workflowId: string;
  oldValue: SearchAttributeValue | undefined;
  newValue: SearchAttributeValue | undefined;
  hadOld: boolean;
  hasNew: boolean;
}): BatchOperation[] {
  const { attributeName, workflowId, oldValue, newValue, hadOld, hasNew } = parameters;

  if (hadOld && !hasNew) {
    return [deleteIndexOperation(attributeName, oldValue!, workflowId)];
  }

  if (!hadOld && hasNew) {
    return [putIndexOperation(attributeName, newValue!, workflowId)];
  }

  if (hadOld && hasNew && !valuesEqual(oldValue!, newValue!)) {
    return [
      deleteIndexOperation(attributeName, oldValue!, workflowId),
      putIndexOperation(attributeName, newValue!, workflowId),
    ];
  }

  return [];
}

function putIndexOperation(
  attributeName: string,
  value: SearchAttributeValue,
  workflowId: string,
): Extract<BatchOperation, { type: 'put' }> {
  return {
    type: 'put',
    key: KEYS.attributeIndex(attributeName, encodeAttributeValue(value), workflowId),
    value: EMPTY_VALUE,
  };
}

function deleteIndexOperation(
  attributeName: string,
  value: SearchAttributeValue,
  workflowId: string,
): Extract<BatchOperation, { type: 'delete' }> {
  return {
    type: 'delete',
    key: KEYS.attributeIndex(attributeName, encodeAttributeValue(value), workflowId),
  };
}

function buildArrayTransitionOperations(parameters: {
  attributeName: string;
  workflowId: string;
  oldValue: SearchAttributeValue | undefined;
  newValue: SearchAttributeValue | undefined;
  hadOld: boolean;
  hasNew: boolean;
}): BatchOperation[] {
  const { oldValue, newValue } = parameters;

  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    return buildArrayDiffOperations(
      parameters.attributeName,
      oldValue,
      newValue,
      parameters.workflowId,
    );
  }

  return [
    ...buildDeleteOperationsForValues(
      parameters.attributeName,
      parameters.hadOld ? oldValue : undefined,
      parameters.workflowId,
    ),
    ...buildPutOperationsForValues(
      parameters.attributeName,
      parameters.hasNew ? newValue : undefined,
      parameters.workflowId,
    ),
  ];
}

function buildArrayDiffOperations(
  attributeName: string,
  oldValues: string[],
  newValues: string[],
  workflowId: string,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  const oldElements = new Set(oldValues);
  const newElements = new Set(newValues);

  for (const element of oldElements) {
    if (!newElements.has(element)) {
      operations.push(deleteIndexOperation(attributeName, element, workflowId));
    }
  }

  for (const element of newElements) {
    if (!oldElements.has(element)) {
      operations.push(putIndexOperation(attributeName, element, workflowId));
    }
  }

  return operations;
}

function buildDeleteOperationsForValues(
  attributeName: string,
  value: SearchAttributeValue | undefined,
  workflowId: string,
): BatchOperation[] {
  return valuesForIndexTransition(value).map((element) =>
    deleteIndexOperation(attributeName, element, workflowId),
  );
}

function buildPutOperationsForValues(
  attributeName: string,
  value: SearchAttributeValue | undefined,
  workflowId: string,
): BatchOperation[] {
  return valuesForIndexTransition(value).map((element) =>
    putIndexOperation(attributeName, element, workflowId),
  );
}

function valuesForIndexTransition(value: SearchAttributeValue | undefined): SearchAttributeValue[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
