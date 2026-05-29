import { afterEach, describe, expect, it } from 'bun:test';

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSchedule, executeTimeline, parseCliArguments } from './cli/index.ts';
import { encode } from './core/codec.ts';
import { Engine } from './core/engine.ts';
import { workflow } from './core/types/workflow-function.ts';
import { BunSQLiteStorage } from './storage/bun-sql.ts';
import { KEYS } from './storage/interface.ts';

const databasesToDelete = new Set<string>();

afterEach(() => {
  for (const databasePath of databasesToDelete) {
    if (existsSync(databasePath)) {
      rmSync(databasePath, { force: true });
    }
  }
  databasesToDelete.clear();
});

function createTimelineDatabasePath(): string {
  const databasePath = join(tmpdir(), `weft-cli-edge-${crypto.randomUUID()}.db`);
  databasesToDelete.add(databasePath);
  return databasePath;
}

async function seedTimelineDatabase(databasePath: string): Promise<void> {
  const storage = new BunSQLiteStorage(databasePath);
  const engine = new Engine({ storage });

  async function firstStep(): Promise<{ stage: string; token: string }> {
    return { stage: 'first', token: '[REDACTED]' };
  }

  try {
    engine.register(
      workflow({ name: 'timeline-edge', version: '1.0.0' }).execute(async function* (ctx) {
        yield* ctx.run(firstStep);
        return 'done';
      }),
    );

    const handle = await engine.start('timeline-edge', null, { id: 'wf-cli-edge' });
    await handle.result();
  } finally {
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]();
  }
}

