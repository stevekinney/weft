import { describe, expect, it } from 'bun:test';
import type { WorkflowEvent } from '../core/types.ts';
import {
  defaultWebSocketFactory,
  dropOverlappingLiveFrames,
  eventsEqual,
  headerCarryingWebSocketFactory,
  parseWatchFrame,
  selectWebSocketFactory,
  type WebSocketFactory,
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

/** Install a recording `WebSocket` global for the duration of `run`. */
function withRecordingWebSocket(run: (constructed: unknown[][]) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const constructed: unknown[][] = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: class {
      constructor(...args: unknown[]) {
        constructed.push(args);
      }
      addEventListener(): void {}
      close(): void {}
    },
  });
  try {
    run(constructed);
  } finally {
    if (descriptor === undefined) {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    } else {
      Object.defineProperty(globalThis, 'WebSocket', descriptor);
    }
  }
}

describe('defaultWebSocketFactory', () => {
  it('throws an actionable error when auth headers are configured (the platform WebSocket cannot send them)', () => {
    // Regression (Copilot follow-up): Node 22+ and browsers have a global WebSocket whose
    // constructor cannot send custom headers. Silently dropping a configured Authorization
    // header would produce an unauthenticated socket; the factory must fail loudly pointing
    // at webSocketFactory and webSocketCarriesHeaders instead.
    withRecordingWebSocket((constructed) => {
      expect(() =>
        defaultWebSocketFactory('ws://test/watch', { Authorization: 'Bearer t' }),
      ).toThrow(
        /cannot send the configured auth headers.*webSocketCarriesHeaders.*webSocketFactory/s,
      );
      expect(constructed).toEqual([]);
    });
  });

  it('constructs with the URL alone when no headers are configured', () => {
    // No credentials to drop — a header-less socket is fine.
    withRecordingWebSocket((constructed) => {
      expect(() => defaultWebSocketFactory('ws://test/watch', {})).not.toThrow();
      expect(constructed).toEqual([['ws://test/watch']]);
    });
  });
});

describe('headerCarryingWebSocketFactory', () => {
  it('passes the headers in the options bag when the caller declared a header-carrying WebSocket', () => {
    withRecordingWebSocket((constructed) => {
      headerCarryingWebSocketFactory('ws://test/watch', { Authorization: 'Bearer t' });
      expect(constructed).toEqual([
        ['ws://test/watch', { headers: { Authorization: 'Bearer t' } }],
      ]);
    });
  });

  it('passes an empty header bag when no headers are configured', () => {
    withRecordingWebSocket((constructed) => {
      headerCarryingWebSocketFactory('ws://test/watch', {});
      expect(constructed).toEqual([['ws://test/watch', { headers: {} }]]);
    });
  });

  it('fails with the no-global-WebSocket error when none exists', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: undefined });
    try {
      expect(() => headerCarryingWebSocketFactory('ws://test/watch', {})).toThrow(
        /No global WebSocket is available/,
      );
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      } else {
        Object.defineProperty(globalThis, 'WebSocket', descriptor);
      }
    }
  });
});

describe('parseWatchFrame', () => {
  it.each([
    ['text that is not JSON', '{ not json'],
    ['a frame that is not a string', 42],
    ['JSON that is not an object', '[1, 2]'],
    ['an object without a string type', '{"type":7}'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseWatchFrame(raw)).toBeNull();
  });

  it('reads the type, timestamp and data, defaulting what is missing', () => {
    expect(parseWatchFrame('{"type":"activity:started","timestamp":5,"data":{"a":1}}')).toEqual({
      type: 'activity:started',
      timestamp: 5,
      data: { a: 1 },
    });
    const bare = parseWatchFrame('{"type":"workflow:started","data":"nope"}');
    expect(bare).toMatchObject({ type: 'workflow:started', data: {} });
    expect(typeof bare?.timestamp).toBe('number');
  });
});

describe('selectWebSocketFactory', () => {
  const custom: WebSocketFactory = () => {
    throw new Error('custom factory');
  };

  it('prefers the caller-supplied factory over the declaration', () => {
    expect(
      selectWebSocketFactory({ webSocketFactory: custom, webSocketCarriesHeaders: true }),
    ).toBe(custom);
  });

  it('uses the header-carrying factory only when the caller declared it', () => {
    expect(selectWebSocketFactory({ webSocketCarriesHeaders: true })).toBe(
      headerCarryingWebSocketFactory,
    );
  });

  it('defaults to the header-less factory, which cannot carry headers', () => {
    expect(selectWebSocketFactory()).toBe(defaultWebSocketFactory);
    expect(selectWebSocketFactory({ webSocketCarriesHeaders: false })).toBe(
      defaultWebSocketFactory,
    );
  });
});
