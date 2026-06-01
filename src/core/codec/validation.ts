export interface CloneValidationError {
  path: string;
  value: unknown;
  reason: string;
  suggestion: string;
}

export interface CloneValidationResult {
  valid: boolean;
  errors: CloneValidationError[];
}

/**
 * Validate that a value is cloneable (structuredClone compatible).
 * Returns errors for non-cloneable values. Reports ALL errors, not just the first.
 *
 * @example
 * ```ts
 * import { validateCloneable } from '@lostgradient/weft';
 *
 * const safe = validateCloneable({ name: 'Alice', scores: [1, 2, 3] });
 * console.log(safe.valid);   // true
 * console.log(safe.errors);  // []
 *
 * const unsafe = validateCloneable({ fn: () => 42 });
 * console.log(unsafe.valid);           // false
 * console.log(unsafe.errors[0]?.path); // 'fn'
 * ```
 */
export function validateCloneable(value: unknown, path = ''): CloneValidationResult {
  const errors: CloneValidationError[] = [];
  const visited = new Set<object>();
  walkValue(value, path, errors, visited);
  return { valid: errors.length === 0, errors };
}

/**
 * Check whether an object is a class instance with methods on its prototype
 * (beyond what plain Object provides).
 */
function isClassInstanceWithMethods(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    hasCustomPrototype(prototype) &&
    !isSupportedStructuredCloneType(value) &&
    hasPrototypeMethods(prototype)
  );
}

function hasCustomPrototype(prototype: unknown): boolean {
  return prototype !== Object.prototype && prototype !== null;
}

function isSupportedStructuredCloneType(value: object): boolean {
  return (
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Error ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  );
}

function hasPrototypeMethods(prototype: unknown): boolean {
  if (typeof prototype !== 'object' || prototype === null) return false;

  const propertyNames = Object.getOwnPropertyNames(prototype);
  return propertyNames.some((name) => {
    if (name === 'constructor') return false;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    return descriptor !== undefined && typeof descriptor.value === 'function';
  });
}

type CloneValidationFailure = Omit<CloneValidationError, 'path' | 'value'>;

function pushCloneValidationError(
  errors: CloneValidationError[],
  path: string,
  value: unknown,
  failure: CloneValidationFailure,
): void {
  errors.push({
    path,
    value,
    reason: failure.reason,
    suggestion: failure.suggestion,
  });
}

function getPrimitiveCloneValidationFailure(value: unknown): CloneValidationFailure | null {
  if (typeof value === 'function') {
    return {
      reason: 'Functions cannot be serialized.',
      suggestion: 'Move this into ctx.run() or reconstruct it on resume.',
    };
  }

  if (typeof value === 'symbol') {
    return {
      reason: 'Symbols cannot be serialized.',
      suggestion: 'Use a string identifier instead of a Symbol.',
    };
  }

  return null;
}

function getObjectCloneValidationFailure(
  value: object,
  visited: Set<object>,
): CloneValidationFailure | null {
  if (value instanceof WeakRef) {
    return {
      reason: 'WeakRef cannot be serialized.',
      suggestion: 'Store the referenced value directly instead of using a WeakRef.',
    };
  }

  if (value instanceof WeakMap) {
    return {
      reason: 'WeakMap cannot be serialized.',
      suggestion: 'Use a Map instead of a WeakMap.',
    };
  }

  if (value instanceof WeakSet) {
    return {
      reason: 'WeakSet cannot be serialized.',
      suggestion: 'Use a Set instead of a WeakSet.',
    };
  }

  if (visited.has(value)) {
    return {
      reason: 'Circular reference detected.',
      suggestion: 'Remove the circular reference or restructure the data.',
    };
  }

  if (isClassInstanceWithMethods(value)) {
    return {
      reason: 'Class instances with methods cannot be serialized.',
      suggestion: 'Store only the data and reconstruct the instance.',
    };
  }

  return null;
}

function isSerializableLeafValue(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  );
}

function walkMapValues(
  value: Map<unknown, unknown>,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  for (const [key, mapValue] of value) {
    const keyString = String(key);
    walkValue(mapValue, path ? `${path}.${keyString}` : keyString, errors, visited);
  }
}

function walkSetValues(
  value: Set<unknown>,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  let index = 0;
  for (const setValue of value) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    walkValue(setValue, elementPath, errors, visited);
    index++;
  }
}

function walkArrayValues(
  value: unknown[],
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  for (let index = 0; index < value.length; index++) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    walkValue(value[index], elementPath, errors, visited);
  }
}

function walkRecordValues(
  value: Record<string, unknown>,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  for (const key of Object.keys(value)) {
    const propertyPath = path ? `${path}.${key}` : key;
    walkValue(value[key], propertyPath, errors, visited);
  }
}

function walkValue(
  value: unknown,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  // Primitives are always fine
  if (value === null || value === undefined) return;

  const primitiveFailure = getPrimitiveCloneValidationFailure(value);
  if (primitiveFailure) {
    pushCloneValidationError(errors, path, value, primitiveFailure);
    return;
  }

  // Only objects need further inspection
  if (typeof value !== 'object') return;

  const objectFailure = getObjectCloneValidationFailure(value, visited);
  if (objectFailure) {
    pushCloneValidationError(errors, path, value, objectFailure);
    return;
  }

  visited.add(value);
  try {
    if (isSerializableLeafValue(value)) {
      return;
    }

    if (value instanceof Map) {
      walkMapValues(value, path, errors, visited);
      return;
    }

    if (value instanceof Set) {
      walkSetValues(value, path, errors, visited);
      return;
    }

    if (Array.isArray(value)) {
      walkArrayValues(value, path, errors, visited);
      return;
    }

    walkRecordValues(value as Record<string, unknown>, path, errors, visited);
  } finally {
    visited.delete(value);
  }
}
