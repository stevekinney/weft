import { afterEach, describe, expect, it } from 'bun:test';
import type { WorkflowEvent } from '../core/types.ts';
import { setPortableRuntimeTestOverridesForTesting } from '../runtime/portable.ts';
import {
  defaultWebSocketFactory,
  dropOverlappingLiveFrames,
  eventsEqual,
} from './event-stream-transport.ts';

function event(type: string, data: Record<string, unknown> = {}): WorkflowEvent {
  return { type, timestamp: 1, data };
}

describe('eventsEqual', () => {
  it('matches on type and data regardless of timestamp', () => {
    expect(
      eventsEqual(
        { type: 'a', timestamp: 1, data: { x: 1 } },
        { type: 'a', timestamp: 99, data: { x: 1 } },
      ),
    ).toBe(true);
    expect(eventsEqual(event('a', { x: 1 }), event('a', { x: 2 }))).toBe(false);
    expect(eventsEqual(event('a'), event('b'))).toBe(false);
  });
});

describe('dropOverlappingLiveFrames', () => {
  it('drops frames already covered by history, keeping genuinely new ones', () => {
    const history = [event('workflow:started'), event('activity:started')];
    const buffered = [event('activity:started'), event('signal:received', { name: 'new' })];
    const fresh = dropOverlappingLiveFrames(history, buffered);
    expect(fresh.map((e) => e.type)).toEqual(['signal:received']);
  });

  it('is consuming: a single history entry cancels at most one identical live frame', () => {
    // Two structurally identical live frames where history covers only one — the
    // genuinely new second frame must survive.
    const history = [event('signal:received', { name: 'tick' })];
    const buffered = [
      event('signal:received', { name: 'tick' }),
      event('signal:received', { name: 'tick' }),
    ];
    const fresh = dropOverlappingLiveFrames(history, buffered);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.type).toBe('signal:received');
  });

  it('returns all buffered frames when history is empty', () => {
    const buffered = [event('a'), event('b')];
    expect(dropOverlappingLiveFrames([], buffered).map((e) => e.type)).toEqual(['a', 'b']);
  });

  it('returns an empty array when every buffered frame overlaps history', () => {
    const history = [event('a'), event('b')];
    expect(dropOverlappingLiveFrames(history, [event('a'), event('b')])).toEqual([]);
  });
});

describe('defaultWebSocketFactory runtime behavior', () => {
  const nodeOverrides = {
    bun: undefined,
    window: undefined,
    document: undefined,
    process: { versions: { node: '22.0.0' } } as unknown as typeof globalThis.process,
  };

  afterEach(() => {
    setPortableRuntimeTestOverridesForTesting(undefined);
  });

  it('throws an actionable error on Node when auth headers are configured (headers cannot ride the socket)', () => {
    // Regression (Copilot follow-up): Node 22+ has a global WebSocket but its
    // constructor cannot send custom headers. Silently dropping a configured
    // Authorization header would produce an unauthenticated socket; the factory
    // must fail loudly pointing at webSocketFactory instead.
    setPortableRuntimeTestOverridesForTesting(nodeOverrides);
    expect(() => defaultWebSocketFactory('ws://test/watch', { Authorization: 'Bearer t' })).toThrow(
      /cannot send the configured auth headers.*webSocketFactory/s,
    );
  });

  it('does not throw on Node when no auth headers are configured', () => {
    // No credentials to drop — a header-less socket is fine.
    setPortableRuntimeTestOverridesForTesting(nodeOverrides);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    // Stub a constructible WebSocket so the header-less path can build one.
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: class {
        constructor(public url: string) {}
        addEventListener(): void {}
        close(): void {}
      },
    });
    try {
      expect(() => defaultWebSocketFactory('ws://test/watch', {})).not.toThrow();
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      } else {
        Object.defineProperty(globalThis, 'WebSocket', descriptor);
      }
    }
  });

  it('does not throw on a browser even with headers (cookie/query auth is expected)', () => {
    setPortableRuntimeTestOverridesForTesting({
      bun: undefined,
      process: undefined,
      window: {} as unknown as typeof globalThis.window,
      document: {} as unknown as typeof globalThis.document,
    });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: class {
        constructor(public url: string) {}
        addEventListener(): void {}
        close(): void {}
      },
    });
    try {
      expect(() =>
        defaultWebSocketFactory('ws://test/watch', { Authorization: 'Bearer t' }),
      ).not.toThrow();
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      } else {
        Object.defineProperty(globalThis, 'WebSocket', descriptor);
      }
    }
  });
});
