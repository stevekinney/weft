/**
 * Credential redaction for logs and audit events.
 *
 * Authentication code logs request context (auth outcomes, JWT failures,
 * resolver throws) and the audit trail records who called what. None of that
 * may ever carry a live credential: an `Authorization: Bearer <token>` value,
 * an `X-API-Key`, or a `Cookie`/`Set-Cookie` session token leaking into a log
 * line is a credential disclosure. These helpers mask such values *before* they
 * reach `console.*` or an audit sink.
 *
 * The redaction is one-way and irreversible. A masked value keeps just enough
 * shape to correlate two log lines about the same credential (a short stable
 * fingerprint) without revealing the secret itself.
 *
 * @module server/authentication/redaction
 */

/**
 * Header names whose values are credentials and must always be masked.
 * Compared case-insensitively. The list is intentionally conservative: it
 * covers the headers Weft's own authenticator reads (`Authorization`,
 * `X-API-Key`) plus the browser session-cookie headers that a reverse proxy or
 * embedder might attach.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

/** Marker substituted for an empty or absent credential. */
const EMPTY_REDACTION = '<redacted:empty>';

/**
 * Mask a credential value so it can appear in a log or audit record without
 * disclosing the secret. The result reveals only the length bucket and a short
 * non-reversible fingerprint, which is enough to tell whether two log lines
 * concern the same credential without exposing it.
 *
 * The fingerprint is derived from a non-cryptographic hash of the value. It is
 * deliberately *not* the raw prefix of the token — revealing even a prefix of a
 * high-entropy API key narrows a brute-force search. Equal inputs produce equal
 * fingerprints; differing inputs almost always differ.
 *
 * @example
 * ```ts
 * import { redactCredential } from 'weft/server';
 *
 * const masked = redactCredential('weft_key_super_secret_value');
 * console.log(masked.startsWith('<redacted:')); // true
 * console.log(masked.includes('secret')); // false
 * ```
 */
export function redactCredential(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return EMPTY_REDACTION;
  }
  // Strip a leading `Bearer ` scheme so the fingerprint tracks the token, not
  // the scheme — `Authorization: Bearer X` and `X-API-Key: X` fingerprint alike.
  const token = value.startsWith('Bearer ') ? value.slice('Bearer '.length) : value;
  const fingerprint = fingerprintToken(token);
  return `<redacted:len=${token.length}:fp=${fingerprint}>`;
}

/**
 * FNV-1a 32-bit hash rendered as zero-padded hex. Non-cryptographic and
 * one-way for log-correlation purposes only — never used for authentication.
 */
function fingerprintToken(token: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    // FNV prime multiply, kept in 32-bit unsigned range via Math.imul + >>> 0.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Produce a plain object snapshot of a request's headers with every sensitive
 * value masked via {@link redactCredential}. Use this when attaching request
 * headers to a log line or audit record — it guarantees no credential header
 * passes through verbatim.
 *
 * Header names are lower-cased (the `Headers` iterator already lower-cases
 * them) so the result is stable regardless of the casing the client sent.
 *
 * @example
 * ```ts
 * import { redactHeaders } from 'weft/server';
 *
 * const request = new Request('http://localhost/v1/workflows', {
 *   headers: { Authorization: 'Bearer secret-token', 'X-Trace-Id': 'abc' },
 * });
 * const safe = redactHeaders(request.headers);
 * console.log(safe['x-trace-id']); // 'abc'
 * console.log(safe['authorization']?.startsWith('<redacted:')); // true
 * ```
 */
export function redactHeaders(headers: Headers): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of headers) {
    snapshot[name] = SENSITIVE_HEADER_NAMES.has(name) ? redactCredential(value) : value;
  }
  return snapshot;
}

/**
 * Whether a header name is treated as credential-bearing and therefore masked
 * by {@link redactHeaders}. Comparison is case-insensitive.
 *
 * @example
 * ```ts
 * import { isSensitiveHeader } from 'weft/server';
 *
 * console.log(isSensitiveHeader('Authorization')); // true
 * console.log(isSensitiveHeader('X-Trace-Id')); // false
 * ```
 */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}
