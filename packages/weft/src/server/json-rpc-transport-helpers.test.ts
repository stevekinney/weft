import { describe, expect, it, spyOn } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import * as handlerModule from './handler.ts';
import * as jsonRpcHttpModule from './json-rpc-http.ts';
import {
  finalizeWebSocketUpgrade,
  handleJsonRpcHttpRequestSafely,
} from './json-rpc-transport-helpers.ts';

describe('json-rpc transport helpers', () => {
  const engine = new Engine({ storage: new MemoryStorage() });

  it('returns undefined when the websocket upgrade succeeds', () => {
    const response = finalizeWebSocketUpgrade(
      {
        upgrade() {
          return true;
        },
      },
      new Request('http://localhost/jsonrpc'),
      { pathname: '/jsonrpc', connectionType: 'jsonrpc' },
    );

    expect(response).toBeUndefined();
  });

  it('returns a 400 response when the websocket upgrade fails', async () => {
    const response = finalizeWebSocketUpgrade(
      {
        upgrade() {
          return false;
        },
      },
      new Request('http://localhost/jsonrpc'),
      { pathname: '/jsonrpc', connectionType: 'jsonrpc' },
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe('WebSocket upgrade failed');
  });

  it('delegates /jsonrpc HTTP requests through the real adapter when principal resolution succeeds', async () => {
    const adapterSpy = spyOn(jsonRpcHttpModule, 'handleJsonRpcHttpRequest').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    try {
      const response = await handleJsonRpcHttpRequestSafely({
        request: new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        registry: {} as never,
        engine,
        authContext: undefined,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
      expect(adapterSpy).toHaveBeenCalledTimes(1);
    } finally {
      adapterSpy.mockRestore();
    }
  });

  it('maps principal-resolution failures to a JSON-RPC internal error response', async () => {
    const principalSpy = spyOn(handlerModule, 'authContextToPrincipal').mockImplementation(() => {
      throw new Error('invalid auth context');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await handleJsonRpcHttpRequestSafely({
        request: new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        registry: {} as never,
        engine,
        authContext: { method: 'jwt' } as never,
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
      expect(errorSpy).toHaveBeenCalledWith('Unhandled error in /jsonrpc', {
        error: expect.any(Error),
      });
    } finally {
      principalSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('maps unexpected adapter throws to a JSON-RPC internal error response', async () => {
    const adapterSpy = spyOn(jsonRpcHttpModule, 'handleJsonRpcHttpRequest').mockImplementation(
      async () => {
        throw new Error('adapter exploded');
      },
    );
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await handleJsonRpcHttpRequestSafely({
        request: new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        registry: {} as never,
        engine,
        authContext: undefined,
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
      expect(errorSpy).toHaveBeenCalledWith('Unhandled error in /jsonrpc', {
        error: expect.any(Error),
      });
    } finally {
      adapterSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
