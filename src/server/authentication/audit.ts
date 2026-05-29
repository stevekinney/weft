/**
 * Structured authentication audit trail.
 *
 * Every authentication decision the server makes — admission or rejection —
 * emits one structured event so operators have a compliance-grade record of who
 * authenticated, by which method, against which request, and whether it
 * succeeded. The event is deliberately free of secrets: it carries the
 * authenticated subject and method, never the presented credential.
 *
 * The default sink writes a single JSON line to `console.info` (success) or
 * `console.warn` (failure), which standard log shippers collect. Embedders that
 * forward audit events to a SIEM supply their own {@link AuthAuditSink} via
 * `serve({ auth: { auditSink } })`.
 *
 * @module server/authentication/audit
 */

import { redactCredential } from './redaction.ts';
import type { AuthMethod } from './types.ts';

/**
 * A single authentication audit record. Emitted once per authenticated request
 * (including public-path bypass and rejection). Contains no credential
 * material — `credentialFingerprint`, when present, is the one-way mask from
 * {@link redactCredential}, suitable for correlating events about the same key
 * without revealing it.
 *
 * @example
 * ```ts
 * import { type AuthAuditEvent } from 'weft/server';
 *
 * const event: AuthAuditEvent = {
 *   outcome: 'success',
 *   method: 'api-key',
 *   subject: 'service-account-7',
 *   path: '/v1/workflows',
 *   httpMethod: 'POST',
 *   timestamp: new Date().toISOString(),
 * };
 * void event;
 * ```
 */
export type AuthAuditEvent = {
  /** Whether the request was admitted (`success`) or rejected (`failure`). */
  outcome: 'success' | 'failure';
  /** Admission path that decided the request, or `unknown` when no method matched. */
  method: AuthMethod | 'unknown';
  /** Authenticated principal subject, when one was established. */
  subject?: string;
  /** Request path the decision applied to (already prefix-normalized). */
  path: string;
  /** HTTP method of the request. */
  httpMethod: string;
  /** ISO-8601 timestamp of the decision. */
  timestamp: string;
  /** Client-safe rejection reason on failure. Never contains credential bytes. */
  reason?: string;
  /** One-way masked fingerprint of the presented credential, for correlation. */
  credentialFingerprint?: string;
};

/**
 * Sink that receives every {@link AuthAuditEvent}. Supply a custom sink via
 * `serve({ auth: { auditSink } })` to forward audit records to a SIEM or
 * structured-logging pipeline; omit it to use {@link defaultAuthAuditSink}.
 *
 * Implementations must be non-throwing and fast — the sink runs inline on the
 * authentication path. Failures inside a sink must not break request handling.
 *
 * @example
 * ```ts
 * import { type AuthAuditEvent, type AuthAuditSink } from 'weft/server';
 *
 * const collected: AuthAuditEvent[] = [];
 * const sink: AuthAuditSink = (event) => collected.push(event);
 * void sink;
 * ```
 */
export type AuthAuditSink = (event: AuthAuditEvent) => void;

/**
 * Default {@link AuthAuditSink}: writes one structured JSON line per event,
 * routing successes to `console.info` and failures to `console.warn`. The
 * `weft.auth-audit` discriminator lets log processors filter the audit stream.
 *
 * @example
 * ```ts
 * import { defaultAuthAuditSink } from 'weft/server';
 *
 * defaultAuthAuditSink({
 *   outcome: 'failure',
 *   method: 'unknown',
 *   path: '/v1/workflows',
 *   httpMethod: 'GET',
 *   timestamp: new Date().toISOString(),
 *   reason: 'No valid credentials provided',
 * });
 * ```
 */
export function defaultAuthAuditSink(event: AuthAuditEvent): void {
  const line = JSON.stringify({ type: 'weft.auth-audit', ...event });
  if (event.outcome === 'success') {
    console.info(line);
  } else {
    console.warn(line);
  }
}

/**
 * Inputs needed to build and emit an audit event for a single request. The
 * raw `presentedCredential` is masked here — it is never stored on the event
 * or passed to the sink in cleartext.
 */
export type AuthAuditContext = {
  outcome: 'success' | 'failure';
  method: AuthMethod | 'unknown';
  subject: string | undefined;
  request: Request;
  reason?: string | undefined;
  presentedCredential?: string | null | undefined;
};

/**
 * Build an {@link AuthAuditEvent} from request context and hand it to `sink`,
 * masking the presented credential first. A throwing sink is swallowed (and
 * logged) so audit-emission failures never break request handling.
 *
 * @internal
 */
export function emitAuthAuditEvent(sink: AuthAuditSink, context: AuthAuditContext): void {
  const url = new URL(context.request.url);
  const event: AuthAuditEvent = {
    outcome: context.outcome,
    method: context.method,
    path: url.pathname,
    httpMethod: context.request.method,
    timestamp: new Date().toISOString(),
    ...(context.subject !== undefined ? { subject: context.subject } : {}),
    ...(context.reason !== undefined ? { reason: context.reason } : {}),
    ...(context.presentedCredential !== undefined && context.presentedCredential !== null
      ? { credentialFingerprint: redactCredential(context.presentedCredential) }
      : {}),
  };
  try {
    sink(event);
  } catch (error) {
    // An audit sink must never break request handling. Log the sink failure
    // (without the event payload, which could be voluminous) and continue.
    console.error('[weft] auth audit sink threw:', error instanceof Error ? error.message : error);
  }
}
