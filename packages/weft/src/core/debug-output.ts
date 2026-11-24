const REDACTED_VALUE = '[REDACTED]';
const CIRCULAR_REFERENCE_VALUE = '[Circular]';
const UNSERIALIZABLE_VALUE = '[unserializable]';
const INVALID_DATE_VALUE = '[Invalid Date]';

const SENSITIVE_KEY_PATTERN =
  /(?:access[-_]?token|api[-_]?key|auth(?:orization)?|card(?:number)?|cookie|credential|cvc|cvv|pass(?:word|phrase)?|private[-_]?key|refresh[-_]?token|secret|session|ssn|token)/i;

/**
 * Words that name a secret outright. A key with one of these as a whole word (or as the pair
 * `api key`, `private key`, `access key`) is redacted whatever its value is, because a card
 * number, a CVV, a social security number or a PIN is routinely held as a number. Matching is by
 * word, not by substring, so `cardinality` and `passed` are not caught: the key is split on
 * camelCase, snake_case, kebab-case and dots, compared case-insensitively, and a trailing `s`
 * (`credentials`, `secrets`) is ignored.
 */
const STRONG_KEY_WORDS: ReadonlySet<string> = new Set([
  'card',
  'cardnumber',
  'creditcard',
  'cvv',
  'cvc',
  'ssn',
  'pin',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'privatekey',
  'accesskey',
  'credential',
]);

const STRONG_KEY_PAIRS: ReadonlySet<string> = new Set(['apikey', 'privatekey', 'accesskey']);

function keyWords(key: string): string[] {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isStrongKeyWord(word: string): boolean {
  return (
    STRONG_KEY_WORDS.has(word) || (word.endsWith('s') && STRONG_KEY_WORDS.has(word.slice(0, -1)))
  );
}

function isStrongKey(key: string): boolean {
  const words = keyWords(key);
  return words.some(
    (word, index) =>
      isStrongKeyWord(word) || (index > 0 && STRONG_KEY_PAIRS.has(`${words[index - 1]}${word}`)),
  );
}

/** How a key is treated: `strong` redacts any value, `loose` only a value that could be a secret. */
type KeySensitivity = 'strong' | 'loose' | 'none';

function keySensitivity(key: string): KeySensitivity {
  if (isStrongKey(key)) {
    return 'strong';
  }

  return SENSITIVE_KEY_PATTERN.test(key) ? 'loose' : 'none';
}

/**
 * Whether a value under a loose sensitive-looking key (`token`, `session`, `auth`, ...) is
 * redacted. A number, a boolean, `null` and `undefined` pass through, because a token is never
 * one (`inputTokens: 12` is a count, not a credential); a string, an object, an array and
 * anything else is replaced.
 */
function carriesSecret(value: unknown): boolean {
  return !(
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * The sanitized value of one entry. `read` is the entry's accessor, so a getter that throws costs
 * only its own entry: the entry becomes `[unserializable]`, or `[REDACTED]` under a sensitive key,
 * where the value cannot be inspected and so is assumed to be a secret.
 */
function sanitizeEntry(key: string, read: () => unknown, seen: WeakSet<object>): unknown {
  const sensitivity = keySensitivity(key);
  let value: unknown;
  try {
    value = read();
  } catch {
    return sensitivity === 'none' ? UNSERIALIZABLE_VALUE : REDACTED_VALUE;
  }

  if (sensitivity === 'strong' || (sensitivity === 'loose' && carriesSecret(value))) {
    return REDACTED_VALUE;
  }

  return sanitizeDebugValue(value, seen);
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
    result[normalizedKey] = sanitizeEntry(normalizedKey, () => entryValue, seen);
  }
  return result;
}

function sanitizePlainObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = sanitizeEntry(key, () => value[key], seen);
  }
  return result;
}

const objectSanitizers: ObjectSanitizer[] = [
  (value) => {
    if (!(value instanceof Date)) {
      return unsupportedObject();
    }

    return supportedObject(
      Number.isNaN(value.getTime()) ? INVALID_DATE_VALUE : value.toISOString(),
    );
  },
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
  } catch {
    // A hostile value (a Proxy whose traps throw, an Error whose `message` getter throws) costs
    // only its own slot; the surrounding object keeps every other entry.
    return UNSERIALIZABLE_VALUE;
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
