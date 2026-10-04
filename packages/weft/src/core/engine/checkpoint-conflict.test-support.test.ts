/**
 * The warning interception the checkpoint-conflict test files share. It is a test fixture, and the
 * files that use it only work if it takes exactly the operator warning, so it has tests of its own.
 * They run it against a stand-in for `process`, because pointing it at the real one would print
 * the other warnings these cases hand it.
 */
import { describe, expect, it } from 'bun:test';

import { WeftWorkflowCheckpointConflictWarning } from './checkpoint-conflict-error.ts';
import {
  collectConflictWarnings,
  interceptConflictWarningsOn,
} from './checkpoint-conflict.test-support.ts';

/** A stand-in for `process` that records what its real `emitWarning` is given. */
function createStandIn() {
  const printed: (string | Error)[] = [];
  return {
    printed,
    standIn: {
      emitWarning(warning: string | Error): void {
        printed.push(warning);
      },
    },
  };
}

describe('intercepting the checkpoint conflict warning', () => {
  it('hands a conflict warning to the open collectors and not to the real emitWarning', () => {
    const { printed, standIn } = createStandIn();
    const restore = interceptConflictWarningsOn(standIn);
    const first = collectConflictWarnings();
    const second = collectConflictWarnings();
    try {
      const warning = new WeftWorkflowCheckpointConflictWarning('conflict-run');

      standIn.emitWarning(warning);

      expect(first.warnings).toEqual([warning]);
      expect(second.warnings).toEqual([warning]);
      expect(printed).toEqual([]);
    } finally {
      first.stop();
      second.stop();
      restore();
    }
  });

  it('passes every other warning on to the real emitWarning', () => {
    const { printed, standIn } = createStandIn();
    const interceptedEmitWarning = standIn.emitWarning;
    const restore = interceptConflictWarningsOn(standIn);
    const collected = collectConflictWarnings();
    try {
      const other = new Error('an unrelated warning');

      standIn.emitWarning(other);

      expect(printed).toEqual([other]);
      expect(collected.warnings).toEqual([]);
    } finally {
      collected.stop();
      restore();
    }
    // Restoring puts back the function that was there.
    expect(standIn.emitWarning).toBe(interceptedEmitWarning);
  });

  it('settles received once the expected number of warnings arrived', async () => {
    const { standIn } = createStandIn();
    const restore = interceptConflictWarningsOn(standIn);
    const collected = collectConflictWarnings(2);
    try {
      standIn.emitWarning(new WeftWorkflowCheckpointConflictWarning('first'));
      standIn.emitWarning(new WeftWorkflowCheckpointConflictWarning('second'));

      await collected.received;

      expect(collected.warnings.map((warning) => warning.workflowId)).toEqual(['first', 'second']);
    } finally {
      collected.stop();
      restore();
    }
  });

  it('stops delivering to a collector once it is stopped', () => {
    const { standIn } = createStandIn();
    const restore = interceptConflictWarningsOn(standIn);
    const collected = collectConflictWarnings();
    try {
      collected.stop();

      standIn.emitWarning(new WeftWorkflowCheckpointConflictWarning('after-stop'));

      expect(collected.warnings).toEqual([]);
    } finally {
      restore();
    }
  });

  it('refuses to collect when no interception is installed', () => {
    expect(() => collectConflictWarnings()).toThrow(
      'call interceptConflictWarnings() at the top level of the test file first',
    );
  });
});
