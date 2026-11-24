/**
 * An A2A 1.0 client for calling a peer agent, addressed by its Agent Card.
 *
 * @module a2a/peer-client
 */

import type { AgentCard } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type Client,
} from '@a2a-js/sdk/client';

import type { EgressPolicy } from '../runtime/egress-policy.ts';
import { originOf, validatePeerCard } from './peer-card.ts';
import {
  A2APeerError,
  type A2APeerCard,
  type A2APeerClient,
  type A2APeerErrorCode,
  type A2APeerTask,
} from './peer-client-types.ts';
import { classifyPeerError } from './peer-errors.ts';
import { checkEgress, createPeerFetch, type PeerAuthenticate } from './peer-fetch.ts';
import { DEFAULT_PEER_ARTIFACT_LIMIT, ingestCard } from './peer-ingest.ts';
import { retryRequest, type PeerRetryPolicy } from './peer-retry.ts';
import {
  assertAttachRequest,
  assertSendRequest,
  attachPeerTask,
  startPeerTask,
} from './peer-task-start.ts';
import type { PeerTaskContext } from './peer-task.ts';
import { requireTimerDelayMs } from './timer-delay.ts';

export type { A2APeerChallenge } from './peer-fetch.ts';

/** Options for {@link createA2APeerClient}. */
export interface A2APeerClientOptions {
  /**
   * The peer's base URL: the Agent Card is read from `/.well-known/agent-card.json` under it.
   * Only `https:` is contacted unless `egressPolicy` allows more. Redirects are never followed.
   */
  readonly url: string;
  /** The `fetch` to use. Defaults to the global one. */
  readonly fetch?: typeof fetch | undefined;
  /**
   * Supplies credentials as request headers. Called before every request with no argument, and
   * once more with the {@link A2APeerChallenge} after a 401 or 403; headers returned for a
   * challenge are used to retry that request once. A second refusal fails the call with
   * `unauthorized`.
   */
  readonly authenticate?: PeerAuthenticate | undefined;
  /**
   * The extension URIs this client implements. A card that marks any other extension `required`
   * is refused with {@link ExtensionSupportRequiredError}. Declared extensions in this list are
   * activated on every request. Default: none.
   */
  readonly supportedExtensions?: readonly string[] | undefined;
  /** Checked against the card URL and the selected interface URL before they are contacted. */
  readonly egressPolicy?: EgressPolicy | undefined;
  /**
   * Origins, besides the card's own, whose interface URLs the client may select. A card that
   * lists only other origins is refused with `egress-denied`. Default: the card's origin only.
   */
  readonly allowedInterfaceOrigins?: readonly string[] | undefined;
  /** How long a validated card is reused. Default 300000 (five minutes). */
  readonly cardCacheMs?: number | undefined;
  /** How long one request may take to start answering. Default 30000. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long `result()` waits for a task to stop before canceling it. Default 600000. */
  readonly taskTimeoutMs?: number | undefined;
  /** Attempts per request, including the first, for retryable failures. Default 3. */
  readonly attempts?: number | undefined;
  /** Delay before the first retry; doubles per attempt. Default 200. */
  readonly retryBaseDelayMs?: number | undefined;
  /** The longest delay between retries or polls. Default 5000. */
  readonly retryMaxDelayMs?: number | undefined;
  /** Delay before the first `GetTask` poll of a non-streaming peer. Default 500. */
  readonly pollIntervalMs?: number | undefined;
  /**
   * The most text, in characters, kept from one piece of peer content. It bounds each artifact's
   * content and also each reply message's text (a status message or a bare message answer), which
   * is cut to the same length. Default 1048576.
   */
  readonly artifactLimit?: number | undefined;
  /** Clock for the card cache. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Waits `ms`, resolving early when `signal` aborts. Defaults to a timer. */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

/** Relative, so a base URL with a path (a mount like `/a2a/agent`) keeps its path. */
const CARD_PATH = '.well-known/agent-card.json';
const ACCEPTED_OUTPUT_MODES = ['text/plain'];

/** Failures that mean the cached card may no longer describe the peer. */
const STALE_CARD_CODES: ReadonlySet<A2APeerErrorCode> = new Set([
  'unauthorized',
  'version-not-supported',
  'extension-support-required',
  'content-type-not-supported',
]);

function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function resolveLimits(options: A2APeerClientOptions) {
  return {
    cardCacheMs: requireTimerDelayMs('cardCacheMs', options.cardCacheMs ?? 300_000),
    requestTimeoutMs: requireTimerDelayMs('requestTimeoutMs', options.requestTimeoutMs ?? 30_000),
    taskTimeoutMs: requireTimerDelayMs('taskTimeoutMs', options.taskTimeoutMs ?? 600_000),
    attempts: requireTimerDelayMs('attempts', options.attempts ?? 3),
    baseDelayMs: requireTimerDelayMs('retryBaseDelayMs', options.retryBaseDelayMs ?? 200),
    maxDelayMs: requireTimerDelayMs('retryMaxDelayMs', options.retryMaxDelayMs ?? 5_000),
    pollIntervalMs: requireTimerDelayMs('pollIntervalMs', options.pollIntervalMs ?? 500),
    artifactLimit: requireTimerDelayMs(
      'artifactLimit',
      options.artifactLimit ?? DEFAULT_PEER_ARTIFACT_LIMIT,
    ),
  };
}

interface Loaded {
  readonly card: A2APeerCard;
  readonly client: Client;
  readonly expiresAt: number;
}

/**
 * Creates a client for one A2A peer. It reads and validates the peer's Agent Card (cached for
 * `cardCacheMs`), selects the first interface that speaks A2A 1.0 over JSON-RPC from an allowed
 * origin, sends the `A2A-Version` header through the SDK, and refuses a peer whose card requires
 * an extension this client does not support.
 *
 * The client itself persists nothing: a call lives as long as the caller holds the returned task,
 * and a restart of the caller does not resume it. The remote task keeps running. A caller that
 * kept the task's `taskId` follows it again with `attach`, and one that repeats a send with the
 * same `messageId` gets the task the first send created from a peer that keeps message history.
 */
export function createA2APeerClient(options: A2APeerClientOptions): A2APeerClient {
  const limits = resolveLimits(options);
  const now = options.now ?? Date.now;
  const supported = new Set(options.supportedExtensions ?? []);
  // The card lives under the base path, so the base ends in a slash for relative resolution.
  const baseUrl = options.url.endsWith('/') ? options.url : `${options.url}/`;
  const cardOrigin = originOf(options.url);
  if (cardOrigin === undefined) {
    throw new TypeError(`url must be an absolute URL; received ${options.url}.`);
  }
  const allowedOrigins = new Set([cardOrigin, ...(options.allowedInterfaceOrigins ?? [])]);
  const retryPolicy: PeerRetryPolicy = {
    attempts: limits.attempts,
    baseDelayMs: limits.baseDelayMs,
    maxDelayMs: limits.maxDelayMs,
    sleep: options.sleep ?? timerSleep,
    classify: classifyPeerError,
  };
  const peerFetch = createPeerFetch({
    fetch: options.fetch ?? fetch,
    authenticate: options.authenticate,
    egressPolicy: options.egressPolicy,
    requestTimeoutMs: limits.requestTimeoutMs,
  });

  async function readCard(resolver: DefaultAgentCardResolver): Promise<AgentCard> {
    try {
      return await retryRequest(retryPolicy, () => resolver.resolve(baseUrl));
    } catch (error) {
      const classified = classifyPeerError(error);
      if (classified.code !== 'protocol') throw classified;
      throw new A2APeerError(
        'card-unavailable',
        `The Agent Card could not be read: ${classified.message}`,
        { cause: error },
      );
    }
  }

  async function loadCard(): Promise<Loaded> {
    const resolver = new DefaultAgentCardResolver({ fetchImpl: peerFetch, path: CARD_PATH });
    const raw = ingestCard(await readCard(resolver));
    const { selected, streaming, activeExtensions } = validatePeerCard(
      raw,
      supported,
      allowedOrigins,
    );
    await checkEgress(options.egressPolicy, selected.url);
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: peerFetch })],
        cardResolver: resolver,
        clientConfig: { polling: !streaming, acceptedOutputModes: ACCEPTED_OUTPUT_MODES },
      }),
    );
    return {
      client: await factory.createFromAgentCard({ ...raw, supportedInterfaces: [selected] }),
      expiresAt: now() + limits.cardCacheMs,
      card: {
        name: raw.name,
        version: raw.version,
        description: raw.description,
        cardUrl: new URL(CARD_PATH, baseUrl).href,
        interfaceUrl: selected.url,
        streaming,
        activeExtensions,
      },
    };
  }

  let loaded: Loaded | undefined;
  let loading: Promise<Loaded> | undefined;

  function resolveCard(refresh: boolean): Promise<Loaded> {
    if (!refresh && loaded !== undefined && loaded.expiresAt > now()) {
      return Promise.resolve(loaded);
    }
    loading ??= loadCard()
      .then((value) => (loaded = value))
      .finally(() => {
        loading = undefined;
      });
    return loading;
  }

  /** Loads the card, runs `start` against the peer, and drops a card the peer has outgrown. */
  async function withPeerTask(
    signal: AbortSignal | undefined,
    start: (context: PeerTaskContext) => Promise<A2APeerTask>,
  ): Promise<A2APeerTask> {
    const current = await resolveCard(false);
    const { client, card } = current;
    const invalidate = (error: A2APeerError): void => {
      if (STALE_CARD_CODES.has(error.code) && loaded === current) loaded = undefined;
    };
    try {
      return await start({
        ...limits,
        client,
        streaming: card.streaming,
        peer: { agentName: card.name, agentVersion: card.version, cardUrl: card.cardUrl },
        requestOptions:
          card.activeExtensions.length === 0
            ? {}
            : {
                serviceParameters: ServiceParameters.create(
                  withA2AExtensions(...card.activeExtensions),
                ),
              },
        acceptedOutputModes: ACCEPTED_OUTPUT_MODES,
        sleep: retryPolicy.sleep,
        classify: retryPolicy.classify,
        onFailure: invalidate,
      });
    } catch (error) {
      // The caller's own abort is theirs to read, not a peer failure.
      if (signal?.aborted === true) throw error;
      const classified = classifyPeerError(error);
      // A refusal can mean the peer changed since the card was cached; read the card again.
      invalidate(classified);
      throw classified;
    }
  }

  return {
    async card(request) {
      const { card } = await resolveCard(request?.refresh === true);
      // A detached copy: reading the card must never change what later requests do.
      return Object.freeze({
        ...card,
        activeExtensions: Object.freeze([...card.activeExtensions]),
      });
    },
    async send(input) {
      // The caller owns `input` and may change it while the card loads or authenticates.
      const request = { ...input };
      assertSendRequest(request);
      return withPeerTask(request.signal, (context) => startPeerTask(context, request));
    },
    async attach(input) {
      const request = { ...input };
      assertAttachRequest(request);
      return withPeerTask(request.signal, (context) => attachPeerTask(context, request));
    },
  };
}
