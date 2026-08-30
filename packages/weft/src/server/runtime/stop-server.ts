import type { Server } from 'bun';

import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

const SERVER_FORCE_STOP_SETTLE_TIMEOUT_MS = 250;

export async function stopBunServerForShutdown(server: Server<WebSocketData>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopPromise = server.stop(true);
  stopPromise.catch((error: unknown) => {
    console.error('[weft] Bun server stop failed:', error);
  });

  try {
    await Promise.race([
      stopPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SERVER_FORCE_STOP_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
