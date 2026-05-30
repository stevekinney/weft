import { describe, expect, it } from 'bun:test';
import type { WorkflowEvent } from '../core/types.ts';
import { dropOverlappingLiveFrames, eventsEqual } from './event-stream-transport.ts';

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
