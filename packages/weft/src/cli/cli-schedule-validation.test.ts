import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { executeSchedule, parseCliArguments } from './index.ts';

function createTemporaryTypeScriptPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'module.ts');
}

function removeTemporaryTypeScriptPath(filePath: string): void {
  rmSync(dirname(filePath), { force: true, recursive: true });
}

describe('executeSchedule', () => {
  it('returns validation errors for incomplete schedule create and mutation commands', async () => {
    const database = join(tmpdir(), `weft-schedule-validation-${crypto.randomUUID()}.db`);

    try {
      const missingWorkflowsResult = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        workflows: '',
        workflowType: 'scheduledEcho',
        cronExpression: '0 * * * *',
        input: 'null',
        backfill: false,
      });
      expect(missingWorkflowsResult).toEqual({
        stdout: '',
        stderr: 'Error: --workflows flag is required for schedule create',
        exitCode: 1,
      });

      const missingWorkflowTypeCommand = parseCliArguments([
        'schedule',
        'create',
        '--database',
        database,
        '--workflows',
        './workflows.ts',
        'scheduledEcho',
        '0 * * * *',
      ]);
      if (missingWorkflowTypeCommand.command !== 'schedule')
        throw new TypeError('unexpected command');
      Reflect.deleteProperty(missingWorkflowTypeCommand, 'workflowType');
      const missingWorkflowTypeResult = await executeSchedule(missingWorkflowTypeCommand);
      expect(missingWorkflowTypeResult).toEqual({
        stdout: '',
        stderr: 'Error: missing required argument <workflowType> for schedule create',
        exitCode: 1,
      });

      const missingCronExpressionCommand = parseCliArguments([
        'schedule',
        'create',
        '--database',
        database,
        '--workflows',
        './workflows.ts',
        'scheduledEcho',
        '0 * * * *',
      ]);
      if (missingCronExpressionCommand.command !== 'schedule')
        throw new TypeError('unexpected command');
      Reflect.deleteProperty(missingCronExpressionCommand, 'cronExpression');
      const missingCronExpressionResult = await executeSchedule(missingCronExpressionCommand);
      expect(missingCronExpressionResult).toEqual({
        stdout: '',
        stderr:
          'Error: provide a <cronExpression> argument or an --every <duration> flag for schedule create',
        exitCode: 1,
      });

      const missingScheduleIdCommand = parseCliArguments([
        'schedule',
        'pause',
        '--database',
        database,
        'schedule-id',
      ]);
      if (missingScheduleIdCommand.command !== 'schedule')
        throw new TypeError('unexpected command');
      Reflect.deleteProperty(missingScheduleIdCommand, 'scheduleId');
      const missingScheduleIdResult = await executeSchedule(missingScheduleIdCommand);
      expect(missingScheduleIdResult).toEqual({
        stdout: '',
        stderr: 'Error: scheduleId is required for schedule pause',
        exitCode: 1,
      });
    } finally {
      rmSync(database, { force: true });
    }
  });

  it('returns an error when schedule create input is not valid JSON', async () => {
    const database = join(tmpdir(), `weft-schedule-input-${crypto.randomUUID()}.db`);
    const workflows = createTemporaryTypeScriptPath('weft-schedule-input');

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
      const result = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        workflows,
        workflowType: 'scheduledEcho',
        cronExpression: '0 * * * *',
        input: '{"payload"',
        backfill: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Error: could not parse --input JSON:');
    } finally {
      removeTemporaryTypeScriptPath(workflows);
      rmSync(database, { force: true });
    }
  });

  it('surfaces schedule execution failures through the shared schedule error path', async () => {
    const database = join(tmpdir(), `weft-schedule-error-${crypto.randomUUID()}.db`);
    const workflows = createTemporaryTypeScriptPath('weft-schedule-error');

    await Bun.write(workflows, 'export default {};');

    try {
      const result = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        workflows,
        workflowType: 'scheduledEcho',
        cronExpression: '0 * * * *',
        input: 'null',
        backfill: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Error: No workflow registered with name "scheduledEcho"');
    } finally {
      removeTemporaryTypeScriptPath(workflows);
      rmSync(database, { force: true });
    }
  });
});
