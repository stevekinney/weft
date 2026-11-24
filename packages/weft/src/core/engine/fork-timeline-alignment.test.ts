import { describe, expect, it } from 'bun:test';

import type { WorkflowTimelineEntry } from '../types.ts';
import {
  alignForkTimelines,
  parseCompareCursor,
  resolveComparePageSize,
  splitStepsAtForkPoint,
} from './fork-timeline-alignment.ts';

function entry(
  step: number,
  stepIndex: number | undefined,
  overrides: Partial<WorkflowTimelineEntry> = {},
): WorkflowTimelineEntry {
  return {
    step,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    operationType: 'activity',
    operationLabel: `op-${String(stepIndex ?? step)}`,
    inputSummary: 'in',
    outputSummary: 'out',
    timestamp: 0,
    status: 'completed',
    ...overrides,
  };
}

describe('splitStepsAtForkPoint', () => {
  it('keeps steps recorded before the fork point and reruns the rest', () => {
    const source = [entry(1, 0), entry(2, 1), entry(3, 2), entry(4, 3)];
    const { keptSteps, rerunSteps } = splitStepsAtForkPoint(source, 3);
    expect(keptSteps.map((step) => step.index)).toEqual([0, 1]);
    expect(rerunSteps.map((step) => step.index)).toEqual([2, 3]);
  });

  it('reads an activity retried many times as one step, reran when its last attempt is after the fork point', () => {
    const source = [
      entry(1, 0),
      entry(2, 1, { status: 'failed' }),
      entry(3, 1, { operationType: 'sleep' }),
      entry(4, 1),
    ];
    const { keptSteps, rerunSteps } = splitStepsAtForkPoint(source, 4);
    expect(keptSteps.map((step) => step.index)).toEqual([0]);
    expect(rerunSteps).toHaveLength(1);
    expect(rerunSteps[0]).toMatchObject({ index: 1, status: 'completed' });
  });

  it('indexes an entry recorded before stepIndex existed by the step before its checkpoint step', () => {
    const { keptSteps, rerunSteps } = splitStepsAtForkPoint(
      [entry(1, undefined), entry(2, undefined)],
      2,
    );
    expect(keptSteps.map((step) => step.index)).toEqual([0]);
    expect(rerunSteps.map((step) => step.index)).toEqual([1]);
  });
});

describe('alignForkTimelines', () => {
  const source = [entry(1, 0), entry(2, 1), entry(3, 2, { outputSummary: 'source-out' })];
  const fork = [entry(4, 2, { outputSummary: 'fork-out' })];

  it('shares steps before the fork point and puts each run on its own side after it', () => {
    const { steps, nextCursor } = alignForkTimelines(source, fork, 3, {
      after: undefined,
      limit: 10,
    });
    expect(nextCursor).toBeUndefined();
    expect(steps.map((step) => [step.index, step.shared])).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
    expect(steps[0]?.fork).toEqual(steps[0]?.source);
    expect(steps[0]?.fork).not.toBe(steps[0]?.source);
    expect(steps[2]?.source?.output).toBe('source-out');
    expect(steps[2]?.fork?.output).toBe('fork-out');
  });

  it('leaves out a step both runs lack, and a side a run lacks', () => {
    const { steps } = alignForkTimelines([entry(1, 0), entry(3, 5)], [entry(4, 3)], 3, {
      after: undefined,
      limit: 10,
    });
    expect(steps.map((step) => step.index)).toEqual([0, 3, 5]);
    expect(steps[1]).toEqual({ index: 3, shared: false, fork: expect.any(Object) });
    expect(steps[2]).toEqual({ index: 5, shared: false, source: expect.any(Object) });
  });

  it('pages without repeating or skipping a step', () => {
    const entries = Array.from({ length: 7 }, (_, index) => entry(index + 1, index));
    const pages: number[][] = [];
    let after: number | undefined;
    for (;;) {
      const page = alignForkTimelines(entries, [], 99, { after, limit: 3 });
      pages.push(page.steps.map((step) => step.index));
      if (page.nextCursor === undefined) break;
      after = parseCompareCursor(page.nextCursor);
    }
    expect(pages).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
  });
});

describe('the compare window', () => {
  it('defaults the page size and refuses what it cannot use', () => {
    expect(resolveComparePageSize(undefined)).toBe(100);
    expect(resolveComparePageSize(1000)).toBe(1000);
    for (const limit of [0, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveComparePageSize(limit)).toThrow('Field "limit"');
    }
  });

  it('reads only the cursors it issues', () => {
    expect(parseCompareCursor(undefined)).toBeUndefined();
    expect(parseCompareCursor('step:0')).toBe(0);
    expect(parseCompareCursor('step:249')).toBe(249);
    for (const cursor of [
      '',
      'step',
      'step:-1',
      'step:1.5',
      'STEP:1',
      ' step:1',
      'step:1234567890123456',
    ]) {
      expect(() => parseCompareCursor(cursor)).toThrow('Field "cursor"');
    }
  });
});
