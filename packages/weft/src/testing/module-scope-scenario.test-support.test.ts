import { describe, expect, it, jest } from 'bun:test';

import { outcomeOf, rethrow, ScenarioHangError } from './module-scope-scenario.test-support.ts';

describe('outcomeOf', () => {
  it('captures nothing when the scenario succeeds', async () => {
    const outcome = await outcomeOf(async () => {
      expect(1).toBe(1);
    });
    expect(() => rethrow(outcome)).not.toThrow();
  });

  it('captures a failed assertion and rethrows it with its original message', async () => {
    const outcome = await outcomeOf(async () => {
      expect(2).toBe(3);
    });
    expect(() => rethrow(outcome)).toThrow('Expected: 3');
  });

  it('substitutes an error when the scenario throws undefined', async () => {
    const outcome = await outcomeOf(() => Promise.reject(undefined));
    expect(() => rethrow(outcome)).toThrow('scenario failed');
  });

  it('reports a scenario that never settles as hung once the guard elapses', async () => {
    const outcome = await outcomeOf(() => new Promise<void>(() => {}), 5);
    expect(outcome).toBeInstanceOf(ScenarioHangError);
    expect(() => rethrow(outcome)).toThrow('scenario did not settle within 5 ms; it is hung');
  });

  it('reports a scenario that hangs under fake timers, and restores real timers for the next', async () => {
    const outcome = await outcomeOf(() => {
      jest.useFakeTimers();
      return new Promise<void>(() => {});
    }, 5);
    expect(outcome).toBeInstanceOf(ScenarioHangError);
    expect(jest.isFakeTimers()).toBe(false);
    expect(await outcomeOf(() => new Promise<void>(() => {}), 5)).toBeInstanceOf(ScenarioHangError);
  });

  it('runs onHang as soon as the guard fires, and only for a hang', async () => {
    const released: string[] = [];
    const hung = await outcomeOf(
      () => new Promise<void>(() => {}),
      5,
      () => void released.push('hung'),
    );
    expect(hung).toBeInstanceOf(ScenarioHangError);
    await outcomeOf(
      async () => undefined,
      5,
      () => void released.push('finished'),
    );
    expect(released).toEqual(['hung']);
  });

  it('still reports the hang when onHang itself throws', async () => {
    const outcome = await outcomeOf(
      () => new Promise<void>(() => {}),
      5,
      () => {
        throw new Error('cleanup failed');
      },
    );
    expect(outcome).toBeInstanceOf(ScenarioHangError);
  });
});
