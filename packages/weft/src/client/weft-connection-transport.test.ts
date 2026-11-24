import { describe, expect, it } from 'bun:test';

import { CatalogClientError, type CatalogFetch } from "../embedded/backchannel/src/client/index.ts";
import { httpJsonRpcTransport } from './weft-connection-transport.ts';

type Seen = { url: string; authorization: string | null; signal: AbortSignal | null | undefined };

function answeringFetch(seen: Seen[], answer: unknown): CatalogFetch {
  return async (input, init) => {
    seen.push({
      url: input instanceof Request ? input.url : input.toString(),
      authorization: new Headers(init?.headers).get('authorization'),
      signal: init?.signal,
    });
    return Response.json(answer);
  };
}

describe('httpJsonRpcTransport', () => {
  it('resolves the server and token for each call and posts to its JSON-RPC endpoint', async () => {
    const seen: Seen[] = [];
    const transport = httpJsonRpcTransport({
      server: 'http://localhost:7233/base',
      token: 'secret',
      includeRunLockfile: false,
    });

    const result = await transport(
      'weft.alerts.list',
      {},
      {
        fetch: answeringFetch(seen, { jsonrpc: '2.0', id: 'weft-client', result: { alerts: [] } }),
      },
    );

    expect(result).toEqual({ alerts: [] });
    expect(seen).toEqual([
      {
        url: 'http://localhost:7233/base/jsonrpc',
        authorization: 'Bearer secret',
        signal: undefined,
      },
    ]);
  });

  it('hands a call its own signal to the request', async () => {
    const seen: Seen[] = [];
    const controller = new AbortController();

    await httpJsonRpcTransport({ server: 'http://localhost:7233', includeRunLockfile: false })(
      'weft.alerts.list',
      {},
      {
        signal: controller.signal,
        fetch: answeringFetch(seen, { jsonrpc: '2.0', id: 'weft-client', result: null }),
      },
    );

    expect(seen[0]?.signal).toBe(controller.signal);
    expect(seen[0]?.authorization).toBeNull();
  });

  it('throws a CatalogClientError for a JSON-RPC error', async () => {
    const seen: Seen[] = [];
    const caught = await httpJsonRpcTransport({
      server: 'http://localhost:7233',
      includeRunLockfile: false,
    })(
      'weft.nope',
      {},
      {
        fetch: answeringFetch(seen, {
          jsonrpc: '2.0',
          id: 'weft-client',
          error: { code: -32601, message: 'Method not found' },
        }),
      },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).isUnknownOperation).toBe(true);
  });
});
