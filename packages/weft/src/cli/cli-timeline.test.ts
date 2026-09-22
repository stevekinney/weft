import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workflow } from '../index.ts';
import { collectDiffLines, createStorage, executeTimeline } from './index.ts';

async function firstCliStep() {
  return { apiKey: 'sk-cli-secret', phase: 'first' as const };
}

async function secondCliStep() {
  return { phase: 'second' as const };
}

async function prepareCliFailure() {
  return { phase: 'prepared' as const };
}

async function failCliTimeline() {
  throw new Error('cli timeline failure');
}

describe('executeTimeline', () => {
  it('formats non-plain replay values as leaf diff lines instead of recursing into them', () => {
    const lines: string[] = [];

    collectDiffLines(
      [new Date('2026-01-01T00:00:00.000Z')],
      [new Date('2026-01-02T00:00:00.000Z')],
      'accumulatedResults',
      lines,
    );

    expect(lines).toEqual([
      'accumulatedResults[0]: "2026-01-01T00:00:00.000Z" -> "2026-01-02T00:00:00.000Z"',
    ]);
  });

  it('prints timeline rows, replay output, and diffs for a stored workflow history', async () => {
    const database = join(tmpdir(), `weft-timeline-${crypto.randomUUID()}.db`);
    const storage = await createStorage('sqlite', database);
    const { Engine } = await import('../index.ts');
    const engine = new Engine({ storage, checkpointHistory: 10 });

    try {
      const cliTimeline = workflow({ name: 'cli-timeline', version: '7.0.0' }).execute(
        async function* (ctx) {
          yield* ctx.run(firstCliStep);
          return yield* ctx.run(secondCliStep);
        },
      );
      engine.register(cliTimeline);

      const handle = await engine.start('cli-timeline', null, { id: 'wf-cli-timeline' });
      await handle.result();
    } finally {
      await engine[Symbol.asyncDispose]();
      storage[Symbol.dispose]();
    }

    try {
      const timelineResult = await executeTimeline({
        database,
        workflowId: 'wf-cli-timeline',
      });
      expect(timelineResult.exitCode).toBe(0);
      expect(timelineResult.stdout).toContain('Step 1');
      expect(timelineResult.stdout).toContain('firstCliStep');

      const replayResult = await executeTimeline({
        database,
        workflowId: 'wf-cli-timeline',
        step: 2,
      });
      expect(replayResult.exitCode).toBe(0);
      expect(replayResult.stdout).toContain('Replay step 2');
      expect(replayResult.stdout).toContain('"version": "7.0.0"');
      expect(replayResult.stdout).toContain('"apiKey": "[REDACTED]"');

      const diffResult = await executeTimeline({
        database,
        workflowId: 'wf-cli-timeline',
        diff: [1, 2],
      });
      expect(diffResult.exitCode).toBe(0);
      expect(diffResult.stdout).toContain('Diff 1 -> 2');
      expect(diffResult.stdout).toContain('accumulatedResults[0]');
    } finally {
      rmSync(database, { force: true });
    }
  });

  it('shows failed timeline entries with the terminal status and error summary', async () => {
    const database = join(tmpdir(), `weft-timeline-failed-${crypto.randomUUID()}.db`);
    const storage = await createStorage('sqlite', database);
    const { Engine } = await import('../index.ts');
    const engine = new Engine({ storage, checkpointHistory: 10 });

    try {
      const cliTimelineFailed = workflow({ name: 'cli-timeline-failed' }).execute(
        async function* (ctx) {
          yield* ctx.run(prepareCliFailure);
          return yield* ctx.run(failCliTimeline);
        },
      );
      engine.register(cliTimelineFailed);

      const handle = await engine.start('cli-timeline-failed', null, {
        id: 'wf-cli-timeline-failed',
      });
      await handle.result().catch(() => {});
    } finally {
      await engine[Symbol.asyncDispose]();
      storage[Symbol.dispose]();
    }

    try {
      const result = await executeTimeline({
        database,
        workflowId: 'wf-cli-timeline-failed',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Step 2 | activity | failCliTimeline | failed');
      expect(result.stdout).toContain('cli timeline failure');
    } finally {
      rmSync(database, { force: true });
    }
  });

  it('returns errors for missing workflow ids and missing replay steps', async () => {
    expect(
      await executeTimeline({
        database: ':memory:',
        workflowId: '',
      }),
    ).toEqual({
      stdout: '',
      stderr: 'Error: workflowId is required for timeline',
      exitCode: 1,
    });

    const database = join(tmpdir(), `weft-timeline-missing-${crypto.randomUUID()}.db`);
    const storage = await createStorage('sqlite', database);
    const { Engine } = await import('../index.ts');
    const engine = new Engine({ storage });

    try {
      const timelineMissing = workflow({ name: 'timeline-missing' }).execute(async function* () {
        yield* [];
        return 'done';
      });
      engine.register(timelineMissing);

      const handle = await engine.start('timeline-missing', null, { id: 'wf-cli-missing-replay' });
      await handle.result();
    } finally {
      await engine[Symbol.asyncDispose]();
      storage[Symbol.dispose]();
    }

    try {
      expect(
        await executeTimeline({
          database,
          workflowId: 'missing-workflow',
        }),
      ).toEqual({
        stdout: '',
        stderr: 'Error: workflow "missing-workflow" not found',
        exitCode: 1,
      });

      expect(
        await executeTimeline({
          database,
          workflowId: 'wf-cli-missing-replay',
          step: 99,
        }),
      ).toEqual({
        stdout: '',
        stderr: 'Error: replay not found for step 99',
        exitCode: 1,
      });

      expect(
        await executeTimeline({
          database,
          workflowId: 'wf-cli-missing-replay',
          diff: [1, 99],
        }),
      ).toEqual({
        stdout: '',
        stderr: 'Error: replay not found for diff 1 -> 99',
        exitCode: 1,
      });
    } finally {
      rmSync(database, { force: true });
    }
  });
});
