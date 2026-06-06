import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { getInternals } from './internals.ts';

describe('second-instance detection wiring', () => {
  it('is off by default: no detector, no interval', () => {
    using storage = new MemoryStorage();
    using engine = new Engine({ storage });
    const internals = getInternals(engine);
    expect(internals.secondInstanceDetector).toBeNull();
    expect(internals.secondInstanceDetectionInterval).toBeNull();
  });

  it('starts the detector and interval when detectSecondInstance is enabled', () => {
    using storage = new MemoryStorage();
    using engine = new Engine({ storage, detectSecondInstance: true });
    const internals = getInternals(engine);
    expect(internals.secondInstanceDetector).not.toBeNull();
    expect(internals.secondInstanceDetectionInterval).not.toBeNull();
  });

  it('writes a heartbeat on a tick and clears it on disposal', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, detectSecondInstance: true });
    const internals = getInternals(engine);

    // Drive one tick directly (the production interval would do this on a timer).
    await internals.secondInstanceDetector!.tick();
    const livenessKeys: string[] = [];
    for await (const [key] of storage.scan(KEYS.livenessPrefix())) {
      livenessKeys.push(key);
    }
    expect(livenessKeys.length).toBe(1);

    engine[Symbol.dispose]();
    expect(internals.secondInstanceDetectionInterval).toBeNull();
    expect(internals.secondInstanceDetector).toBeNull();

    // Disposal fires the best-effort heartbeat delete; let it settle, then confirm.
    await Promise.resolve();
    const remaining: string[] = [];
    for await (const [key] of storage.scan(KEYS.livenessPrefix())) {
      remaining.push(key);
    }
    expect(remaining).toEqual([]);

    storage[Symbol.dispose]();
  });

  it('respects a custom secondInstanceHeartbeatInterval without throwing', () => {
    using storage = new MemoryStorage();
    using engine = new Engine({
      storage,
      detectSecondInstance: true,
      secondInstanceHeartbeatInterval: '30s',
    });
    expect(getInternals(engine).secondInstanceDetector).not.toBeNull();
  });
});
