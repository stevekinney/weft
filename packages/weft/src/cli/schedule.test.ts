import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSchedule } from './schedule.ts';
import type { ScheduleCommand } from './types.ts';

const databases: string[] = [];

afterEach(() => {
  while (databases.length > 0) {
    const database = databases.pop();
    if (database) {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${database}${suffix}`, { force: true });
      }
    }
  }
});

describe('schedule command validation and formatting', () => {
  it('requires workflows and rejects simultaneous cron and interval cadences', async () => {
    const missingWorkflows = await executeSchedule({
      command: 'schedule',
      action: 'create',
      database: ':memory:',
      storage: 'sqlite',
      workflows: '',
      workflowType: 'helloWorld',
      cronExpression: '* * * * *',
      input: 'null',
      backfill: false,
      help: false,
      json: false,
    } satisfies ScheduleCommand);
    expect(missingWorkflows.stderr).toBe('Error: --workflows flag is required for schedule create');

    const bothCadences = await executeSchedule({
      command: 'schedule',
      action: 'create',
      database: ':memory:',
      storage: 'sqlite',
      workflows: 'workflows.ts',
      workflowType: 'helloWorld',
      cronExpression: '* * * * *',
      every: '1h',
      input: 'null',
      backfill: false,
      help: false,
      json: false,
    } satisfies ScheduleCommand);
    expect(bothCadences.stderr).toBe(
      'Error: provide exactly one of <cronExpression> or --every, not both',
    );
  });

  it('formats interval schedules when listing persisted schedules', async () => {
    const database = join(tmpdir(), `weft-schedule-${crypto.randomUUID()}.db`);
    databases.push(database);
    const workflows = new URL('../hello-world.test-support.ts', import.meta.url).pathname;

    const created = await executeSchedule({
      command: 'schedule',
      action: 'create',
      database,
      storage: 'sqlite',
      workflows,
      workflowType: 'helloWorld',
      cronExpression: '',
      every: '1h',
      input: '"world"',
      id: 'interval-schedule',
      backfill: false,
      help: false,
      json: false,
    } satisfies ScheduleCommand);
    expect(created.exitCode).toBe(0);

    const listed = await executeSchedule({
      command: 'schedule',
      action: 'list',
      database,
      storage: 'sqlite',
      help: false,
      json: false,
    } satisfies ScheduleCommand);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('every 3600000ms');
  });
});
