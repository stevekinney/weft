/**
 * `createHttpDeliveryAdapter`: a Weft `ApplicationDeliveryAdapter` that POSTs each
 * outbox delivery's inline JSON payload to an egress-checked URL, with A2A
 * authentication and Standard Webhooks signatures, and classifies what happened into
 * the outcome the outbox settles on.
 *
 * Nothing secret is stored on the delivery: its `destinationRef` and `credentialRef`
 * are locators, resolved on every attempt, so a destination deleted in the meantime
 * resolves to nothing and is rejected without a request.
 *
 * @module a2a/http-delivery-adapter
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { decodeBase64ToBytes, encodeBytesToBase64 } from "../embedded/storage/src/index.ts";
import type {
  ApplicationDeliveryAdapter,
  ApplicationDeliveryOutcome,
  ApplicationDeliverySendRequest,
} from '../core/outbox-contract.ts';
import type { EgressPolicy } from '../runtime/egress-policy.ts';
import { type A2AStreamTimerScheduler, scheduleWithTimeout } from './sse-response.ts';

/** What `resolveCredential` returns for a delivery's `credentialRef`. */
export type HttpDeliveryCredential = {
  /** With `credentials`, sent as `Authorization: <scheme> <credentials>`. */
  readonly scheme?: string | undefined;
  readonly credentials?: string | undefined;
  /** Sent as the `X-A2A-Notification-Token` header. */
  readonly notificationToken?: string | undefined;
};

type MaybePromise<T> = T | Promise<T>;

/** Options for {@link createHttpDeliveryAdapter}. */
export type HttpDeliveryAdapterOptions = {
  /**
   * The URL a delivery's `destinationRef` names, resolved on every attempt.
   * `undefined` means the destination no longer exists, and the attempt is rejected
   * without a request.
   */
  readonly resolveDestination: (destinationRef: string) => MaybePromise<string | URL | undefined>;
  /**
   * The credential a delivery's `credentialRef` names, resolved on every attempt.
   * `undefined` means the credential no longer exists, and the attempt is rejected
   * without a request; a destination that needs no authentication resolves to `{}`.
   */
  readonly resolveCredential: (
    credentialRef: string,
  ) => MaybePromise<HttpDeliveryCredential | undefined>;
  /**
   * Standard Webhooks secrets (`whsec_` followed by base64). Every delivery is signed
   * with each one, as space-delimited `webhook-signature` entries, so a receiver
   * holding any one of them verifies while a secret is rotated.
   */
  readonly signingSecrets?: readonly string[] | undefined;
  /** Checked before every request; see `createEgressPolicy`. */
  readonly egressPolicy: EgressPolicy;
  /**
   * How long one request may take before the adapter aborts it, 10000–30000 ms.
   * Default 10000. It must be lower than the outbox's `attemptTimeoutMs`, which push
   * delivery checks when it is constructed.
   */
  readonly timeoutMs?: number | undefined;
};

/** An HTTP delivery adapter. `timeoutMs` is the bound it enforces on each request. */
export type HttpDeliveryAdapter = ApplicationDeliveryAdapter & { readonly timeoutMs: number };

/** The media type of every delivery (A2A 1.0.1 HTTP binding). */
export const A2A_PUSH_CONTENT_TYPE = 'application/a2a+json';
/** The header that carries a push configuration's `token`, as `@a2a-js/sdk` 1.3.0 names it. */
export const A2A_NOTIFICATION_TOKEN_HEADER = 'X-A2A-Notification-Token';
export const DEFAULT_HTTP_DELIVERY_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 3_600_000;
const SECRET_PREFIX = 'whsec_';

/** Error codes that mean the connection never opened, so nothing was sent. */
const UNSENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ConnectionRefused',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'FailedToOpenSocket',
]);

const textEncoder = new TextEncoder();
const httpDeliveryAdapters = new WeakSet<object>();

/** Whether `adapter` was made by {@link createHttpDeliveryAdapter}. */
export function isHttpDeliveryAdapter(adapter: unknown): adapter is HttpDeliveryAdapter {
  return typeof adapter === 'object' && adapter !== null && httpDeliveryAdapters.has(adapter);
}

function requireTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_HTTP_DELIVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

