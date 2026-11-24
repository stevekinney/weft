import { describe, expect, test } from 'bun:test';

import { AgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';

import { canonicalJson } from "../embedded/backchannel/src/internals.ts";
import {
  agentCardFixture,
  CARD_URL,
  createEchoRequestHandler,
  JWKS_URL,
  PUBLIC_URL,
} from './a2a.test-support.ts';
import { type A2AHandlerOptions, createA2AHandler } from './handler.ts';

type JsonWebKeySet = { keys: Array<JsonWebKey & { kid?: string }> };

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

function cardHandler(
  options: Partial<A2AHandlerOptions> = {},
): (request: Request) => Promise<Response> {
  return createA2AHandler({
    requestHandler: createEchoRequestHandler(),
    agentCard: agentCardFixture(),
    publicUrl: PUBLIC_URL,
    authenticate: () => new Response('Unauthorized', { status: 401 }),
    ...options,
  });
}

async function fetchCard(
  handler: (request: Request) => Promise<Response>,
  url = CARD_URL,
): Promise<AgentCard> {
  const response = await handler(new Request(url));
  return AgentCard.fromJSON(await response.json());
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function protectedHeader(card: AgentCard): Record<string, unknown> {
  const encoded = card.signatures[0]?.protected ?? '';
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function signingKey(alg: 'ES256' | 'EdDSA', extractable = true): Promise<CryptoKey> {
  const algorithm = alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'Ed25519' };
  const pair = (await crypto.subtle.generateKey(algorithm, extractable, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return pair.privateKey;
}

describe('createA2AHandler: Agent Card route', () => {
  test('serves the card without credentials, with publicUrl as its only interface URL', async () => {
    const handler = cardHandler();

    const response = await handler(new Request(CARD_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['supportedInterfaces']).toEqual([
      { url: PUBLIC_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
    expect(json['name']).toBe('Echo Agent');
    expect(json['signatures']).toBeUndefined();
  });

  test('publishes the tenant option as the interface tenant', async () => {
    const card = await fetchCard(cardHandler({ tenant: 'acme' }));

    expect(card.supportedInterfaces).toEqual([
      { url: PUBLIC_URL, protocolBinding: 'JSONRPC', tenant: 'acme', protocolVersion: '1.0' },
    ]);
  });

  test('replaces any interfaces on the supplied card', async () => {
    const supplied = agentCardFixture();
    supplied.supportedInterfaces = [
      {
        url: 'https://elsewhere.example/rpc',
        protocolBinding: 'HTTP+JSON',
        tenant: '',
        protocolVersion: '0.3',
      },
    ];

    const card = await fetchCard(cardHandler({ agentCard: supplied }));

    expect(card.supportedInterfaces.map((entry) => entry.url)).toEqual([PUBLIC_URL]);
  });

  test('serves the card under any mount prefix', async () => {
    const handler = cardHandler();

    expect(
      await statusOf(handler(new Request('http://internal/.well-known/agent-card.json'))),
    ).toBe(200);
  });

  test('sends a strong ETag over the card’s RFC 8785 serialization and honors If-None-Match', async () => {
    const handler = cardHandler();
    const response = await handler(new Request(CARD_URL));
    const etag = response.headers.get('etag');
    const json: unknown = await response.json();

    expect(etag).toBe(`"${await sha256Hex(canonicalJson(json))}"`);
    const repeated = await handler(new Request(CARD_URL));
    expect(repeated.headers.get('etag')).toBe(etag);

    for (const ifNoneMatch of [etag ?? '', `"other", W/${etag}`, '*']) {
      const conditional = await handler(
        new Request(CARD_URL, { headers: { 'if-none-match': ifNoneMatch } }),
      );
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get('etag')).toBe(etag);
      expect(conditional.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await conditional.text()).toBe('');
    }

    const stale = await handler(new Request(CARD_URL, { headers: { 'if-none-match': '"stale"' } }));
    expect(stale.status).toBe(200);
  });

  test('sends a Last-Modified header, the same on every response, conditional ones included', async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const handler = cardHandler();
    const response = await handler(new Request(CARD_URL));
    const lastModified = response.headers.get('last-modified');

    expect(lastModified).not.toBeNull();
    const modifiedAt = Date.parse(lastModified ?? '');
    expect(modifiedAt).toBeGreaterThanOrEqual(before);
    expect(modifiedAt).toBeLessThanOrEqual(Date.now());
    const etag = response.headers.get('etag') ?? '';
    const conditional = await handler(
      new Request(CARD_URL, { headers: { 'if-none-match': etag } }),
    );
    expect(conditional.headers.get('last-modified')).toBe(lastModified);
    const repeated = await handler(new Request(CARD_URL));
    expect(repeated.headers.get('last-modified')).toBe(lastModified);
  });

  test('does not serve a JWKS without signing', async () => {
    const handler = cardHandler();

    expect(await statusOf(handler(new Request(JWKS_URL)))).toBe(401);
  });
});

describe('createA2AHandler: Agent Card signing', () => {
  test.each(['ES256', 'EdDSA'] as const)(
    'signs the card with %s and verifies against the served JWKS alone',
    async (alg) => {
      const handler = cardHandler({
        signing: { privateKey: await signingKey(alg), kid: 'card-key-1', alg },
      });

      const card = await fetchCard(handler);

      expect(card.signatures).toHaveLength(1);
      expect(protectedHeader(card)).toEqual({
        alg,
        kid: 'card-key-1',
        typ: 'JOSE',
        jku: `${PUBLIC_URL}/.well-known/jwks.json`,
      });

      const jwksResponse = await handler(new Request(JWKS_URL));
      expect(jwksResponse.status).toBe(200);
      expect(jwksResponse.headers.get('content-type')).toBe('application/jwk-set+json');
      const jwks = (await jwksResponse.json()) as JsonWebKeySet;
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0]).toMatchObject({ kid: 'card-key-1', alg, use: 'sig' });
      const publicMembers = alg === 'ES256' ? ['crv', 'kty', 'x', 'y'] : ['crv', 'kty', 'x'];
      expect(Object.keys(jwks.keys[0] ?? {}).toSorted()).toEqual(
        [...publicMembers, 'alg', 'kid', 'use'].toSorted(),
      );

      const verify = verifyAgentCardSignature(async (kid, jku) => {
        expect(jku).toBe(JWKS_URL);
        const jwksAgain = await handler(new Request(jku ?? ''));
        const fetched = (await jwksAgain.json()) as JsonWebKeySet;
        const key = fetched.keys.find((candidate) => candidate.kid === kid);
        if (key === undefined) throw new Error(`no key ${kid}`);
        return key;
      });
      await verify(card);
    },
  );

  test('bases the jku on discoveryUrl while the interface URL stays publicUrl', async () => {
    const handler = cardHandler({
      discoveryUrl: 'https://discovery.example.com/agents/support/',
      signing: { privateKey: await signingKey('ES256'), kid: 'k', alg: 'ES256' },
    });

    const card = await fetchCard(handler);

    expect(card.supportedInterfaces[0]?.url).toBe(PUBLIC_URL);
    expect(protectedHeader(card)['jku']).toBe(
      'https://discovery.example.com/agents/support/.well-known/jwks.json',
    );
  });

  test.each([
    {
      label: 'an HMAC secret',
      alg: 'ES256' as const,
      key: async () =>
        crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']),
    },
    {
      label: 'an RSA private key',
      alg: 'ES256' as const,
      key: async () => {
        const pair = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
          },
          true,
          ['sign', 'verify'],
        );
        return pair.privateKey;
      },
    },
    {
      label: 'an ECDSA P-384 key',
      alg: 'ES256' as const,
      key: async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
          'sign',
          'verify',
        ]);
        return pair.privateKey;
      },
    },
    { label: 'an Ed25519 key', alg: 'ES256' as const, key: async () => signingKey('EdDSA') },
    { label: 'an ECDSA P-256 key', alg: 'EdDSA' as const, key: async () => signingKey('ES256') },
    {
      label: 'a public key',
      alg: 'ES256' as const,
      key: async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ]);
        return pair.publicKey;
      },
    },
  ])('rejects $label for alg $alg before any JWKS is served', async ({ alg, key }) => {
    const privateKey = await key();

    expect(() => cardHandler({ signing: { privateKey, kid: 'k', alg } })).toThrow(
      `A2A signing.privateKey must be ${alg === 'ES256' ? 'an ECDSA P-256' : 'an Ed25519'} private key for alg '${alg}'.`,
    );
  });

  test('rejects a signing key that cannot be exported', async () => {
    const privateKey = await signingKey('ES256', false);

    expect(() => cardHandler({ signing: { privateKey, kid: 'k', alg: 'ES256' } })).toThrow(
      'A2A signing.privateKey must be extractable',
    );
  });
});
