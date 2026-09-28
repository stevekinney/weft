/**
 * Strict JSON validation for worker transport payloads.
 *
 * `JSON.stringify` is intentionally not used as a validator here: it erases
 * unsupported values (`undefined`, functions, symbols), rewrites non-finite
 * numbers to `null`, converts `Date`/`Map`/class instances to some other
 * shape, and cannot explain where the bad value lived. Worker input, output,
 * and heartbeat payloads cross a process boundary, so lossy conversion is a
 * protocol error rather than a convenience.
 *
 * @module worker/strict-json
 */

import type { RemoteWorkerJsonValue } from './protocol.ts';

export class WorkerJsonValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'WorkerJsonValidationError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new WorkerJsonValidationError(path, message);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

type ScalarValidation =
  { done: true; value: RemoteWorkerJsonValue } | { done: false; object: object };

function validateNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) fail(path, 'number must be finite');
  if (Object.is(value, -0)) fail(path, 'negative zero is not valid worker JSON');
  return value;
}

function validateNonObject(value: unknown, path: string): RemoteWorkerJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return validateNumber(value, path);
  }

  if (value === undefined) fail(path, 'undefined is not valid worker JSON');
  if (typeof value === 'bigint') fail(path, 'BigInt is not valid worker JSON');
  if (typeof value === 'function') fail(path, 'function is not valid worker JSON');
  if (typeof value === 'symbol') fail(path, 'symbol is not valid worker JSON');
  return fail(path, `${typeof value} is not valid worker JSON`);
}

function validateScalarOrObject(value: unknown, path: string): ScalarValidation {
  if (value !== null && typeof value === 'object') {
    return { done: false, object: value };
  }
  return { done: true, value: validateNonObject(value, path) };
}

function validateStrictArray(
  value: readonly unknown[],
  path: string,
  seen: WeakSet<object>,
): RemoteWorkerJsonValue[] {
  const output: RemoteWorkerJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(`${path}[${String(index)}]`, 'sparse array slot is not valid worker JSON');
    }
    output.push(validateStrictJsonValue(value[index], `${path}[${String(index)}]`, seen));
  }
  return output;
}

function validateStrictRecord(
  value: Record<string, unknown>,
  path: string,
  seen: WeakSet<object>,
): Record<string, RemoteWorkerJsonValue> {
  const output: Record<string, RemoteWorkerJsonValue> = Object.create(null) as Record<
    string,
    RemoteWorkerJsonValue
  >;
  for (const [key, nested] of Object.entries(value)) {
    output[key] = validateStrictJsonValue(nested, propertyPath(path, key), seen);
  }
  return output;
}

function validateStrictJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): RemoteWorkerJsonValue {
  const scalar = validateScalarOrObject(value, path);
  if (scalar.done) return scalar.value;

  const objectValue = scalar.object;
  if (seen.has(objectValue)) fail(path, 'cycle is not valid worker JSON');
  seen.add(objectValue);

  try {
    if (Array.isArray(objectValue)) {
      return validateStrictArray(objectValue, path, seen);
    }

    if (!isPlainObject(objectValue)) {
      fail(path, `${objectValue.constructor?.name ?? 'object'} is not a plain JSON object`);
    }

    return validateStrictRecord(objectValue, path, seen);
  } finally {
    seen.delete(objectValue);
  }
}

/**
 * Return a JSON-safe clone of `value`, or throw with an actionable path when
 * the value cannot cross the worker transport without losing information.
 */
export function encodeStrictWorkerJsonValue(value: unknown, path = 'value'): RemoteWorkerJsonValue {
  return validateStrictJsonValue(value, path, new WeakSet<object>());
}

/**
 * Predicate counterpart to {@link encodeStrictWorkerJsonValue}. Intended for
 * protocol guards that already have a parsed value and need a boolean shape.
 */
export function isStrictWorkerJsonValue(value: unknown): value is RemoteWorkerJsonValue {
  try {
    encodeStrictWorkerJsonValue(value);
    return true;
  } catch {
    return false;
  }
}
