import type { CheckpointDivergence } from './interfaces.ts';

export function compareValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  if (original === deserialized) return;

  if (isNullishPair(original, deserialized)) {
    compareNullishValues(original, deserialized, path, divergences);
    return;
  }
  if (compareBuiltInValues(original, deserialized, path, divergences)) return;
  if (isTypeMismatch(original, deserialized)) {
    compareTypeMismatch(original, deserialized, path, divergences);
    return;
  }
  if (isPrimitivePair(original)) {
    comparePrimitiveValues(original, deserialized, path, divergences);
    return;
  }
  compareObjectValues(original, deserialized, path, divergences);
}

function checkpointPath(path: string): string {
  return path || '(root)';
}

function recordDivergence(
  divergences: CheckpointDivergence[],
  path: string,
  original: unknown,
  deserialized: unknown,
  suggestion: string,
): void {
  divergences.push({
    path: checkpointPath(path),
    original,
    deserialized,
    suggestion,
  });
}

function compareNullishValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  recordDivergence(
    divergences,
    path,
    original,
    deserialized,
    'Value changed during serialization round-trip.',
  );
}

function compareDateValues(
  original: Date,
  deserialized: Date,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  if (original.getTime() !== deserialized.getTime()) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'Date value changed during round-trip.',
    );
  }
}

function compareRegExpValues(
  original: RegExp,
  deserialized: RegExp,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  if (original.source !== deserialized.source || original.flags !== deserialized.flags) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'RegExp value changed during round-trip.',
    );
  }
}

function compareMapValues(
  original: Map<unknown, unknown>,
  deserialized: Map<unknown, unknown>,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  for (const [key] of original) {
    const keyPath = path ? `${path}.Map(${String(key)})` : `Map(${String(key)})`;
    if (!deserialized.has(key)) {
      recordDivergence(
        divergences,
        keyPath,
        original.get(key),
        undefined,
        'Map key missing after round-trip.',
      );
      continue;
    }

    compareValues(original.get(key), deserialized.get(key), keyPath, divergences);
  }

  for (const [key] of deserialized) {
    if (original.has(key)) {
      continue;
    }

    const keyPath = path ? `${path}.Map(${String(key)})` : `Map(${String(key)})`;
    recordDivergence(
      divergences,
      keyPath,
      undefined,
      deserialized.get(key),
      'Extra Map key appeared after round-trip.',
    );
  }
}

function compareSetValues(
  original: Set<unknown>,
  deserialized: Set<unknown>,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const originalValues = [...original.values()];
  const deserializedValues = [...deserialized.values()];
  if (originalValues.length !== deserializedValues.length) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'Set size changed during round-trip.',
    );
    return;
  }

  for (let index = 0; index < originalValues.length; index++) {
    const elementPath = path ? `${path}.Set[${index}]` : `Set[${index}]`;
    compareValues(originalValues[index], deserializedValues[index], elementPath, divergences);
  }
}

function compareTypeMismatch(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  recordDivergence(
    divergences,
    path,
    original,
    deserialized,
    `Type changed from ${typeof original} to ${typeof deserialized} during round-trip.`,
  );
}

function comparePrimitiveValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  recordDivergence(
    divergences,
    path,
    original,
    deserialized,
    'Primitive value changed during round-trip.',
  );
}

function compareArrayValues(
  original: unknown[],
  deserialized: unknown[],
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const maxLength = Math.max(original.length, deserialized.length);
  for (let index = 0; index < maxLength; index++) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    if (index >= original.length) {
      recordDivergence(
        divergences,
        elementPath,
        undefined,
        deserialized[index],
        'Extra array element appeared after round-trip.',
      );
      continue;
    }

    if (index >= deserialized.length) {
      recordDivergence(
        divergences,
        elementPath,
        original[index],
        undefined,
        'Array element missing after round-trip.',
      );
      continue;
    }

    compareValues(original[index], deserialized[index], elementPath, divergences);
  }
}

function compareRecordValues(
  original: object,
  deserialized: object,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const allKeys = new Set([...Object.keys(original), ...Object.keys(deserialized)]);

  for (const key of allKeys) {
    const propertyPath = path ? `${path}.${key}` : key;
    if (!(key in original)) {
      recordDivergence(
        divergences,
        propertyPath,
        undefined,
        Reflect.get(deserialized, key),
        'Extra key appeared in deserialized object.',
      );
      continue;
    }

    if (!(key in deserialized)) {
      recordDivergence(
        divergences,
        propertyPath,
        Reflect.get(original, key),
        undefined,
        'Key missing from deserialized object.',
      );
      continue;
    }

    compareValues(
      Reflect.get(original, key),
      Reflect.get(deserialized, key),
      propertyPath,
      divergences,
    );
  }
}

function isNullishPair(original: unknown, deserialized: unknown): boolean {
  return (
    original === null ||
    original === undefined ||
    deserialized === null ||
    deserialized === undefined
  );
}

function isTypeMismatch(original: unknown, deserialized: unknown): boolean {
  return typeof original !== typeof deserialized;
}

function isPrimitivePair(original: unknown): boolean {
  return typeof original !== 'object';
}

function compareBuiltInValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (original instanceof Date && deserialized instanceof Date) {
    compareDateValues(original, deserialized, path, divergences);
  } else if (original instanceof RegExp && deserialized instanceof RegExp) {
    compareRegExpValues(original, deserialized, path, divergences);
  } else if (original instanceof Map && deserialized instanceof Map) {
    compareMapValues(original, deserialized, path, divergences);
  } else if (original instanceof Set && deserialized instanceof Set) {
    compareSetValues(original, deserialized, path, divergences);
  } else {
    return false;
  }
  return true;
}

function compareObjectValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  if (typeof original !== 'object' || original === null) return;
  if (typeof deserialized !== 'object' || deserialized === null) return;
  if (Array.isArray(original) && Array.isArray(deserialized)) {
    compareArrayValues(original, deserialized, path, divergences);
    return;
  }
  compareRecordValues(original, deserialized, path, divergences);
}
