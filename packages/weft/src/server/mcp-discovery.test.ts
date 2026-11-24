import { describe, expect, it } from 'bun:test';

import { VERSION } from '../version.ts';
import { generateMcpDiscovery } from './mcp-discovery.ts';

describe('MCP discovery document', () => {
  it('generates an MCP discovery document with the live Streamable HTTP endpoint', () => {
    const document = generateMcpDiscovery({ origin: 'https://api.example.com' });

    expect(document).toEqual({
      schemaVersion: 2,
      protocol: 'model-context-protocol',
      protocolVersion: '2026-07-28',
      legacyProtocolVersion: '2025-11-25',
      serverInfo: {
        name: 'weft',
        version: VERSION,
      },
      transports: {
        streamableHttp: {
          url: 'https://api.example.com/api/mcp',
          methods: ['POST'],
          protocolVersionHeader: 'Mcp-Protocol-Version',
        },
        stdio: {
          command: 'weft-mcp',
        },
      },
      discovery: {
        openRpc: 'https://api.example.com/openrpc.json',
        tools: {
          method: 'tools/list',
          canonical: true,
        },
        resources: {
          listMethod: 'resources/list',
          templatesMethod: 'resources/templates/list',
        },
      },
    });
  });
});
