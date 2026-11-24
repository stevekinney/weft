import { describe, expect, it, jest, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { advanceTimersByTime, useFakeTimers } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { Engine } from '../engine.ts';
import { PayloadSizeExceededError } from '../payload-size.ts';
import { workflow } from '../types.ts';
import { EngineDisposedError } from './errors.ts';
import { getInternals } from './internals.ts';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);

const echo = workflow({ name: 'echo' }).execute(async function* (_ctx, input: string) {
  return input;
});

/** An engine whose poller and retention sweep are both armed under the fake clock. */
function createArmedEngine(): Engine {
  useFakeTimers(START);
  const engine = new Engine({
    storage: new MemoryStorage(),
    schedulerPollIntervalMs: 1_000,
    retention: { completed: '1h' },
    retentionSweepInterval: '10s',
  });
  engine.scheduler.start();
  return engine;
}

describe('Engine.reconfigure', () => {
  describe('a valid patch with neither interval key', () => {
    it('returns the applied values, updates the options, and touches no timer', () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const sweepHandle = internals.retentionSweepInterval;
      const timersBefore = jest.getTimerCount();

      const result = engine.reconfigure({
        retention: { completed: '2h' },
        retentionSweepBatchSize: 7.9,
        history: { maxEvents: 500 },
        payloadSize: { maxBytes: 4_096 },
        checkpointSizeWarningThreshold: 1_024,
      });

      expect(result).toEqual({
        outcome: 'applied',
        applied: {
          retention: { completed: '2h' },
          retentionSweepBatchSize: 7,
          history: { maxEvents: 500 },
          payloadSize: { maxBytes: 4_096 },
          checkpointSizeWarningThreshold: 1_024,
        },
      });
      expect(internals.options.retention).toEqual({ completed: 7_200_000 });
      expect(internals.options.retentionSweepBatchSize).toBe(7);
      expect(internals.options.historyPolicy).toEqual({ maxEvents: 500, retentionWindow: null });
      expect(internals.options.payloadSizePolicy).toEqual({ maxBytes: 4_096 });
      expect(internals.options.checkpointSizeWarningThreshold).toBe(1_024);
      expect(internals.retentionSweepInterval).toBe(sweepHandle);
      expect(jest.getTimerCount()).toBe(timersBefore);
      engine[Symbol.dispose]();
    });

    it('applies an empty patch as a no-op', () => {
      const engine = createArmedEngine();
      const before = { ...getInternals(engine).options };

      expect(engine.reconfigure({})).toEqual({ outcome: 'applied', applied: {} });
      expect(getInternals(engine).options).toEqual(before);
      engine[Symbol.dispose]();
    });

    it('treats a key whose value is undefined as absent', () => {
      const engine = createArmedEngine();
      const before = { ...getInternals(engine).options };

      const result = engine.reconfigure({ retentionSweepBatchSize: undefined } as never);

      expect(result).toEqual({ outcome: 'applied', applied: {} });
      expect(getInternals(engine).options).toEqual(before);
      engine[Symbol.dispose]();
    });
  });

  describe('an invalid patch', () => {
    it.each([
      ['retention', { retention: { completed: 'not-a-duration' } }, 'options.retention'],
      ['retentionSweepInterval', { retentionSweepInterval: 'soon' }, 'retentionSweepInterval'],
      [
        'retentionSweepBatchSize',
        { retentionSweepBatchSize: Number.NaN },
        'options.retentionSweepBatchSize must be a finite number',
      ],
      [
        'checkpointSizeWarningThreshold',
        { checkpointSizeWarningThreshold: 'large' },
        'options.checkpointSizeWarningThreshold must be a finite number',
      ],
      ['history', { history: { maxEvents: 1.5 } }, 'options.history.maxEvents'],
      ['payloadSize', { payloadSize: { maxBytes: -1 } }, 'options.payloadSize.maxBytes'],
      [
        'schedulerPollIntervalMs',
        { schedulerPollIntervalMs: 0 },
        'options.schedulerPollIntervalMs',
      ],
    ])('applies nothing and names %s when it is the invalid key', (key, invalid, fragment) => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const optionsBefore = { ...internals.options };
      const sweepHandle = internals.retentionSweepInterval;
      const timersBefore = jest.getTimerCount();

      // A valid key beside the invalid one must not be applied either.
      const result = engine.reconfigure({
        retentionSweepBatchSize: 99,
        payloadSize: { maxBytes: 12 },
        ...invalid,
      } as never);

      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') throw new Error('unreachable');
      expect(result.keys).toEqual([key]);
      expect(result.message).toContain(fragment);
      expect(internals.options).toEqual(optionsBefore);
      expect(internals.retentionSweepInterval).toBe(sweepHandle);
      expect(jest.getTimerCount()).toBe(timersBefore);
      engine[Symbol.dispose]();
    });

    it('rejects a key outside the patch surface and applies nothing', () => {
      const engine = createArmedEngine();
      const optionsBefore = { ...getInternals(engine).options };

      const result = engine.reconfigure({
        maxNestingDepth: 3,
        retentionSweepBatchSize: 5,
      } as never);

      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') throw new Error('unreachable');
      expect(result.keys).toEqual(['maxNestingDepth']);
      expect(getInternals(engine).options).toEqual(optionsBefore);
      engine[Symbol.dispose]();
    });

    it.each([[null], ['patch'], [7], [[]]])(
      'rejects a patch that is not an object (%p)',
      (patch) => {
        const engine = createArmedEngine();

        const result = engine.reconfigure(patch as never);

        expect(result.outcome).toBe('rejected');
        engine[Symbol.dispose]();
      },
    );
  });

  describe('schedulerPollIntervalMs', () => {
    it('clears the old poll timer and polls next at the new interval', async () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const tick = spyOn(engine.scheduler, 'tick').mockResolvedValue(undefined);
      const timersBefore = jest.getTimerCount();

      await advanceTimersByTime(400);
      const result = engine.reconfigure({ schedulerPollIntervalMs: 50 });

      expect(result).toEqual({ outcome: 'applied', applied: { schedulerPollIntervalMs: 50 } });
      expect(internals.options.schedulerPollIntervalMs).toBe(50);
      expect(jest.getTimerCount()).toBe(timersBefore);
      expect(tick).not.toHaveBeenCalled();

      // The re-armed interval starts at the reconfigure, so a second at the new
      // period yields exactly 1_000 / 50 polls; a surviving old timer adds one.
      await advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(20);
      engine[Symbol.dispose]();
    });

    it('does not re-arm when the interval is unchanged', async () => {
      const engine = createArmedEngine();
      const tick = spyOn(engine.scheduler, 'tick').mockResolvedValue(undefined);

      await advanceTimersByTime(600);
      engine.reconfigure({ schedulerPollIntervalMs: 1_000 });
      // The original phase survives: the first poll lands 1_000 ms after start,
      // 400 ms from now, not 1_000 ms from the reconfigure.
      await advanceTimersByTime(400);

      expect(tick).toHaveBeenCalledTimes(1);
      engine[Symbol.dispose]();
    });

    it('arms no timer on a scheduler that was never started, and the later start uses the new interval', async () => {
      useFakeTimers(START);
      const engine = new Engine({ storage: new MemoryStorage(), schedulerPollIntervalMs: 1_000 });
      const timersBefore = jest.getTimerCount();
      const tick = spyOn(engine.scheduler, 'tick').mockResolvedValue(undefined);

      engine.reconfigure({ schedulerPollIntervalMs: 100 });
      expect(jest.getTimerCount()).toBe(timersBefore);

      engine.scheduler.start();
      await advanceTimersByTime(300);
      expect(tick).toHaveBeenCalledTimes(3);
      engine[Symbol.dispose]();
    });

    it('arms no timer on a scheduler that was stopped', async () => {
      const engine = createArmedEngine();
      await engine.scheduler.stop();
      const timersBefore = jest.getTimerCount();

      engine.reconfigure({ schedulerPollIntervalMs: 100 });

      expect(jest.getTimerCount()).toBe(timersBefore);
      engine[Symbol.dispose]();
    });
  });

  describe('retentionSweepInterval', () => {
    it('clears the old sweep timer and sweeps next at the new interval', async () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const oldHandle = internals.retentionSweepInterval;
      const timersBefore = jest.getTimerCount();
      expect(oldHandle).not.toBeNull();
      expect(internals.nextRetentionSweepAt).toBe(START + 10_000);

      await advanceTimersByTime(4_000);
      const result = engine.reconfigure({ retentionSweepInterval: '2s' });

      expect(result).toEqual({ outcome: 'applied', applied: { retentionSweepInterval: 2_000 } });
      expect(internals.options.retentionSweepIntervalMs).toBe(2_000);
      expect(internals.retentionSweepInterval).not.toBeNull();
      expect(internals.retentionSweepInterval).not.toBe(oldHandle);
      expect(internals.nextRetentionSweepAt).toBe(START + 4_000 + 2_000);
      expect(jest.getTimerCount()).toBe(timersBefore);

      // The old interval would have fired at START + 10_000; the new one fires first.
      await advanceTimersByTime(2_000);
      expect(internals.nextRetentionSweepAt).toBe(START + 6_000 + 2_000);
      engine[Symbol.dispose]();
    });

    it('does not re-arm when the interval is unchanged', () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const handle = internals.retentionSweepInterval;

      engine.reconfigure({ retentionSweepInterval: '10s' });

      expect(internals.retentionSweepInterval).toBe(handle);
      engine[Symbol.dispose]();
    });

    it('arms no sweep when no retention is configured', () => {
      useFakeTimers(START);
      const engine = new Engine({ storage: new MemoryStorage() });
      const internals = getInternals(engine);
      expect(internals.retentionSweepInterval).toBeNull();
      const timersBefore = jest.getTimerCount();

      engine.reconfigure({ retentionSweepInterval: '2s' });

      expect(internals.options.retentionSweepIntervalMs).toBe(2_000);
      expect(internals.retentionSweepInterval).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
      engine[Symbol.dispose]();
    });

    it('does not arm a sweep for a patch that carries neither retention nor the interval', () => {
      useFakeTimers(START);
      const unarmed = new Engine({ storage: new MemoryStorage() });
      unarmed.register(
        workflow({ name: 'retained', retention: { completed: '1h' } }).execute(async function* () {
          return 'done';
        }),
      );
      const internals = getInternals(unarmed);
      internals.retentionSweepInterval = null;
      const timersBefore = jest.getTimerCount();

      unarmed.reconfigure({ payloadSize: { maxBytes: 1_024 } });

      expect(internals.retentionSweepInterval).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
      unarmed[Symbol.dispose]();
    });

    it('arms no timers under manual background tasks', () => {
      useFakeTimers(START);
      const engine = new Engine({
        storage: new MemoryStorage(),
        backgroundTasks: 'manual',
        retention: { completed: '1h' },
      });
      const internals = getInternals(engine);
      const timersBefore = jest.getTimerCount();

      engine.reconfigure({ retentionSweepInterval: '2s', schedulerPollIntervalMs: 50 });

      expect(internals.retentionSweepInterval).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
      engine[Symbol.dispose]();
    });
  });

  describe('retention', () => {
    it('arms a sweep at the current interval when retention becomes configured', async () => {
      useFakeTimers(START);
      const engine = new Engine({ storage: new MemoryStorage(), retentionSweepInterval: '10s' });
      const internals = getInternals(engine);
      expect(internals.retentionSweepInterval).toBeNull();
      const timersBefore = jest.getTimerCount();

      const result = engine.reconfigure({ retention: { completed: '1h' } });

      expect(result.outcome).toBe('applied');
      expect(internals.retentionSweepInterval).not.toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore + 1);
      expect(internals.nextRetentionSweepAt).toBe(START + 10_000);
      await advanceTimersByTime(10_000);
      expect(internals.nextRetentionSweepAt).toBe(START + 20_000);
      engine[Symbol.dispose]();
    });

    it('arms the sweep at the patched interval when the patch carries both keys', async () => {
      useFakeTimers(START);
      const engine = new Engine({ storage: new MemoryStorage(), retentionSweepInterval: '10s' });
      const internals = getInternals(engine);

      engine.reconfigure({ retention: { completed: '1h' }, retentionSweepInterval: '2s' });

      expect(internals.nextRetentionSweepAt).toBe(START + 2_000);
      await advanceTimersByTime(2_000);
      expect(internals.nextRetentionSweepAt).toBe(START + 4_000);
      engine[Symbol.dispose]();
    });

    it('clears the sweep and stops sweeping when retention is no longer configured', async () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const timersBefore = jest.getTimerCount();

      const result = engine.reconfigure({ retention: {} });

      expect(result.outcome).toBe('applied');
      expect(internals.options.retention).toBeNull();
      expect(internals.retentionSweepInterval).toBeNull();
      expect(internals.nextRetentionSweepAt).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore - 1);
      await advanceTimersByTime(30_000);
      expect(internals.nextRetentionSweepAt).toBeNull();
      engine[Symbol.dispose]();
    });

    it('keeps a running sweep timer, and its phase, when only the policy changes', async () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      const handle = internals.retentionSweepInterval;

      await advanceTimersByTime(4_000);
      engine.reconfigure({ retention: { completed: '2h' } });

      expect(internals.retentionSweepInterval).toBe(handle);
      expect(internals.nextRetentionSweepAt).toBe(START + 10_000);
      await advanceTimersByTime(6_000);
      expect(internals.nextRetentionSweepAt).toBe(START + 20_000);
      engine[Symbol.dispose]();
    });

    it('arms no sweep under manual background tasks', () => {
      useFakeTimers(START);
      const engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
      const timersBefore = jest.getTimerCount();

      engine.reconfigure({ retention: { completed: '1h' } });

      expect(getInternals(engine).retentionSweepInterval).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
      engine[Symbol.dispose]();
    });

    it('arms no sweep on a disposed engine', () => {
      useFakeTimers(START);
      const engine = new Engine({ storage: new MemoryStorage() });
      engine[Symbol.dispose]();
      const timersBefore = jest.getTimerCount();

      expect(() => engine.reconfigure({ retention: { completed: '1h' } })).toThrow(
        EngineDisposedError,
      );

      expect(getInternals(engine).retentionSweepInterval).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
    });
  });

  describe('payloadSize', () => {
    it('enforces a changed limit on the next write', async () => {
      const engine = new Engine({ storage: new MemoryStorage() });
      engine.register(echo);
      const oversized = 'x'.repeat(2_048);

      const firstHandle = await engine.start('echo', oversized, { id: 'before' });
      await firstHandle.result();
      expect(engine.reconfigure({ payloadSize: { maxBytes: 256 } }).outcome).toBe('applied');

      let rejection: unknown;
      try {
        await engine.start('echo', oversized, { id: 'after' });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(PayloadSizeExceededError);
      engine[Symbol.dispose]();
    });
  });

  describe('after disposal', () => {
    it('throws EngineDisposedError, applies nothing, and arms no timer', async () => {
      const engine = createArmedEngine();
      const internals = getInternals(engine);
      engine[Symbol.dispose]();
      const optionsBefore = { ...internals.options };
      const timersBefore = jest.getTimerCount();

      expect(() => engine.reconfigure({ retentionSweepInterval: '2s' })).toThrow(
        EngineDisposedError,
      );
      expect(() => engine.reconfigure({ schedulerPollIntervalMs: 50 })).toThrow(
        EngineDisposedError,
      );
      expect(() => engine.reconfigure({ payloadSize: { maxBytes: 1 } })).toThrow(
        EngineDisposedError,
      );

      expect(internals.options).toEqual(optionsBefore);
      expect(internals.retentionSweepInterval).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
      await advanceTimersByTime(60_000);
      expect(jest.getTimerCount()).toBe(timersBefore);
    });
  });
});
