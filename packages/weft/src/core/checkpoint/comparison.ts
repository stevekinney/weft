import type { CheckpointDivergence } from './interfaces.ts';

type ComparisonHandler = {
  matches(original: unknown, deserialized: unknown): boolean;
  compare(
    original: unknown,
    deserialized: unknown,
    path: string,
    divergences: CheckpointDivergence[],
  ): void;
};

export function compareValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  if (original === deserialized) return;

  const handler = comparisonHandlers.find((candidate) => candidate.matches(original, deserialized));
  handler?.compare(original, deserialized, path, divergences);
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
  original: Record<string, unknown>,
  deserialized: Record<string, unknown>,
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
        deserialized[key],
        'Extra key appeared in deserialized object.',
      );
      continue;
    }

    if (!(key in deserialized)) {
      recordDivergence(
        divergences,
        propertyPath,
        original[key],
        undefined,
        'Key missing from deserialized object.',
      );
      continue;
    }

    compareValues(original[key], deserialized[key], propertyPath, divergences);
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

const comparisonHandlers: ComparisonHandler[] = [
  {
    matches: isNullishPair,
    compare: compareNullishValues,
  },
  {
    matches: (original, deserialized) => original instanceof Date && deserialized instanceof Date,
    compare: (original, deserialized, path, divergences) =>
      compareDateValues(original as Date, deserialized as Date, path, divergences),
  },
  {
    matches: (original, deserialized) =>
      original instanceof RegExp && deserialized instanceof RegExp,
    compare: (original, deserialized, path, divergences) =>
      compareRegExpValues(original as RegExp, deserialized as RegExp, path, divergences),
  },
  {
    matches: (original, deserialized) => original instanceof Map && deserialized instanceof Map,
    compare: (original, deserialized, path, divergences) =>
      compareMapValues(
        original as Map<unknown, unknown>,
        deserialized as Map<unknown, unknown>,
        path,
        divergences,
      ),
  },
  {
    matches: (original, deserialized) => original instanceof Set && deserialized instanceof Set,
    compare: (original, deserialized, path, divergences) =>
      compareSetValues(original as Set<unknown>, deserialized as Set<unknown>, path, divergences),
  },
  {
    matches: isTypeMismatch,
    compare: compareTypeMismatch,
  },
  {
    matches: isPrimitivePair,
    compare: comparePrimitiveValues,
  },
  {
    matches: (original, deserialized) => Array.isArray(original) && Array.isArray(deserialized),
    compare: (original, deserialized, path, divergences) =>
      compareArrayValues(original as unknown[], deserialized as unknown[], path, divergences),
  },
  {
    matches: () => true,
    compare: (original, deserialized, path, divergences) =>
      compareRecordValues(
        original as Record<string, unknown>,
        deserialized as Record<string, unknown>,
        path,
        divergences,
      ),
  },
];
