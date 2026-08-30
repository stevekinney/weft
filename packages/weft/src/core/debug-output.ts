const REDACTED_VALUE = '[REDACTED]';
const CIRCULAR_REFERENCE_VALUE = '[Circular]';
const UNSERIALIZABLE_VALUE = '[unserializable]';

const SENSITIVE_KEY_PATTERN =
  /(?:access[-_]?token|api[-_]?key|auth(?:orization)?|card(?:number)?|cookie|credential|cvc|cvv|pass(?:word|phrase)?|private[-_]?key|refresh[-_]?token|secret|session|ssn|token)/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function looksLikeJsonWebToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }

  return value.split('.').every((segment) => segment.length >= 6);
}

function passesLuhnCheck(value: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let index = value.length - 1; index >= 0; index--) {
    const digit = Number(value[index]);
    let transformed = digit;
    if (shouldDouble) {
      transformed *= 2;
      if (transformed > 9) {
        transformed -= 9;
      }
    }

    sum += transformed;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function looksLikePaymentCardNumber(value: string): boolean {
  const digitsOnly = value.replaceAll(/[\s-]/g, '');
  return /^\d{13,19}$/.test(digitsOnly) && passesLuhnCheck(digitsOnly);
}

function sanitizeDebugString(value: string): string {
  const trimmed = value.trim();
  if (/^(?:Bearer|Basic)\s+\S+/i.test(trimmed)) {
    return REDACTED_VALUE;
  }

  if (looksLikeJsonWebToken(trimmed) || looksLikePaymentCardNumber(trimmed)) {
    return REDACTED_VALUE;
  }

  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ObjectSanitizerResult = { supported: true; value: unknown } | { supported: false };

type ObjectSanitizer = (value: object, seen: WeakSet<object>) => ObjectSanitizerResult;

function unsupportedObject(): ObjectSanitizerResult {
  return { supported: false };
}

function supportedObject(value: unknown): ObjectSanitizerResult {
  return { supported: true, value };
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeMap(value: Map<unknown, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of value) {
    const normalizedKey = String(key);
    result[normalizedKey] = isSensitiveKey(normalizedKey)
      ? REDACTED_VALUE
      : sanitizeDebugValue(entryValue, seen);
  }
  return result;
}

function sanitizePlainObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED_VALUE : sanitizeDebugValue(entryValue, seen);
  }
  return result;
}

const objectSanitizers: ObjectSanitizer[] = [
  (value) => (value instanceof Date ? supportedObject(value.toISOString()) : unsupportedObject()),
  (value) =>
    value instanceof Error
      ? supportedObject({ name: value.name, message: sanitizeDebugString(value.message) })
      : unsupportedObject(),
  (value) =>
    value instanceof Uint8Array
      ? supportedObject(`[Uint8Array(${value.byteLength})]`)
      : unsupportedObject(),
  (value, seen) =>
    Array.isArray(value)
      ? supportedObject(value.map((entry) => sanitizeDebugValue(entry, seen)))
      : unsupportedObject(),
  (value, seen) =>
    value instanceof Set
      ? supportedObject([...value].map((entry) => sanitizeDebugValue(entry, seen)))
      : unsupportedObject(),
  (value, seen) =>
    value instanceof Map ? supportedObject(sanitizeMap(value, seen)) : unsupportedObject(),
  (value, seen) =>
    isPlainObject(value) ? supportedObject(sanitizePlainObject(value, seen)) : unsupportedObject(),
];

function sanitizeObject(value: object, seen: WeakSet<object>): unknown {
  if (seen.has(value)) {
    return CIRCULAR_REFERENCE_VALUE;
  }

  seen.add(value);

  try {
    for (const sanitizer of objectSanitizers) {
      const sanitized = sanitizer(value, seen);
      if (sanitized.supported) {
        return sanitized.value;
      }
    }

    return Object.prototype.toString.call(value);
  } finally {
    seen.delete(value);
  }
}

function sanitizeDebugValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return sanitizeDebugString(value);
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }

  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value);
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  return sanitizeObject(value, seen);
}

export function sanitizeDebugValueForDisplay(value: unknown): unknown {
  return sanitizeDebugValue(value, new WeakSet<object>());
}

export function safeDebugStringify(value: unknown, indentation?: number): string {
  if (value === undefined) {
    return 'undefined';
  }

  const sanitized = sanitizeDebugValueForDisplay(value);
  if (typeof sanitized === 'string') {
    return JSON.stringify(sanitized);
  }

  try {
    const serialized = JSON.stringify(sanitized, null, indentation);
    return serialized ?? Object.prototype.toString.call(sanitized);
  } catch {
    return UNSERIALIZABLE_VALUE;
  }
}
