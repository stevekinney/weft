/**
 * Selector-specific authorization of the two workflow event feeds (COR-1466).
 *
 * `weft.workflows.events` (WebSocket subscription) and `weft.workflows.events.sse`
 * (Server-Sent Events route) keep `access: { kind: 'authenticated' }`, so the
 * static access policy admits any authenticated caller; the real check is the
 * operation's `authorize` hook, which depends on the selector: `events` needs
 * `events:read` and `tokens` needs `streams:read`. These tests go through the
 * real authorization on both transports, for each selector three ways: with its
 * scope, without it, and with only the other selector's scope.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { type AuthorizationScope, principalFromApiKey } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { serve, type WeftServer } from './index.ts';
import { openWebSocket, waitForMessage } from './json-rpc-websocket-client.test-support.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal<string>('release');
});

type Selector = 'events' | 'tokens';

const SCOPE_FOR_SELECTOR: Readonly<Record<Selector, AuthorizationScope>> = {
  events: 'events:read',
  tokens: 'streams:read',
};
const OTHER_SELECTOR: Readonly<Record<Selector, Selector>> = { events: 'tokens', tokens: 'events' };

/** One key per scope set, mapped to a principal holding exactly that set. */
const KEY_SCOPES: Readonly<Record<string, readonly AuthorizationScope[]>> = {
  'key-events-read': ['events:read'],
  'key-streams-read': ['streams:read'],
  'key-neither': ['schedules:read'],
  'key-no-scopes': [],
};

function keyHolding(scope: AuthorizationScope | null): string {
  if (scope === null) return 'key-neither';
  return scope === 'events:read' ? 'key-events-read' : 'key-streams-read';
}

describe('workflow event feeds authorize by selector', () => {
  let server: WeftServer | undefined;
  let engine: Engine | undefined;
  let workflowId = '';

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  async function startServer(): Promise<WeftServer> {
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(holdWorkflow);
    const handle = await engine.start('hold', {}, {});
    workflowId = handle.id;
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      server = serve({
        engine,
        port: 0,
        publicOrigin: 'http://localhost',
        auth: {
          apiKeys: Object.keys(KEY_SCOPES),
          resolveApiKeyPrincipal: async (key) => {
            const scopes = KEY_SCOPES[key];
            return scopes === undefined ? null : principalFromApiKey({ subject: key, scopes });
          },
        },
      });
    } finally {
      warningSpy.mockRestore();
    }
    return server;
  }

  async function sseStatus(running: WeftServer, selector: Selector, key: string): Promise<number> {
    const controller = new AbortController();
    try {
      const response = await fetch(
        `${running.url}/v1/workflows/${workflowId}/events/sse?selector=${selector}`,
        { headers: { 'X-API-Key': key, accept: 'text/event-stream' }, signal: controller.signal },
      );
      return response.status;
    } finally {
      controller.abort();
    }
  }

  async function subscribeOutcome(
    running: WeftServer,
    selector: Selector,
    key: string,
  ): Promise<'subscribed' | 'forbidden'> {
    const ws = await openWebSocket(`${running.url.replace('http://', 'ws://')}/jsonrpc`, key);
    try {
      const reply = waitForMessage(ws, (parsed) => (parsed as { id?: number })?.id === 1);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'weft.workflows.subscribe',
          params: { workflowId, selector },
        }),
      );
      const response = (await reply) as {
        result?: { subscriptionId?: string };
        error?: { data?: { weftCode?: string } };
      };
      if (response.result?.subscriptionId !== undefined) return 'subscribed';
      expect(response.error?.data?.weftCode).toBe('Forbidden');
      return 'forbidden';
    } finally {
      ws.close();
    }
  }

  for (const selector of ['events', 'tokens'] as const) {
    describe(`selector ${selector} (needs ${SCOPE_FOR_SELECTOR[selector]})`, () => {
      it('SSE: served with its scope', async () => {
        const running = await startServer();
        expect(await sseStatus(running, selector, keyHolding(SCOPE_FOR_SELECTOR[selector]))).toBe(
          200,
        );
      });

      it('SSE: forbidden without it', async () => {
        const running = await startServer();
        expect(await sseStatus(running, selector, keyHolding(null))).toBe(403);
        expect(await sseStatus(running, selector, 'key-no-scopes')).toBe(403);
      });

      it('SSE: forbidden with only the other selector scope', async () => {
        const running = await startServer();
        const otherScope = SCOPE_FOR_SELECTOR[OTHER_SELECTOR[selector]];
        expect(await sseStatus(running, selector, keyHolding(otherScope))).toBe(403);
      });

      it('WebSocket: subscribed with its scope', async () => {
        const running = await startServer();
        expect(
          await subscribeOutcome(running, selector, keyHolding(SCOPE_FOR_SELECTOR[selector])),
        ).toBe('subscribed');
      });

      it('WebSocket: forbidden without it', async () => {
        const running = await startServer();
        expect(await subscribeOutcome(running, selector, keyHolding(null))).toBe('forbidden');
        expect(await subscribeOutcome(running, selector, 'key-no-scopes')).toBe('forbidden');
      });

      it('WebSocket: forbidden with only the other selector scope', async () => {
        const running = await startServer();
        const otherScope = SCOPE_FOR_SELECTOR[OTHER_SELECTOR[selector]];
        expect(await subscribeOutcome(running, selector, keyHolding(otherScope))).toBe('forbidden');
      });
    });
  }
});
