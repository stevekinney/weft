import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { WorkflowContext } from '../index.ts';
import { workflow } from '../index.ts';
import { createStorage, executeSchedule, parseCliArguments } from './index.ts';

function createTemporaryTypeScriptPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'module.ts');
}

function removeTemporaryTypeScriptPath(filePath: string): void {
  rmSync(dirname(filePath), { force: true, recursive: true });
}

describe('executeSchedule', () => {
  it('lists, creates, pauses, resumes, and cancels schedules against a SQLite database', async () => {
    const database = join(tmpdir(), `weft-schedule-${crypto.randomUUID()}.db`);
    const workflows = createTemporaryTypeScriptPath('weft-schedule-workflows');

    await Bun.write(
      workflows,
      [
        'export default {',
        '  scheduledEcho: {',
        '    name: "scheduledEcho",',
        '    handler: async function* (_ctx, input) {',
        '      return input;',
        '    },',
        '  },',
        '};',
      ].join('\n'),
    );

    const storage = await createStorage('sqlite', database);
    const { Engine } = await import('../index.ts');
    let engine = new Engine({ storage });

    try {
      const scheduledEcho = workflow({ name: 'scheduledEcho' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        yield* [];
        return input;
      });
      engine.register(scheduledEcho);
      await engine.schedule('scheduledEcho', { payload: 'existing' }, '0 * * * *', {
        id: 'existing-schedule',
      });
    } finally {
      await engine[Symbol.asyncDispose]();
      storage[Symbol.dispose]();
    }

    try {
      const listResult = await executeSchedule({
        command: 'schedule',
        action: 'list',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
      });
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain('existing-schedule');
      expect(listResult.stdout).toContain('ID | Workflow Type | Status | Cadence | Next Fire');

      const createResult = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        workflows,
        workflowType: 'scheduledEcho',
        cronExpression: '15 * * * *',
        input: '{"payload":"nightly"}',
        id: 'created-schedule',
        overlap: 'queue',
        backfill: true,
        jitter: '30s',
      });
      expect(createResult.exitCode).toBe(0);
      expect(createResult.stdout).toContain('created-schedule');

      const pauseResult = await executeSchedule({
        command: 'schedule',
        action: 'pause',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        scheduleId: 'created-schedule',
      });
      expect(pauseResult.exitCode).toBe(0);

      const resumeResult = await executeSchedule({
        command: 'schedule',
        action: 'resume',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        scheduleId: 'created-schedule',
      });
      expect(resumeResult.exitCode).toBe(0);

      const cancelResult = await executeSchedule({
        command: 'schedule',
        action: 'cancel',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        scheduleId: 'created-schedule',
      });
      expect(cancelResult.exitCode).toBe(0);

      const verificationStorage = await createStorage('sqlite', database);
      engine = new Engine({ storage: verificationStorage });
      try {
        const existing = await engine.getSchedule('existing-schedule');
        const created = await engine.getSchedule('created-schedule');
        expect(existing).not.toBeNull();
        expect(created).toEqual(
          expect.objectContaining({
            id: 'created-schedule',
            status: 'cancelled',
            overlap: 'queue',
            backfill: true,
            jitterMs: 30_000,
          }),
        );
      } finally {
        await engine[Symbol.asyncDispose]();
        verificationStorage[Symbol.dispose]();
      }
    } finally {
      removeTemporaryTypeScriptPath(workflows);
      rmSync(database, { force: true });
    }
  });

  it('uses the selected storage backend for schedule commands', async () => {
    const database = join(tmpdir(), `weft-schedule-lmdb-${crypto.randomUUID()}`);
    const workflows = createTemporaryTypeScriptPath('weft-schedule-lmdb-workflows');

    await Bun.write(
      workflows,
      [
        'export default {',
        '  scheduledEcho: {',
        '    name: "scheduledEcho",',
        '    handler: async function* (_ctx, input) {',
        '      return input;',
        '    },',
        '  },',
        '};',
      ].join('\n'),
    );

    try {
      const createResult = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'lmdb',
        help: false,
        json: false,
        workflows,
        workflowType: 'scheduledEcho',
        cronExpression: '30 * * * *',
        input: '{"payload":"lmdb"}',
        id: 'lmdb-schedule',
        backfill: false,
      });
      expect(createResult.exitCode).toBe(0);
      expect(createResult.stdout).toContain('lmdb-schedule');

      const listResult = await executeSchedule({
        command: 'schedule',
        action: 'list',
        database,
        storage: 'lmdb',
        help: false,
        json: false,
      });
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain('lmdb-schedule');

      const storage = await createStorage('lmdb', database);
      const { Engine } = await import('../index.ts');
      const engine = new Engine({ storage });

      try {
        expect(await engine.getSchedule('lmdb-schedule')).toEqual(
          expect.objectContaining({
            id: 'lmdb-schedule',
            cronExpression: '30 * * * *',
          }),
        );
      } finally {
        await engine[Symbol.asyncDispose]();
        storage[Symbol.dispose]();
      }
    } finally {
      removeTemporaryTypeScriptPath(workflows);
      rmSync(database, { recursive: true, force: true });
    }
  });

  it('rejects memory storage for schedule commands before creating a fresh in-memory backend', async () => {
    const command = parseCliArguments(['schedule', 'list']);
    Reflect.set(command, 'storage', 'memory');
    if (command.command !== 'schedule') throw new TypeError('unexpected command');
    const result = await executeSchedule(command);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'Error: --storage memory is not supported for schedule commands because data does not persist across CLI invocations',
    );
  });
});
