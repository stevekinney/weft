/**
 * The public Agent Card and signing-key routes of the A2A kit.
 *
 * The served card is the caller's card with exactly one JSON-RPC interface, whose URL
 * is `publicUrl` and whose `tenant` is the deployment's `tenant` option. With
 * `signing`, the card carries one JWS signature whose `jku` points at the JWKS this
 * module also serves. The card is built and signed once per handler, so its strong
 * `ETag` (a SHA-256 digest of the card's RFC 8785 serialization) is stable and
 * conditional requests can be answered with `304`.
 *
 * @module a2a/agent-card-route
 */

import { AgentCard, generateAgentCardSignature } from '@a2a-js/sdk';

import { canonicalJson } from "../embedded/backchannel/src/internals.ts";

/** The Agent Card fields a caller supplies; the kit owns the interface list and signatures. */
export type A2AAgentCardInput = Omit<AgentCard, 'supportedInterfaces' | 'signatures'>;

/**
 * The key the kit signs the Agent Card with. The JWKS route publishes its public half,
 * which WebCrypto can only derive from an extractable key, so `privateKey` must be
 * created with `extractable: true`. It must also be the private key `alg` names: an
 * ECDSA P-256 key for `ES256`, an Ed25519 key for `EdDSA`.
 */
export type A2ASigningOptions = {
  readonly privateKey: CryptoKey;
  readonly kid: string;
  readonly alg: 'ES256' | 'EdDSA';
};

export type AgentCardRouteOptions = {
  readonly agentCard: A2AAgentCardInput;
  readonly publicUrl: string;
  readonly discoveryUrl: string;
  readonly tenant: string | undefined;
  readonly signing: A2ASigningOptions | undefined;
};

export type AgentCardRoutes = {
  /** `GET /.well-known/agent-card.json`. */
  readonly serveAgentCard: (request: Request) => Promise<Response>;
  /** `GET /.well-known/jwks.json`, present only when the card is signed. */
  readonly serveJwks: (() => Promise<Response>) | undefined;
};

export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const JWKS_PATH = '/.well-known/jwks.json';
const DISCOVERY_CACHE_CONTROL = 'public, max-age=300';
const textEncoder = new TextEncoder();

type ServedCard = { readonly body: string; readonly etag: string; readonly lastModified: string };

async function strongEntityTag(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(canonicalJson(value)));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `"${hex.join('')}"`;
}

/** RFC 9110 §13.1.2: `If-None-Match` uses the weak comparison function. */
function matchesEntityTag(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate.replace(/^W\//, '') === etag);
}

/** The base of the discovery URLs, without a trailing slash. */
export function discoveryBase(discoveryUrl: string): string {
  return discoveryUrl.replace(/\/+$/, '');
}

async function buildServedCard(options: AgentCardRouteOptions): Promise<ServedCard> {
  const unsigned: AgentCard = {
    ...options.agentCard,
    supportedInterfaces: [
      {
        url: options.publicUrl,
        protocolBinding: 'JSONRPC',
        tenant: options.tenant ?? '',
        protocolVersion: '1.0',
      },
    ],
    signatures: [],
  };
  const card =
    options.signing === undefined
      ? unsigned
      : await generateAgentCardSignature(options.signing.privateKey, {
          alg: options.signing.alg,
          kid: options.signing.kid,
          typ: 'JOSE',
          jku: `${discoveryBase(options.discoveryUrl)}${JWKS_PATH}`,
        })(unsigned);
  const json = AgentCard.toJSON(card);
  return {
    body: JSON.stringify(json),
    etag: await strongEntityTag(json),
    // The card never changes after the handler builds it, so it was last modified then.
    lastModified: new Date().toUTCString(),
  };
}

/**
 * Publish only the public members of the signing key. The key is checked against `alg`
 * at construction, so it is an EC (`kty`, `crv`, `x`, `y`) or OKP (`kty`, `crv`, `x`)
 * key, and nothing else from the export reaches the JWKS.
 */
async function publicJsonWebKeySet(signing: A2ASigningOptions): Promise<string> {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', signing.privateKey);
  return JSON.stringify({
    keys: [
      {
        kty,
        crv,
        x,
        ...(y === undefined ? {} : { y }),
        kid: signing.kid,
        alg: signing.alg,
        use: 'sig',
      },
    ],
  });
}

function signingKeyMatchesAlgorithm(privateKey: CryptoKey, alg: A2ASigningOptions['alg']): boolean {
  if (privateKey.type !== 'private') return false;
  const algorithm = privateKey.algorithm as KeyAlgorithm & { readonly namedCurve?: string };
  return alg === 'ES256'
    ? algorithm.name === 'ECDSA' && algorithm.namedCurve === 'P-256'
    : algorithm.name === 'Ed25519';
}

function assertSigningKey(signing: A2ASigningOptions): void {
  if (!signing.privateKey.extractable) {
    throw new TypeError(
      'A2A signing.privateKey must be extractable: the JWKS route publishes its public key.',
    );
  }
  if (!signingKeyMatchesAlgorithm(signing.privateKey, signing.alg)) {
    const expected = signing.alg === 'ES256' ? 'an ECDSA P-256' : 'an Ed25519';
    throw new TypeError(
      `A2A signing.privateKey must be ${expected} private key for alg '${signing.alg}'.`,
    );
  }
}

/** Build the discovery routes for one handler. */
export function createAgentCardRoutes(options: AgentCardRouteOptions): AgentCardRoutes {
  const signing = options.signing;
  if (signing !== undefined) assertSigningKey(signing);

  let servedCard: Promise<ServedCard> | undefined;
  let jsonWebKeySet: Promise<string> | undefined;

  async function serveAgentCard(request: Request): Promise<Response> {
    servedCard ??= buildServedCard(options);
    const { body, etag, lastModified } = await servedCard;
    const headers = new Headers({
      etag,
      'last-modified': lastModified,
      'cache-control': DISCOVERY_CACHE_CONTROL,
    });
    if (matchesEntityTag(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set('content-type', 'application/json');
    return new Response(body, { status: 200, headers });
  }

  return {
    serveAgentCard,
    serveJwks:
      signing === undefined
        ? undefined
        : async () => {
            jsonWebKeySet ??= publicJsonWebKeySet(signing);
            return new Response(await jsonWebKeySet, {
              status: 200,
              headers: {
                'content-type': 'application/jwk-set+json',
                'cache-control': DISCOVERY_CACHE_CONTROL,
              },
            });
          },
  };
}
