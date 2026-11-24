/**
 * COR-2018: `updateSchedule` moves a schedule to another workflow type and replaces the input each
 * fire starts it with, as the schedule edit page does. Omitted, both stay; a pin follows the type.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { ScheduleFiredEvent } from '../events.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  createEngine,
  drainEngine,
  registerWorkflow,
  requireNextFireAt,
  START,
  tickEngine,
} from './schedule.test-support.ts';

async function open() {
  const clock = { now: START };
  const engine = createEngine(clock, new MemoryStorage());
  registerWorkflow(engine, 'first-workflow', async function* () {
    return 'first';
  });
  registerWorkflow(engine, 'second-workflow', async function* () {
    return 'second';
  });
  const fired: string[] = [];
  engine.addEventListener(ScheduleFiredEvent.type, (event) => {
    fired.push(event.workflowId);
  });
  return { clock, engine, fired };
}

describe('updateSchedule with a workflow type and an input', () => {
  it('starts the new workflow with the new input from the next fire on', async () => {
    const { clock, engine, fired } = await open();
    try {
      const handle = await engine.schedule('first-workflow', { text: 'old' }, '* * * * *', {
        id: 'moved',
      });
      await engine.updateSchedule('moved', '* * * * *', {
        workflowType: 'second-workflow',
        input: { text: 'new' },
      });
      const summary = await handle.describe();
      expect(summary.workflowType).toBe('second-workflow');
      expect(summary.revision).toBe(2);
      await tickEngine(engine, clock, requireNextFireAt(summary));
      expect(fired).toHaveLength(1);
      const started = await engine.get(fired[0]!);
      expect(started?.type).toBe('second-workflow');
      expect(started?.input).toEqual({ text: 'new' });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('keeps the workflow type and the input when an update names neither', async () => {
    const { clock, engine, fired } = await open();
    try {
      const handle = await engine.schedule('first-workflow', { text: 'kept' }, '* * * * *', {
        id: 'kept',
      });
      await engine.updateSchedule('kept', '*/2 * * * *', { description: 'renamed' });
      const summary = await handle.describe();
      expect(summary.workflowType).toBe('first-workflow');
      await tickEngine(engine, clock, requireNextFireAt(summary));
      await drainEngine();
      const started = await engine.get(fired[0]!);
      expect(started?.type).toBe('first-workflow');
      expect(started?.input).toEqual({ text: 'kept' });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('stores a null input, which is an input like any other', async () => {
    const { clock, engine, fired } = await open();
    try {
      const handle = await engine.schedule('first-workflow', { text: 'old' }, '* * * * *', {
        id: 'nulled',
      });
      await engine.updateSchedule('nulled', '* * * * *', { input: null });
      const summary = await handle.describe();
      await tickEngine(engine, clock, requireNextFireAt(summary));
      const started = await engine.get(fired[0]!);
      expect(started?.input).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('refuses a workflow type that is not a non-empty string and writes nothing', async () => {
    const { engine } = await open();
    try {
      const handle = await engine.schedule('first-workflow', null, '* * * * *', { id: 'refused' });
      for (const bad of ['', '   ', 7 as never]) {
        const refusal = await rejectionOf(
          engine.updateSchedule('refused', '* * * * *', { workflowType: bad }),
        );
        expect(String(refusal)).toContain('options.workflowType must be a non-empty string');
      }
      const summary = await handle.describe();
      expect(summary.workflowType).toBe('first-workflow');
      expect(summary.revision).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('re-captures a pinned schedule against the new type even when the policy is not restated', async () => {
    const clock = { now: START };
    const engine = createEngine(clock, new MemoryStorage());
    const first = workflow({ name: 'pin-first' }).execute(async function* (_ctx: WorkflowContext) {
      return 'first';
    });
    const second = workflow({ name: 'pin-second', description: 'the other one' }).execute(
      async function* (_ctx: WorkflowContext) {
        return 'second';
      },
    );
    (engine.register as (definition: typeof first) => unknown)(first);
    (engine.register as (definition: typeof second) => unknown)(second);
    try {
      const handle = await engine.schedule('pin-first', null, '* * * * *', {
        id: 'pinned-move',
        revisionPolicy: 'pinned',
      });
      const before = await handle.describe();
      expect(before.pinnedRevision).toBeDefined();
      await engine.updateSchedule('pinned-move', '* * * * *', { workflowType: 'pin-second' });
      const after = await handle.describe();
      expect(after.revisionPolicy).toBe('pinned');
      expect(after.pinnedRevision).toBeDefined();
      expect(after.pinnedRevision).not.toBe(before.pinnedRevision);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