function decodeSecret(secret: string): Uint8Array {
  if (typeof secret !== 'string' || !secret.startsWith(SECRET_PREFIX)) {
    throw new TypeError(`Every signing secret must start with "${SECRET_PREFIX}".`);
  }
  let key: Uint8Array;
  try {
    key = decodeBase64ToBytes(secret.slice(SECRET_PREFIX.length));
  } catch {
    throw new TypeError(`A signing secret after "${SECRET_PREFIX}" is not valid base64.`);
  }
  if (key.length === 0) throw new TypeError('A signing secret must not be empty.');
  return key;
}

function decodeSecrets(secrets: readonly string[] | undefined): Uint8Array[] {
  if (secrets === undefined) return [];
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new TypeError('signingSecrets must be a non-empty list when it is given.');
  }
  return secrets.map(decodeSecret);
}

/** One Standard Webhooks `v1,` signature per key, space-delimited. */
function sign(keys: readonly Uint8Array[], id: string, timestamp: number, body: string): string {
  const content = textEncoder.encode(`${id}.${timestamp}.${body}`);
  return keys.map((key) => `v1,${encodeBytesToBase64(hmac(sha256, key, content))}`).join(' ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return errorCode((error as { cause?: unknown }).cause);
}

/** `Retry-After` in milliseconds (delta-seconds or an HTTP-date), capped at an hour. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let delayMs: number;
  if (/^\d+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1000;
  } else {
    // Every HTTP-date form starts with a day name; `Date.parse` alone would also read
    // `-5` as a year.
    const at = /^[A-Za-z]/.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
    if (Number.isNaN(at)) return undefined;
    delayMs = at - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delayMs));
}

function classifyResponse(response: Response, now: number): ApplicationDeliveryOutcome {
  const { status } = response;
  if (status >= 200 && status < 300) return { status: 'acknowledged', evidence: { status } };
  if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
    return {
      status: 'rejected',
      message: `Redirects are not followed (${status}).`,
      details: { status },
    };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return {
      status: 'retryable',
      message: `The receiver answered ${status}.`,
      details: { status },
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now),
    };
  }
  return { status: 'rejected', message: `The receiver answered ${status}.`, details: { status } };
}

function classifyFetchError(
  error: unknown,
  timedOut: boolean,
  aborted: boolean,
): ApplicationDeliveryOutcome {
  if (timedOut) return { status: 'unknown', message: 'The request timed out.' };
  if (aborted) return { status: 'unknown', message: 'The request was aborted.' };
  const code = errorCode(error);
  if (code !== undefined && UNSENT_ERROR_CODES.has(code)) {
    return {
      status: 'retryable',
      message: `The connection was not opened: ${describeError(error)}`,
    };
  }
  return {
    status: 'unknown',
    message: `The request failed after it began: ${describeError(error)}`,
  };
}

type Resolved =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly credential: HttpDeliveryCredential | undefined;
    }
  | { readonly ok: false; readonly outcome: ApplicationDeliveryOutcome };

/** Resolve the destination and credential and run the egress check; nothing is sent. */
async function resolveRequest(
  options: HttpDeliveryAdapterOptions,
  request: ApplicationDeliverySendRequest,
): Promise<Resolved> {
  let destination: string | URL | undefined;
  let credential: HttpDeliveryCredential | undefined;
  try {
    destination = await options.resolveDestination(request.delivery.destinationRef);
    if (destination === undefined) {
      return {
        ok: false,
        outcome: { status: 'rejected', message: 'The destination no longer exists.' },
      };
    }
    if (request.credentialRef !== undefined) {
      credential = await options.resolveCredential(request.credentialRef);
      // A named credential that is gone means its configuration was deleted after the
      // destination was read; sending without it would reach a deleted destination.
      if (credential === undefined) {
        return {
          ok: false,
          outcome: { status: 'rejected', message: 'The credential no longer exists.' },
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      outcome: {
        status: 'retryable',
        message: `Resolving the delivery failed: ${describeError(error)}`,
      },
    };
  }
  const decision = await options.egressPolicy.check(destination);
  if (decision.status === 'blocked') {
    return { ok: false, outcome: { status: 'rejected', message: decision.reason } };
  }
  if (decision.status === 'unresolved') {
    return { ok: false, outcome: { status: 'retryable', message: decision.reason } };
  }
  return { ok: true, url: decision.url, credential };
}

function buildHeaders(
  request: ApplicationDeliverySendRequest,
  credential: HttpDeliveryCredential | undefined,
  signature: { readonly keys: readonly Uint8Array[]; readonly now: number; readonly body: string },
): Headers {
  const headers = new Headers({ 'content-type': A2A_PUSH_CONTENT_TYPE });
  if (credential?.scheme && credential.credentials) {
    headers.set('authorization', `${credential.scheme} ${credential.credentials}`);
  }
  if (credential?.notificationToken) {
    headers.set(A2A_NOTIFICATION_TOKEN_HEADER, credential.notificationToken);
  }
  const traceparent = request.delivery.causation?.traceparent;
  if (traceparent !== undefined) headers.set('traceparent', traceparent);
  // The id is the receiver's idempotency evidence, so it is sent with or without a
  // signature: every attempt of one delivery carries the same one.
  const id = request.delivery.externalIdempotencyKey ?? request.delivery.deliveryId;
  headers.set('webhook-id', id);
  if (signature.keys.length > 0) {
    const timestamp = Math.floor(signature.now / 1000);
    headers.set('webhook-timestamp', String(timestamp));
    headers.set('webhook-signature', sign(signature.keys, id, timestamp, signature.body));
  }
  return headers;
}

/** The scheduler and clock the adapter uses; tests replace both. */
export type HttpDeliveryAdapterRuntime = {
  readonly schedule: A2AStreamTimerScheduler;
  readonly now: () => number;
};

/** {@link createHttpDeliveryAdapter} with an injected scheduler and clock. */
export function createHttpDeliveryAdapterWithRuntime(
  options: HttpDeliveryAdapterOptions,
  runtime: HttpDeliveryAdapterRuntime,
): HttpDeliveryAdapter {
  const timeoutMs = requireTimeout(options.timeoutMs);
  const keys = decodeSecrets(options.signingSecrets);
  if (typeof options.egressPolicy?.check !== 'function') {
    throw new TypeError('egressPolicy must be an egress policy from createEgressPolicy.');
  }

  async function post(
    request: ApplicationDeliverySendRequest,
    url: URL,
    headers: Headers,
    body: string,
  ): Promise<ApplicationDeliveryOutcome> {
    const timeout = new AbortController();
    const cancelTimer = runtime.schedule(() => {
      timeout.abort(new Error('The request timed out.'));
    }, timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal,
      });
      const outcome = classifyResponse(response, runtime.now());
      // The outcome rests on the status alone; a body that errors while it is
      // discarded does not change what the receiver answered.
      await response.body?.cancel().catch(() => undefined);
      return outcome;
    } catch (error) {
      return classifyFetchError(error, timeout.signal.aborted, request.signal.aborted);
    } finally {
      cancelTimer();
    }
  }

  const adapter: HttpDeliveryAdapter = {
    timeoutMs,
    async send(request) {
      if (request.payload.form !== 'inline') {
        return { status: 'rejected', message: 'HTTP delivery sends inline payloads only.' };
      }
      const resolved = await resolveRequest(options, request);
      if (!resolved.ok) return resolved.outcome;
      const body = JSON.stringify(request.payload.value);
      let headers: Headers;
      try {
        headers = buildHeaders(request, resolved.credential, { keys, now: runtime.now(), body });
      } catch (error) {
        return {
          status: 'rejected',
          message: `A header value is invalid: ${describeError(error)}`,
        };
      }
      return post(request, resolved.url, headers, body);
    },
  };
  httpDeliveryAdapters.add(adapter);
  return adapter;
}

/**
 * Create an HTTP delivery adapter. Each delivery POSTs its inline payload as JSON with
 * `Content-Type: application/a2a+json`, never follows a redirect, and settles as:
 *
 * - `2xx`: `acknowledged`.
 * - Connection refused, DNS failure, or a destination or credential resolver that
 *   failed, before anything was sent: `retryable`.
 * - `408`, `429`, `5xx`: `retryable`, honoring `Retry-After` (delta-seconds or an
 *   HTTP-date, capped at 3600 seconds).
 * - `3xx`, any other `4xx`, a destination the egress policy blocks, or a destination
 *   or credential that no longer exists: `rejected`.
 * - A timeout, reset, or abort after the request began: `unknown`.
 *
 * @throws {RangeError} When `timeoutMs` is outside 10000–30000.
 * @throws {TypeError} When `signingSecrets` is empty or holds a malformed secret.
 */
export function createHttpDeliveryAdapter(
  options: HttpDeliveryAdapterOptions,
): HttpDeliveryAdapter {
  return createHttpDeliveryAdapterWithRuntime(options, {
    schedule: scheduleWithTimeout,
    now: () => Date.now(),
  });
}
