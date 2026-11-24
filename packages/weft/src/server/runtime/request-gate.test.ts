import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';
/**
 * The request gate on a server with no authentication (COR-1466): every
 * request is the local user, but rate limiting still keys by client address.
 */

import { describe, expect, it } from 'bun:test';

import { createRateLimiter, principalFromUnauthenticatedLocal } from "../../embedded/backchannel/src/index.ts";
import { authenticateRequest, gateRequest } from './request-gate.ts';
import { minimalServerContext } from './server-context.test-support.ts';

function serverWithClientAddress(addressByRequest: WeakMap<Request, string>) {
  return {
    requestIP: (request: Request) => {
      const address = addressByRequest.get(request);
      return address === undefined ? null : { address, family: 'IPv4', port: 0 };
    },
  } as unknown as ReturnType<typeof Bun.serve>;
}

describe('authenticateRequest with no authenticator', () => {
  it('attaches the unauthenticated-local context to a non-public request', async () => {
    const outcome = await authenticateRequest(
      minimalServerContext(),
      new Request('http://localhost/v1/workflows'),
    );

    expect(outcome.response).toBeNull();
    expect(outcome.publicBypass).toBe(false);
    expect(outcome.authContext?.method).toBe('unauthenticated-local');
    expect(outcome.authContext?.principal).toBe(
      principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY),
    );
  });

  it('still reports a default public path as a bypass', async () => {
    const outcome = await authenticateRequest(
      minimalServerContext(),
      new Request('http://localhost/v1/health'),
    );

    expect(outcome.publicBypass).toBe(true);
  });
});

describe('gateRequest rate limiting with no authenticator', () => {
  it('keys by client address, not by the shared local subject', async () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    try {
      const context = { ...minimalServerContext(), rateLimiter: limiter };
      const addresses = new WeakMap<Request, string>();
      const server = serverWithClientAddress(addresses);
      const requestFrom = (address: string): Request => {
        const request = new Request('http://localhost/v1/workflows');
        addresses.set(request, address);
        return request;
      };

      const firstClient = await gateRequest(server, context, requestFrom('10.0.0.1'));
      const secondClient = await gateRequest(server, context, requestFrom('10.0.0.2'));
      const firstClientAgain = await gateRequest(server, context, requestFrom('10.0.0.1'));

      expect(firstClient.response).toBeNull();
      // A different client has its own budget; a shared bucket would refuse it.
      expect(secondClient.response).toBeNull();
      expect(firstClientAgain.response?.status).toBe(429);
    } finally {
      limiter.dispose();
    }
  });
});
