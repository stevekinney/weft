import { encode } from './codec.ts';
import { WeftError } from './weft-error.ts';

export const SESSION_STATE_LOCAL_KEY = 'stateSession';
export const MAX_SESSION_STATE_ENTRY_COUNT = 256;
export const MAX_SESSION_STATE_KEY_LENGTH = 256;
export const MAX_SESSION_STATE_SERIALIZED_BYTES = 32 * 1024;

const RESERVED_SESSION_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class SessionStateValidationError extends WeftError<'SessionStateValidationError'> {
  constructor(message: string) {
    super('SessionStateValidationError', message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function createSessionStateStore(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function hasSessionStateKey(store: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(store, key);
}

export function assertValidSessionStateKey(key: string): void {
  if (key.length === 0 || key.length > MAX_SESSION_STATE_KEY_LENGTH) {
    throw new SessionStateValidationError(
      `Session state key must be 1-${String(MAX_SESSION_STATE_KEY_LENGTH)} characters long.`,
    );
  }

  if (RESERVED_SESSION_STATE_KEYS.has(key)) {
    throw new SessionStateValidationError(`Session state key "${key}" is reserved.`);
  }
}

export function cloneSessionStateValue<T>(value: T): T {
  return structuredClone(value);
}

export function cloneSessionStateStore(
  store: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!store) {
    return undefined;
  }

  const clonedStore = createSessionStateStore();
  for (const [key, value] of Object.entries(store)) {
    clonedStore[key] = cloneSessionStateValue(value);
  }
  return clonedStore;
}

export function normalizeSessionStateRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new SessionStateValidationError('Session state must be a plain object record.');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length > MAX_SESSION_STATE_ENTRY_COUNT) {
    throw new SessionStateValidationError(
      `Session state may not contain more than ${String(MAX_SESSION_STATE_ENTRY_COUNT)} keys.`,
    );
  }

  const normalized = createSessionStateStore();
  for (const [key, entryValue] of entries) {
    assertValidSessionStateKey(key);
    normalized[key] = cloneSessionStateValue(entryValue);
  }

  validateSessionStateStore(normalized);
  return normalized;
}

export function normalizeSessionStateLocals(
  locals: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!locals) {
    return undefined;
  }

  return normalizeSessionStateRecord(locals[SESSION_STATE_LOCAL_KEY]);
}

export function validateSessionStateStore(store: Record<string, unknown>): void {
  const keys = Object.keys(store);
  if (keys.length > MAX_SESSION_STATE_ENTRY_COUNT) {
    throw new SessionStateValidationError(
      `Session state may not contain more than ${String(MAX_SESSION_STATE_ENTRY_COUNT)} keys.`,
    );
  }

  for (const key of keys) {
    assertValidSessionStateKey(key);
  }

  const serializedBytes = encode(store).byteLength;
  if (serializedBytes > MAX_SESSION_STATE_SERIALIZED_BYTES) {
    throw new SessionStateValidationError(
      `Session state exceeds the ${String(MAX_SESSION_STATE_SERIALIZED_BYTES)} byte limit.`,
    );
  }
}

export function validateSessionStateLocals(locals: Record<string, unknown>): void {
  normalizeSessionStateLocals(locals);
}