describe('CLI edge coverage', () => {
  it('rejects invalid timeline step arguments and conflicting flags', () => {
    expect(() => parseCliArguments(['timeline', 'wf-1', '--step=-1'])).toThrow(
      '--step must be a non-negative integer',
    );
    expect(() => parseCliArguments(['timeline', 'wf-1', '--diff', '1'])).toThrow(
      '--diff requires two step numbers',
    );
    expect(() =>
      parseCliArguments(['timeline', 'wf-1', '--step', '1', '--diff', '1', '2']),
    ).toThrow('--step and --diff cannot be used together');
  });

  it('returns validation errors for missing or unknown timeline workflow ids', async () => {
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

    const databasePath = createTimelineDatabasePath();
    const result = await executeTimeline({
      database: databasePath,
      workflowId: 'wf-missing',
    });

    expect(result).toEqual({
      stdout: '',
      stderr: 'Error: workflow "wf-missing" not found',
      exitCode: 1,
    });
  });

  it('returns replay-specific errors when requested steps are missing', async () => {
    const databasePath = createTimelineDatabasePath();
    await seedTimelineDatabase(databasePath);

    const replayResult = await executeTimeline({
      database: databasePath,
      workflowId: 'wf-cli-edge',
      step: 99,
    });
    expect(replayResult).toEqual({
      stdout: '',
      stderr: 'Error: replay not found for step 99',
      exitCode: 1,
    });

    const diffResult = await executeTimeline({
      database: databasePath,
      workflowId: 'wf-cli-edge',
      diff: [1, 99],
    });
    expect(diffResult).toEqual({
      stdout: '',
      stderr: 'Error: replay not found for diff 1 -> 99',
      exitCode: 1,
    });
  }, 2_000);

  it('shows a friendly message when a workflow has no timeline entries', async () => {
    const databasePath = createTimelineDatabasePath();
    const storage = new BunSQLiteStorage(databasePath);

    try {
      await storage.put(
        KEYS.workflow('wf-empty-timeline'),
        encode({
          id: 'wf-empty-timeline',
          type: 'echo',
          status: 'completed',
          input: null,
          result: 'done',
          version: '1.0.0',
          createdAt: 1,
          updatedAt: 1,
          step: 0,
          locals: {},
          searchAttributes: {},
        }),
      );
    } finally {
      storage[Symbol.dispose]();
    }

    const result = await executeTimeline({
      database: databasePath,
      workflowId: 'wf-empty-timeline',
    });

    expect(result).toEqual({
      stdout: 'No timeline entries found for workflow "wf-empty-timeline".',
      exitCode: 0,
    });
  });

  it('rejects invalid schedule overlap policies during argument parsing', () => {
    expect(() =>
      parseCliArguments([
        'schedule',
        'create',
        '--workflows',
        './workflows.ts',
        '--overlap',
        'parallel',
        'echo',
        '* * * * *',
      ]),
    ).toThrow("Invalid overlap policy 'parallel'");
  });

  it('returns schedule create and mutation validation errors without touching storage', async () => {
    expect(
      await executeSchedule({
        command: 'schedule',
        action: 'create',
        database: ':memory:',
        storage: 'sqlite',
        help: false,
        json: false,
        workflows: '',
        workflowType: 'scheduledEcho',
        cronExpression: '* * * * *',
        input: 'null',
        backfill: false,
      }),
    ).toEqual({
      stdout: '',
      stderr: 'Error: --workflows flag is required for schedule create',
      exitCode: 1,
    });

    expect(
      await executeSchedule({
        command: 'schedule',
        action: 'create',
        database: ':memory:',
        storage: 'sqlite',
        help: false,
        json: false,
        workflows: './workflows.ts',
        workflowType: '',
        cronExpression: '* * * * *',
        input: 'null',
        backfill: false,
      }),
    ).toEqual({
      stdout: '',
      stderr: 'Error: missing required argument <workflowType> for schedule create',
      exitCode: 1,
    });

    expect(
      await executeSchedule({
        command: 'schedule',
        action: 'create',
        database: ':memory:',
        storage: 'sqlite',
        help: false,
        json: false,
        workflows: './workflows.ts',
        workflowType: 'scheduledEcho',
        cronExpression: '',
        input: 'null',
        backfill: false,
      }),
    ).toEqual({
      stdout: '',
      stderr:
        'Error: provide a <cronExpression> argument or an --every <duration> flag for schedule create',
      exitCode: 1,
    });

    const workflowsPath = join(tmpdir(), `weft-cli-edge-workflows-${crypto.randomUUID()}.ts`);
    databasesToDelete.add(workflowsPath);
    await Bun.write(
      workflowsPath,
      [
        'export default {',
        '  scheduledEcho: {',
        '    handler: async function* (_ctx, input) {',
        '      return input;',
        '    },',
        '  },',
        '};',
      ].join('\n'),
    );

    const createWithInvalidJson = await executeSchedule({
      command: 'schedule',
      action: 'create',
      database: ':memory:',
      storage: 'sqlite',
      help: false,
      json: false,
      workflows: workflowsPath,
      workflowType: 'scheduledEcho',
      cronExpression: '* * * * *',
      input: '{bad json',
      backfill: false,
    });
    expect(createWithInvalidJson.stderr).toContain('Error: could not parse --input JSON:');
    expect(createWithInvalidJson.exitCode).toBe(1);

    expect(
      await executeSchedule({
        command: 'schedule',
        action: 'pause',
        database: ':memory:',
        storage: 'sqlite',
        help: false,
        json: false,
        scheduleId: '',
      }),
    ).toEqual({
      stdout: '',
      stderr: 'Error: scheduleId is required for schedule pause',
      exitCode: 1,
    });
  });

  it('surfaces executeSchedule setup failures through the shared catch path', async () => {
    const result = await executeSchedule({
      command: 'schedule',
      action: 'create',
      database: ':memory:',
      storage: 'sqlite',
      help: false,
      json: false,
      workflows: './missing-workflows.ts',
      workflowType: 'scheduledEcho',
      cronExpression: '* * * * *',
      input: 'null',
      backfill: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error:');
    expect(result.stderr).toContain('missing-workflows.ts');
  });
});
