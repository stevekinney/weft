import type { Engine } from '../core/engine.ts';
import type { AuthContext } from './authentication.ts';
import { authContextToPrincipal } from './handler.ts';
import { handleJsonRpcHttpRequest } from './json-rpc-http.ts';
import type { WebSocketData } from './json-rpc-websocket-runtime.ts';
import type { OperationRegistry } from './operation-catalog.ts';

type WebSocketUpgradeServer = {
  upgrade(request: Request, options: { data: WebSocketData }): boolean;
};

export function finalizeWebSocketUpgrade(
  server: WebSocketUpgradeServer,
  request: Request,
  data: WebSocketData,
): Response | undefined {
  const upgraded = server.upgrade(request, { data });
  if (upgraded) {
    return undefined;
  }

  return new Response('WebSocket upgrade failed', { status: 400 });
}

export async function handleJsonRpcHttpRequestSafely(args: {
  request: Request;
  registry: OperationRegistry;
  engine: Engine;
  authContext: AuthContext | undefined;
  maxBodyBytes?: number;
}): Promise<Response> {
  try {
    return await handleJsonRpcHttpRequest(args.request, {
      registry: args.registry,
      engine: args.engine,
      principal: authContextToPrincipal(args.authContext),
      ...(args.maxBodyBytes !== undefined ? { maxBodyBytes: args.maxBodyBytes } : {}),
    });
  } catch (error) {
    console.error('Unhandled error in /jsonrpc', { error });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
}
