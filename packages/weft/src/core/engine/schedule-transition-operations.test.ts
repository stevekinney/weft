/**
 * COR-67: `pauseSchedule`/`resumeSchedule`/`cancelSchedule` accept an optional
 * `ScheduleTransitionOptions` so a consumer keeping its own durable
 * projection in step with the engine's schedule state can fold its own
 * put operations — guarded by expected-value conditions on its own keys —
 * into the SAME storage commit that persists the schedule's status
 * transition.
 *
 * This suite proves the point of the feature: atomicity. A successful call
 * commits both sides together. A call whose own guard has gone stale
 * (simulating a concurrent write to the caller's key between the caller's
 * read and this call — the "injected failure between them") commits NEITHER
 * side: the schedule keeps its prior status and the caller's key keeps
 * whatever the concurrent writer left there.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { workflow as defineWorkflow } from '../types.ts';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeText(value: string): Uint8Array {
  return encoder.encode(value);
}

function decodeText(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

function newEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage, getNow: () => START, backgroundTasks: 'manual' });
  engine.register(
    defineWorkflow({ name: 'cor-67-noop' }).execute(async function* () {
      return 'done';
    }),
  );
  return engine;
}

describe('COR-67: schedule transition atomicity', () => {
  it('commits a caller-supplied operation together with the schedule state transition', async () => {
    const storage = new MemoryStorage();
    const engine = newEngine(storage);
    try {
      const projectionKey = 'app:cor-67-test:projection:atomic-success';
      await storage.batch([{ type: 'put', key: projectionKey, value: encodeText('v1') }]);

      const handle = await engine.schedule('cor-67-noop', null, '0 9 * * *', {
        id: 'atomic-success',
      });

      await engine.pauseSchedule('atomic-success', {
        additionalOperations: [{ type: 'put', key: projectionKey, value: encodeText('paused') }],
        extraConditions: [{ key: projectionKey, expectedValue: encodeText('v1') }],
      });

      const summary = await handle.describe();
      expect(summary.status).toBe('paused');
      expect(decodeText(await storage.get(projectionKey))).toBe('paused');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('commits NEITHER side when the caller-supplied condition loses the compare-and-swap', async () => {
    const storage = new MemoryStorage();
    const engine = newEngine(storage);
    try {
      const projectionKey = 'app:cor-67-test:projection:atomic-failure';
      // The caller reads its own key here, planning to guard this call on 'v1'.
      await storage.batch([{ type: 'put', key: projectionKey, value: encodeText('v1') }]);

      const handle = await engine.schedule('cor-67-noop', null, '0 9 * * *', {
        id: 'atomic-failure',
      });

      // Injected failure: a concurrent writer changes the caller's own key
      // between that read and the guarded call below.
      await storage.batch([
        { type: 'put', key: projectionKey, value: encodeText('concurrent-write') },
      ]);

      class ProjectionConflictError extends Error {}

      await expect(
        engine.pauseSchedule('atomic-failure', {
          additionalOperations: [{ type: 'put', key: projectionKey, value: encodeText('paused') }],
          extraConditions: [{ key: projectionKey, expectedValue: encodeText('v1') }],
          onExtraConditionsLost: () => new ProjectionConflictError('stale projection guard'),
        }),
      ).rejects.toThrow(ProjectionConflictError);

      // Neither side landed: the schedule is still active...
      const summary = await handle.describe();
      expect(summary.status).toBe('active');
      // ...and the projection key still holds the concurrent writer's value,
      // not the caller's rejected 'paused' write.
      expect(decodeText(await storage.get(projectionKey))).toBe('concurrent-write');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('falls back to a generic lost-precondition error when extraConditions loses the CAS and no onExtraConditionsLost is supplied', async () => {
    const storage = new MemoryStorage();
    const engine = newEngine(storage);
    try {
      const projectionKey = 'app:cor-67-test:projection:atomic-default-error';
      await storage.batch([{ type: 'put', key: projectionKey, value: encodeText('v1') }]);
      await engine.schedule('cor-67-noop', null, '0 9 * * *', { id: 'atomic-default-error' });
      await storage.batch([{ type: 'put', key: projectionKey, value: encodeText('changed') }]);

      await expect(
        engine.pauseSchedule('atomic-default-error', {
          extraConditions: [{ key: projectionKey, expectedValue: encodeText('v1') }],
        }),
      ).rejects.toThrow(/lost its precondition/);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('resumeSchedule and cancelSchedule accept the same options and commit atomically', async () => {
    const storage = new MemoryStorage();
    const engine = newEngine(storage);
    try {
      const resumeKey = 'app:cor-67-test:projection:resume';
      const cancelKey = 'app:cor-67-test:projection:cancel';

      const resumeHandle = await engine.schedule('cor-67-noop', null, '0 9 * * *', {
        id: 'resume-target',
      });
      await resumeHandle.pause();
      await engine.resumeSchedule('resume-target', {
        additionalOperations: [{ type: 'put', key: resumeKey, value: encodeText('resumed') }],
      });
      const resumedSummary = await resumeHandle.describe();
      expect(resumedSummary.status).toBe('active');
      expect(decodeText(await storage.get(resumeKey))).toBe('resumed');

      const cancelHandle = await engine.schedule('cor-67-noop', null, '0 9 * * *', {
        id: 'cancel-target',
      });
      await engine.cancelSchedule('cancel-target', {
        additionalOperations: [{ type: 'put', key: cancelKey, value: encodeText('cancelled') }],
      });
      const cancelledSummary = await cancelHandle.describe();
      expect(cancelledSummary.status).toBe('cancelled');
      expect(decodeText(await storage.get(cancelKey))).toBe('cancelled');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
