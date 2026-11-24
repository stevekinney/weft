/**
 * The `fetch` the peer client gives the SDK: it checks egress, supplies credentials, bounds how
 * long a peer may take to start answering, and turns refusals and outages into typed errors.
 *
 * @module a2a/peer-fetch
 */

import type { EgressPolicy } from '../runtime/egress-policy.ts';
import { A2APeerError } from './peer-client-types.ts';

/** What a peer asked for when it refused a request with 401 or 403. */
export interface A2APeerChallenge {
  /** The HTTP status, `401` or `403`. */
  readonly status: number;
  /** The URL that refused. */
  readonly url: string;
  /** The `WWW-Authenticate` header, when the peer sent one. */
  readonly wwwAuthenticate: string | undefined;
}

/** Request headers that carry credentials. */
export type PeerCredentials = Readonly<Record<string, string>>;

/** Supplies credentials; see `A2APeerClientOptions.authenticate`. */
export type PeerAuthenticate = (
  challenge?: A2APeerChallenge,
) => Promise<PeerCredentials | undefined> | PeerCredentials | undefined;

/** What {@link createPeerFetch} needs. */
export interface PeerFetchOptions {
  readonly fetch: typeof fetch;
  readonly authenticate: PeerAuthenticate | undefined;
  readonly egressPolicy: EgressPolicy | undefined;
  readonly requestTimeoutMs: number;
}

/**
 * Throws `egress-denied` or retryable `unreachable` unless `policy` allows `url`. Without a
 * policy only `https:` URLs pass.
 */
export async function checkEgress(policy: EgressPolicy | undefined, url: string): Promise<void> {
  if (policy === undefined) {
    if (new URL(url).protocol !== 'https:') {
      throw new A2APeerError(
        'egress-denied',
        `Only https: URLs are contacted without an egress policy; refused ${url}.`,
      );
    }
    return;
  }
  const decision = await policy.check(url);
  if (decision.status === 'blocked') {
    throw new A2APeerError('egress-denied', `Egress to ${url} is blocked: ${decision.reason}`);
  }
  if (decision.status === 'unresolved') {
    throw new A2APeerError('unreachable', `Could not resolve ${url}: ${decision.reason}`, {
      retryable: true,
    });
  }
}

function isRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

function withCredentials(base: Request, credentials: PeerCredentials | undefined): Headers {
  const headers = new Headers(base.headers);
  for (const [name, value] of Object.entries(credentials ?? {})) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function unreachable(timedOut: boolean, timeoutMs: number, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return new A2APeerError(
    'unreachable',
    timedOut
      ? `The peer did not answer within ${timeoutMs} ms.`
      : `The peer could not be reached: ${reason}`,
    { cause: error, retryable: true },
  );
}

async function attempt(
  options: PeerFetchOptions,
  base: Request,
  credentials: PeerCredentials | undefined,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.requestTimeoutMs);
  try {
    return await options.fetch(
      new Request(base.clone(), {
        headers: withCredentials(base, credentials),
        signal: AbortSignal.any([base.signal, timeout.signal]),
        redirect: 'manual',
      }),
    );
  } catch (error) {
    if (base.signal.aborted) throw error;
    throw unreachable(timeout.signal.aborted, options.requestTimeoutMs, error);
  } finally {
    clearTimeout(timer);
  }
}

/** Retries a 401 or 403 once with credentials acquired for the challenge. */
async function answerChallenge(
  options: PeerFetchOptions,
  base: Request,
  response: Response,
): Promise<Response> {
  const credentials = await options.authenticate?.({
    status: response.status,
    url: base.url,
    wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
  });
  if (credentials === undefined) return response;
  await response.body?.cancel();
  return attempt(options, base, credentials);
}

async function rejectFailure(response: Response, url: string): Promise<void> {
  // Redirects are never followed: the egress and origin checks ran on `url` only, and a
  // redirect would replay the request and its credentials against an unchecked host.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new A2APeerError(
      'egress-denied',
      `The peer redirected ${url} (HTTP ${response.status}); redirects are not followed.`,
    );
  }
  const refused = isRefusal(response.status);
  const outage = response.status === 429 || response.status >= 500;
  if (!refused && !outage) return;
  await response.body?.cancel();
  if (refused) {
    throw new A2APeerError('unauthorized', `The peer refused ${url} with HTTP ${response.status}.`);
  }
  throw new A2APeerError('unreachable', `The peer answered HTTP ${response.status}.`, {
    retryable: true,
  });
}

/** A `fetch` for the SDK that applies the peer client's egress, credential, and timeout rules. */
export function createPeerFetch(options: PeerFetchOptions): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const base = new Request(input, init);
    await checkEgress(options.egressPolicy, base.url);
    let response = await attempt(options, base, await options.authenticate?.());
    if (isRefusal(response.status) && options.authenticate !== undefined) {
      response = await answerChallenge(options, base, response);
    }
    await rejectFailure(response, base.url);
    return response;
  }) as typeof fetch;
}
