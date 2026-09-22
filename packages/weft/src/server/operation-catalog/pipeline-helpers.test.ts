/**
 * COR-1283: `transportToPolicyKey` maps a transport kind to its
 * `UnknownKeyPolicy` bucket — `'http-rest'` uses the dedicated `http` key,
 * every JSON-RPC transport (HTTP, WebSocket, stdio) shares the single
 * `jsonRpc` key.
 */
import { describe, expect, it } from 'bun:test';

import { transportToPolicyKey } from './pipeline-helpers.ts';

describe('transportToPolicyKey', () => {
  it('maps http-rest to the dedicated http policy key', () => {
    expect(transportToPolicyKey('http-rest')).toBe('http');
  });

  it('maps every JSON-RPC transport to the shared jsonRpc policy key', () => {
    expect(transportToPolicyKey('jsonRpcHttp')).toBe('jsonRpc');
    expect(transportToPolicyKey('jsonRpcWebSocket')).toBe('jsonRpc');
    expect(transportToPolicyKey('jsonRpcStdio')).toBe('jsonRpc');
  });
});
