export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected ${label} to be an object`);
  return value;
}

export function records(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`expected ${label} to be an object array`);
  }
  return value;
}

export function jsonRecord(value: string, label = 'JSON value'): Record<string, unknown> {
  return record(JSON.parse(value), label);
}

export function propertyRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}
