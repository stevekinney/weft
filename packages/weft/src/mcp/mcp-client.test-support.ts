import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from '@modelcontextprotocol/client';

import type { Principal } from "../embedded/backchannel/src/index.ts";
import { handleMcpHttpRequest, type McpEndpoint } from './http.ts';

/** The official SDK client's protocol negotiation mode. */
export type NegotiationMode = NonNullable<NonNullable<ClientOptions['versionNegotiation']>['mode']>;

/** One HTTP exchange between the SDK client and the endpoint, as seen on the wire. */
export type RecordedExchange = {
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Connect the official SDK client to a Weft MCP endpoint in process: the
 * client's Streamable HTTP transport is pointed at `handleMcpHttpRequest`, so
 * no socket is opened and both protocol eras run through the SDK's real HTTP
 * entry.
 */
export async function connectInProcessClient(
  endpoint: McpEndpoint,
  mode: NegotiationMode,
  options: { readonly principal?: Principal; readonly authRequired?: boolean } = {},
): Promise<{ client: Client; exchanges: RecordedExchange[] }> {
  const exchanges: RecordedExchange[] = [];
  const transport = new StreamableHTTPClientTransport(new URL('http://weft.test/mcp'), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const body = request.method === 'POST' ? await request.clone().text() : '';
      exchanges.push({
        method: readJsonRpcMethod(body),
        headers: Object.fromEntries(request.headers.entries()),
      });
      return handleMcpHttpRequest({
        request,
        endpoint,
        authRequired: options.authRequired ?? false,
        ...(options.principal !== undefined ? { principal: options.principal } : {}),
      });
    },
  });
  const client = new Client(
    { name: 'weft-conformance-client', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return { client, exchanges };
}

/** The SDK client only ever posts JSON-RPC, so a POST body always parses. */
function readJsonRpcMethod(body: string): string | undefined {
  if (!body) return undefined;
  const parsed = JSON.parse(body) as { method?: unknown };
  return typeof parsed.method === 'string' ? parsed.method : undefined;
}

/**
 * Read the JSON-RPC response from an MCP HTTP response, whether the SDK
 * answered with a JSON body or a single-message SSE stream.
 */
export async function readJsonRpcResponse(response: Response): Promise<{
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}> {
  const text = await response.text();
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return JSON.parse(text);
  }
  const messages = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
  const answer = messages.find((message) => 'result' in message || 'error' in message);
  if (answer === undefined) throw new Error(`No JSON-RPC response in stream: ${text}`);
  return answer as Awaited<ReturnType<typeof readJsonRpcResponse>>;
}
