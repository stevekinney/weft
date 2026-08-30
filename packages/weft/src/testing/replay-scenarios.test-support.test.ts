import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { registerScenarioHandlers, scenarioNames } from './replay-scenarios.test-support.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

describe('replay scenario test support', () => {
  it('executes the race-takes-first scenario through the shared registrar', async () => {
    const engine = createEngine();

    try {
      registerScenarioHandlers(engine, 'race-takes-first');
      const handle = await engine.start('race-takes-first', null);
      await expect(handle.result()).resolves.toBe('fast');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('executes the fork-from-checkpoint scenario through the shared registrar', async () => {
    const engine = createEngine();

    try {
      registerScenarioHandlers(engine, 'fork-from-checkpoint');
      const handle = await engine.start('fork-from-checkpoint', null);
      await engine.signal(handle.id, 'branch', 'right');
      await expect(handle.result()).resolves.toBe('phase-one:right');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('exposes a stable sorted scenario list and rejects unknown scenarios', () => {
    const engine = createEngine();

    try {
      expect(scenarioNames).toEqual([...scenarioNames].toSorted());
      expect(() => registerScenarioHandlers(engine, 'missing-scenario')).toThrow(
        'No scenario handler registered for "missing-scenario"',
      );
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
