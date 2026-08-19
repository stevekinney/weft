import { describe, expect, test } from 'bun:test';

import { internalError, invalidParams, methodNotFound, resourceNotFound } from './protocol.ts';

describe('MCP protocol error responses', () => {
  test('builds each public error response with its canonical code and data shape', () => {
    expect(invalidParams(1, 'Invalid cursor', { cursor: 'bad' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid cursor', data: { cursor: 'bad' } },
    });
    expect(methodNotFound('request-2', 'unknown/method')).toEqual({
      jsonrpc: '2.0',
      id: 'request-2',
      error: {
        code: -32601,
        message: 'Unknown MCP method: unknown/method',
        data: { method: 'unknown/method' },
      },
    });
    expect(internalError(3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(resourceNotFound('request-4', 'file:///missing')).toEqual({
      jsonrpc: '2.0',
      id: 'request-4',
      error: {
        code: -32002,
        message: 'Resource not found',
        data: { uri: 'file:///missing' },
      },
    });
  });
});
