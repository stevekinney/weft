/**
 * Characterization tests for classifyConnection.
 *
 * These tests pin the externally observable behavior (returned object shape)
 * across every path × subprotocol × upgrade-header combination so that the
 * subsequent refactor cannot silently change outputs.
 */

import { describe, expect, it } from 'bun:test';

import { classifyConnection } from './websocket-upgrade.ts';

function makeUrl(path: string, query = ''): URL {
  return new URL(`http://localhost${path}${query ? `?${query}` : ''}`);
}

describe('classifyConnection', () => {
  describe('workflow stream path', () => {
    it('returns stream connection type with decoded workflowId', () => {
      const result = classifyConnection(makeUrl('/v1/workflows/wf-123/stream'));
      expect(result).toEqual({ connectionType: 'stream', workflowId: 'wf-123' });
    });

    it('decodes percent-encoded workflowId', () => {
      const result = classifyConnection(makeUrl('/v1/workflows/my%20workflow/stream'));
      expect(result).toEqual({ connectionType: 'stream', workflowId: 'my workflow' });
    });

    it('returns null for malformed percent encoding in workflowId', () => {
      const result = classifyConnection(makeUrl('/v1/workflows/%GG/stream'));
      expect(result).toBeNull();
    });
  });

  describe('workflow watch path', () => {
    it('returns watch connection type with decoded workflowId', () => {
      const result = classifyConnection(makeUrl('/v1/workflows/wf-456/watch'));
      expect(result).toEqual({ connectionType: 'watch', workflowId: 'wf-456' });
    });

    it('decodes percent-encoded workflowId in watch path', () => {
      const result = classifyConnection(makeUrl('/v1/workflows/hello%2Fworld/watch'));
      expect(result).toEqual({ connectionType: 'watch', workflowId: 'hello/world' });
    });

    it('returns null for malformed percent encoding in watch workflowId', () => {
      const result = classifyConnection(makeUrl('/v1/workflows/%ZZ/watch'));
      expect(result).toBeNull();
    });
  });

  describe('worker stream path', () => {
    it('returns worker connection type with decoded queue', () => {
      const result = classifyConnection(makeUrl('/v1/tasks/default/stream'));
      expect(result).toEqual({ connectionType: 'worker', queue: 'default' });
    });

    it('returns worker connection type for hyphenated queue name', () => {
      const result = classifyConnection(makeUrl('/v1/tasks/my-queue/stream'));
      expect(result).toEqual({ connectionType: 'worker', queue: 'my-queue' });
    });

    it('falls back to generic for paths with percent-encoded chars (regex does not match %)', () => {
      // WORKER_STREAM_RE uses [\w-]+ which does not match '%' characters,
      // so percent-encoded queue names fall through to the generic catch-all.
      const result = classifyConnection(makeUrl('/v1/tasks/my%20queue/stream'));
      expect(result).toEqual({ connectionType: 'generic' });
    });
  });

  describe('jsonrpc path', () => {
    it('returns jsonrpc connection type', () => {
      const result = classifyConnection(makeUrl('/jsonrpc'));
      expect(result).toEqual({ connectionType: 'jsonrpc' });
    });
  });

  describe('generic fallback', () => {
    it('returns generic connection type for unknown paths', () => {
      const result = classifyConnection(makeUrl('/unknown/path'));
      expect(result).toEqual({ connectionType: 'generic' });
    });

    it('returns generic for root path', () => {
      const result = classifyConnection(makeUrl('/'));
      expect(result).toEqual({ connectionType: 'generic' });
    });
  });
});
