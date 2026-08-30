import { describe, expect, it } from 'bun:test';

import {
  extractTraceParent,
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  injectTraceParent,
  parseTraceParent,
} from './propagation';

describe('propagation', () => {
  describe('parseTraceParent', () => {
    it('parses a valid traceparent string', () => {
      const result = parseTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

      expect(result).toEqual({
        version: '00',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      });
    });

    it('returns null for an invalid string', () => {
      expect(parseTraceParent('')).toBeNull();
      expect(parseTraceParent('not-a-traceparent')).toBeNull();
      expect(parseTraceParent('00-short-short-01')).toBeNull();
      // Invalid hex characters
      expect(
        parseTraceParent('00-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ-00f067aa0ba902b7-01'),
      ).toBeNull();
      // All zeros trace ID
      expect(
        parseTraceParent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
      ).toBeNull();
      // All zeros span ID
      expect(
        parseTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'),
      ).toBeNull();
    });
  });

  describe('formatTraceParent', () => {
    it('produces a valid W3C traceparent string', () => {
      const result = formatTraceParent({
        version: '00',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      });

      expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    });
  });

  describe('round-trip', () => {
    it('parse then format produces the same string', () => {
      const original = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const parsed = parseTraceParent(original);
      expect(parsed).not.toBeNull();
      const formatted = formatTraceParent(parsed!);
      expect(formatted).toBe(original);
    });
  });

  describe('generateTraceId', () => {
    it('produces a 32-character hex string', () => {
      const traceId = generateTraceId();
      expect(traceId).toHaveLength(32);
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces unique values', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateSpanId', () => {
    it('produces a 16-character hex string', () => {
      const spanId = generateSpanId();
      expect(spanId).toHaveLength(16);
      expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces unique values', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('injectTraceParent', () => {
    it('sets the traceparent header in a map', () => {
      const headers = new Map<string, string>();
      const context = {
        version: '00',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      };

      injectTraceParent(headers, context);

      expect(headers.get('traceparent')).toBe(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      );
    });
  });

  describe('extractTraceParent', () => {
    it('reads a trace context from a headers map', () => {
      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      const result = extractTraceParent(headers);

      expect(result).toEqual({
        version: '00',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      });
    });

    it('returns null when the header is missing', () => {
      const headers = new Map<string, string>();
      expect(extractTraceParent(headers)).toBeNull();
    });
  });
});
