/**
 * The execution attempt registry: one entry per workflow id for the generation this engine
 * holds, and the only structure that says whether that generation was lost to another engine.
 * These tests drive the registry directly; `generation-lifecycle-matrix.test.ts` crosses it
 * with the states a run can be in and the events that reach it.
 */
import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import type { Checkpoint } from '../types.ts';
import {
  adoptLaunchCheckpoint,
  releaseAllCheckpoints,
  releaseLaunchCheckpoint,
  releaseSuspendedCheckpoint,
} from './checkpoint-commit-snapshots.ts';
import { parkedOnSignal } from './checkpoint-conflict.test-support.ts';
import {
  abandonedExecutionAttemptCount,
  abandonExecutionAttempt,
  beginExecutionAttempt,
  currentExecutionAttempt,
  isGenerationAbandoned,
  isHeldGenerationAbandoned,
  retireAllExecutionAttempts,
  retireExecutionAttempt,
} from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

const generation = (token: string | undefined) => ({ workflowExecutionToken: token }) as Checkpoint;

describe('the execution attempt registry', () => {
  it('holds one attempt per workflow id, and every launch replaces it', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    expect(currentExecutionAttempt(internals, 'run')).toBeUndefined();

    beginExecutionAttempt(internals, 'run', 'generation-1');
    const first = currentExecutionAttempt(internals, 'run');
    expect(first).toEqual({ workflowExecutionToken: 'generation-1', abandoned: false });

    // The same generation launched again is a different attempt, and the earlier one is gone.
    beginExecutionAttempt(internals, 'run', 'generation-1');
    const second = currentExecutionAttempt(internals, 'run');
    expect(second).not.toBe(first);
    expect(currentExecutionAttempt(internals, 'other-run')).toBeUndefined();
  });

  it('abandons only the attempt that launched the named generation, and only once', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    expect(abandonExecutionAttempt(internals, 'run', 'generation-1')).toBe(false);

    beginExecutionAttempt(internals, 'run', 'generation-1');
    const attempt = currentExecutionAttempt(internals, 'run');
    expect(abandonExecutionAttempt(internals, 'run', 'generation-2')).toBe(false);
    expect(abandonExecutionAttempt(internals, 'run', undefined)).toBe(false);
    expect(attempt?.abandoned).toBe(false);

    expect(abandonExecutionAttempt(internals, 'run', 'generation-1')).toBe(true);
    expect(abandonExecutionAttempt(internals, 'run', 'generation-1')).toBe(false);
    expect(attempt?.abandoned).toBe(true);
    expect(isHeldGenerationAbandoned(internals, 'run')).toBe(true);
    expect(isGenerationAbandoned(internals, 'run', 'generation-1')).toBe(true);
    expect(isGenerationAbandoned(internals, 'run', 'generation-2')).toBe(false);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
  });

  it('ends an abandonment with the attempt it belongs to', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    beginExecutionAttempt(internals, 'run', 'generation-1');
    const abandoned = currentExecutionAttempt(internals, 'run');
    abandonExecutionAttempt(internals, 'run', 'generation-1');

    // A relaunch of the abandoned generation, and a replacement generation, are new attempts.
    beginExecutionAttempt(internals, 'run', 'generation-1');
    expect(isHeldGenerationAbandoned(internals, 'run')).toBe(false);
    abandonExecutionAttempt(internals, 'run', 'generation-1');
    beginExecutionAttempt(internals, 'run', 'generation-2');
    expect(isHeldGenerationAbandoned(internals, 'run')).toBe(false);
    expect(isGenerationAbandoned(internals, 'run', 'generation-1')).toBe(false);

    // The attempt a piece of in-flight work captured keeps saying what it said.
    expect(abandoned?.abandoned).toBe(true);
    expect(currentExecutionAttempt(internals, 'run')).not.toBe(abandoned);

    abandonExecutionAttempt(internals, 'run', 'generation-2');
    retireExecutionAttempt(internals, 'run');
    expect(currentExecutionAttempt(internals, 'run')).toBeUndefined();
    expect(isHeldGenerationAbandoned(internals, 'run')).toBe(false);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });

  it('abandons a generation whose checkpoint a suspension released, and a pre-token one', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'suspended-run', generation('generation-1'));
    adoptLaunchCheckpoint(internals, 'legacy-run', generation(undefined));
    releaseSuspendedCheckpoint(internals, 'suspended-run', 'generation-1');
    releaseSuspendedCheckpoint(internals, 'legacy-run', undefined);
    expect(internals.checkpoints.has('suspended-run')).toBe(false);

    // Without the checkpoint, the attempt is all that says which generation the engine holds.
    expect(abandonExecutionAttempt(internals, 'suspended-run', 'generation-1')).toBe(true);
    expect(isHeldGenerationAbandoned(internals, 'suspended-run')).toBe(true);
    expect(abandonExecutionAttempt(internals, 'legacy-run', undefined)).toBe(true);
    expect(isGenerationAbandoned(internals, 'legacy-run', undefined)).toBe(true);
    expect(isGenerationAbandoned(internals, 'legacy-run', 'generation-1')).toBe(false);
  });

  it('retires, instead of keeping, an attempt that launched a different generation than the one suspended', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'replaced-run', generation('generation-1'));
    adoptLaunchCheckpoint(internals, 'replaced-legacy', generation(undefined));
    adoptLaunchCheckpoint(internals, 'replaced-by-legacy', generation('generation-1'));
    adoptLaunchCheckpoint(internals, 'same-generation', generation('generation-1'));

    // Another engine replaced the stored generation, so the run being suspended is not the
    // one this engine launched. A pre-token run and a token-bearing one are different too.
    releaseSuspendedCheckpoint(internals, 'replaced-run', 'generation-2');
    releaseSuspendedCheckpoint(internals, 'replaced-legacy', 'generation-1');
    releaseSuspendedCheckpoint(internals, 'replaced-by-legacy', undefined);
    releaseSuspendedCheckpoint(internals, 'same-generation', 'generation-1');

    for (const id of ['replaced-run', 'replaced-legacy', 'replaced-by-legacy']) {
      expect(internals.checkpoints.has(id)).toBe(false);
      expect(currentExecutionAttempt(internals, id)).toBeUndefined();
    }
    expect(internals.checkpoints.has('same-generation')).toBe(false);
    expect(currentExecutionAttempt(internals, 'same-generation')).toBeDefined();
    // A workflow this engine holds nothing for has nothing to retire.
    expect(() =>
      releaseSuspendedCheckpoint(internals, 'unknown-run', 'generation-1'),
    ).not.toThrow();
  });

  it('retires an attempt with its checkpoint, and every attempt on disposal', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'finished', generation('generation-1'));
    adoptLaunchCheckpoint(internals, 'live', generation('generation-2'));
    abandonExecutionAttempt(internals, 'finished', 'generation-1');

    releaseLaunchCheckpoint(internals, 'finished');
    expect(internals.checkpoints.has('finished')).toBe(false);
    expect(currentExecutionAttempt(internals, 'finished')).toBeUndefined();
    expect(currentExecutionAttempt(internals, 'live')).toBeDefined();
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);

    abandonExecutionAttempt(internals, 'live', 'generation-2');
    releaseAllCheckpoints(internals);
    expect(internals.checkpoints.size).toBe(0);
    expect(currentExecutionAttempt(internals, 'live')).toBeUndefined();
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);

    adoptLaunchCheckpoint(internals, 'live', generation('generation-2'));
    await engine[Symbol.asyncDispose]();
    expect(currentExecutionAttempt(internals, 'live')).toBeUndefined();
  });

  it('records nothing for a disposed engine, so a late loss finds nothing to abandon', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    await engine[Symbol.asyncDispose]();

    beginExecutionAttempt(internals, 'late-run', 'generation-1');
    adoptLaunchCheckpoint(internals, 'late-run', generation('generation-1'));

    expect(currentExecutionAttempt(internals, 'late-run')).toBeUndefined();
    expect(internals.checkpoints.has('late-run')).toBe(false);
    expect(abandonExecutionAttempt(internals, 'late-run', 'generation-1')).toBe(false);
    retireAllExecutionAttempts(internals);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });

  it('installs nothing for a resume that was still in flight when the engine was disposed', async () => {
    const id = 'resume-after-disposal';
    const storage = new MemoryStorage();
    const first = await Engine.create({
      storage,
      recover: false,
      workflows: { [id]: parkedOnSignal(id) },
    });
    await first.start(id, null, { id });
    await waitForCondition(() => getInternals(first).parkedInlineWorkflows.has(id), {
      label: `${id} parked on its signal`,
    });
    await first[Symbol.asyncDispose]();

    // The second engine reads the stored checkpoint as it resumes the run; hold that read.
    const reachedRead = createDeferred();
    const releaseRead = createDeferred();
    let held = false;
    const gated = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return async (key: string) => {
            if (key === KEYS.checkpoint(id) && !held) {
              held = true;
              reachedRead.resolve();
              await releaseRead.promise;
            }
            return original.call(target, key);
          };
        }
        return original.bind(target);
      },
    });
    const second = new Engine({ storage: gated });
    second.register(parkedOnSignal(id));
    const internals = getInternals(second);
    const resuming = second.resume(id);
    resuming.catch(() => {});
    await reachedRead.promise;

    await second[Symbol.asyncDispose]();
    releaseRead.resolve();
    await resuming.catch(() => {});
    await yieldToEventLoop();

    // A launch that finishes after disposal holds nothing: no checkpoint, and no attempt for a
    // later loss to abandon.
    expect(internals.checkpoints.size).toBe(0);
    expect(currentExecutionAttempt(internals, id)).toBeUndefined();
  });
});

/**
 * The registry only stays the single answer if every held checkpoint comes and goes with its
 * attempt. `adoptLaunchCheckpoint` and the three release functions in
 * `checkpoint-commit-snapshots.ts` pair them; a new `internals.checkpoints` mutation anywhere
 * else would reopen the split between "what the engine holds" and "what the registry says".
 */
describe('where a held checkpoint is installed and removed', () => {
  it('is only checkpoint-commit-snapshots.ts, plus the object replacement after a commit', async () => {
    const mutators: string[] = [];
    for await (const path of new Glob('**/*.ts').scan({ cwd: import.meta.dir })) {
      if (/\.test(-support)?\.ts$/.test(path)) continue;
      const source = await Bun.file(`${import.meta.dir}/${path}`).text();
      if (/\bcheckpoints\??\.(?:set|delete|clear)\(/.test(source)) mutators.push(path);
    }

    expect(mutators.toSorted()).toEqual(['checkpoint-commit-snapshots.ts', 'checkpoint-io.ts']);
  });
});
