import { describe, expect, it } from 'bun:test';
import { waitForCondition } from './testing/fake-timers.test-support.ts';

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CliCommand,
  CONFORMANCE_HELP_TEXT,
  DOCTOR_HELP_TEXT,
  HELP_TEXT,
  SCHEDULE_HELP_TEXT,
  TIMELINE_HELP_TEXT,
  VALIDATE_HELP_TEXT,
  VERSION_CHECK_HELP_TEXT,
  collectDiffLines,
  createStorage,
  executeConformance,
  executeDoctor,
  executeSchedule,
  executeTimeline,
  executeValidate,
  executeVersionCheck,
  parseCliArguments,
  splitGlobPattern,
} from './cli/index.ts';
import { expandGlobEntryPaths } from './cli/utilities.ts';
import { encode } from './core/codec.ts';
import type { WorkflowContext } from './core/types.ts';
import { workflow } from './core/types/workflow-function.ts';
import { KEYS } from './storage/interface.ts';

const publicEntryPointUrl = new URL('./index.ts', import.meta.url).href;

type ServeCommand = Extract<CliCommand, { command: 'serve' }>;
type DoctorCommand = Extract<CliCommand, { command: 'doctor' }>;
type VersionCheckCommand = Extract<CliCommand, { command: 'version:check' }>;
type ValidateCommand = Extract<CliCommand, { command: 'validate' }>;
type ConformanceCommand = Extract<CliCommand, { command: 'conformance' }>;
type TimelineCommand = Extract<CliCommand, { command: 'timeline' }>;
type ScheduleListCommand = Extract<CliCommand, { command: 'schedule'; action: 'list' }>;
type ScheduleCreateCommand = Extract<CliCommand, { command: 'schedule'; action: 'create' }>;
type ScheduleMutationCommand = Extract<
  CliCommand,
  { command: 'schedule'; action: 'pause' | 'resume' | 'cancel' }
>;

describe('CLI argument parsing', () => {
  describe('default subcommand (serve)', () => {
    it('defaults to serve when no subcommand is provided', () => {
      const result = parseCliArguments([]);
      expect(result.command).toBe('serve');
    });

    it('parses --port flag', () => {
      const result = parseCliArguments(['--port', '8080']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('8080');
    });

    it('parses -p short flag for port', () => {
      const result = parseCliArguments(['-p', '9999']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('9999');
    });

    it('defaults port to 7233', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('7233');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments(['--database', '/tmp/test.db']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/test.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['-d', '/tmp/other.db']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/other.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['--help']);
      expect(result.command).toBe('serve');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments([]);
      expect(result.command).toBe('serve');
      expect(result.help).toBe(false);
    });

    it('parses multiple flags together', () => {
      const result = parseCliArguments([
        '--port',
        '3000',
        '--database',
        '/var/weft.db',
      ]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('3000');
      expect(result.database).toBe('/var/weft.db');
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['-h']);
      expect(result.command).toBe('serve');
      expect(result.help).toBe(true);
    });

    it('parses explicit serve subcommand arguments', () => {
      const result = parseCliArguments(['serve', '--port', '5000']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('5000');
    });

    it('rejects positional arguments for serve mode instead of silently ignoring them', () => {
      expect(() => parseCliArguments(['./workflows.ts', '--port', '5000'])).toThrow();
    });

    it('parses --storage flag with sqlite', () => {
      const result = parseCliArguments(['--storage', 'sqlite']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('sqlite');
    });

    it('parses --storage flag with lmdb', () => {
      const result = parseCliArguments(['--storage', 'lmdb']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('lmdb');
    });

    it('parses --storage flag with memory', () => {
      const result = parseCliArguments(['--storage', 'memory']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('memory');
    });

    it('throws for an invalid storage backend', () => {
      expect(() => parseCliArguments(['--storage', 'postgres'])).toThrow(
        "Invalid storage backend 'postgres'",
      );
    });

    it('parses -s short flag for storage', () => {
      const result = parseCliArguments(['-s', 'lmdb']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('lmdb');
    });

    it('defaults storage to sqlite', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.storage).toBe('sqlite');
    });

    it('enables ui by default', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.ui).toBe(true);
    });

    it('parses --no-ui to disable the dashboard', () => {
      const result = parseCliArguments(['--no-ui']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.ui).toBe(false);
    });

    it('parses all flags combined', () => {
      const result = parseCliArguments([
        '-p',
        '4000',
        '-d',
        '/tmp/all.db',
        '-s',
        'memory',
        '--no-ui',
        '-h',
      ]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('4000');
      expect(result.database).toBe('/tmp/all.db');
      expect(result.storage).toBe('memory');
      expect(result.ui).toBe(false);
      expect(result.help).toBe(true);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['--unknown-flag'])).toThrow();
    });

    it('throws on an unknown subcommand with a suggestion when close enough', () => {
      expect(() => parseCliArguments(['timelin'])).toThrow(
        "Unknown command 'timelin'. Did you mean 'timeline'?",
      );
    });

    it('throws on an unknown subcommand without a weak suggestion', () => {
      expect(() => parseCliArguments(['something-else', '--port', '4444'])).toThrow(
        "Unknown command 'something-else'",
      );
    });
  });

  describe('doctor subcommand', () => {
    it('returns command doctor when doctor is the first positional', () => {
      const result = parseCliArguments(['doctor']);
      expect(result.command).toBe('doctor');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments(['doctor', '--database', '/tmp/doc.db']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['doctor', '-d', '/tmp/doc.db']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['doctor']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['doctor', '--help']);
      expect(result.command).toBe('doctor');
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['doctor', '-h']);
      expect(result.command).toBe('doctor');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['doctor']);
      expect(result.command).toBe('doctor');
      expect(result.help).toBe(false);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['doctor', '--json']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['doctor', '-j']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['doctor']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.json).toBe(false);
    });

    it('parses multiple flags together', () => {
      const result = parseCliArguments(['doctor', '-d', '/tmp/doc.db', '--json']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
      expect(result.json).toBe(true);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['doctor', '--port', '8080'])).toThrow();
    });
  });

  describe('version:check subcommand', () => {
    it('returns command version:check when version:check is the first positional', () => {
      const result = parseCliArguments(['version:check']);
      expect(result.command).toBe('version:check');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments([
        'version:check',
        '--database',
        '/tmp/vc.db',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments([
        'version:check',
        '-d',
        '/tmp/vc.db',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['version:check']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --workflows flag', () => {
      const result = parseCliArguments([
        'version:check',
        '--workflows',
        './workflows.ts',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('./workflows.ts');
    });

    it('parses -w short flag for workflows', () => {
      const result = parseCliArguments(['version:check', '-w', './wf.ts']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('./wf.ts');
    });

    it('defaults workflows to empty string', () => {
      const result = parseCliArguments(['version:check']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['version:check', '--help']);
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['version:check', '-h']);
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['version:check']);
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(false);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['version:check', '--json']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['version:check', '-j']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['version:check']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(false);
    });

    it('parses all flags together', () => {
      const result = parseCliArguments([
        'version:check',
        '-d',
        '/tmp/vc.db',
        '-w',
        './wf.ts',
        '-j',
        '-h',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
      expect(result.workflows).toBe('./wf.ts');
      expect(result.json).toBe(true);
      expect(result.help).toBe(true);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['version:check', '--port', '8080'])).toThrow();
    });
  });

  describe('validate subcommand', () => {
    it('returns command validate when validate is the first positional', () => {
      const result = parseCliArguments(['validate']);
      expect(result.command).toBe('validate');
    });

    it('parses entry path as first positional argument', () => {
      const result = parseCliArguments(['validate', './my-workflow.ts']) as ValidateCommand;
      expect(result.command).toBe('validate');
      expect(result.entryPaths).toEqual(['./my-workflow.ts']);
    });

    it('parses multiple entry paths in order', () => {
      const result = parseCliArguments([
        'validate',
        './examples/one.ts',
        './examples/two.ts',
      ]) as ValidateCommand;
      expect(result.entryPaths).toEqual(['./examples/one.ts', './examples/two.ts']);
    });

    it('defaults entryPaths to an empty list when no positional is given', () => {
      const result = parseCliArguments(['validate']) as ValidateCommand;
      expect(result.entryPaths).toEqual([]);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['validate', 'entry.ts', '--json']) as ValidateCommand;
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['validate', 'entry.ts', '-j']) as ValidateCommand;
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['validate']) as ValidateCommand;
      expect(result.json).toBe(false);
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['validate', '--help']) as ValidateCommand;
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['validate', '-h']) as ValidateCommand;
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['validate']) as ValidateCommand;
      expect(result.help).toBe(false);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['validate', '--port', '8080'])).toThrow();
    });
  });

  describe('conformance subcommand', () => {
    it('returns command conformance when conformance is the first positional', () => {
      const result = parseCliArguments([
        'conformance',
        '--timeout',
        '2500',
        '--',
        'bun',
        'worker.ts',
      ]) as ConformanceCommand;
      expect(result.command).toBe('conformance');
      expect(result.timeoutMs).toBe(2500);
      expect(result.workerCommand).toEqual(['bun', 'worker.ts']);
    });

    it('parses conformance help and json flags', () => {
      const result = parseCliArguments(['conformance', '--json', '--help']) as ConformanceCommand;
      expect(result.command).toBe('conformance');
      expect(result.json).toBe(true);
      expect(result.help).toBe(true);
      expect(result.timeoutMs).toBe(15_000);
    });

    it('rejects invalid conformance timeout values', () => {
      expect(() => parseCliArguments(['conformance', '--timeout', '0'])).toThrow(
        '--timeout must be a positive integer number of milliseconds',
      );
    });
  });

  describe('timeline subcommand', () => {
    it('returns command timeline when timeline is the first positional', () => {
      const result = parseCliArguments(['timeline', 'wf-1']) as TimelineCommand;
      expect(result.command).toBe('timeline');
      expect(result.workflowId).toBe('wf-1');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --step for timeline', () => {
      const result = parseCliArguments(['timeline', 'wf-1', '--step', '2']) as TimelineCommand;
      expect(result.step).toBe(2);
    });

    it('parses --diff with two positional step numbers', () => {
      const result = parseCliArguments(['timeline', 'wf-1', '--diff', '1', '2']) as TimelineCommand;
      expect(result.diff).toEqual([1, 2]);
    });

    it('rejects invalid timeline step combinations and values', () => {
      expect(() => parseCliArguments(['timeline', 'wf-1', '--step=-1'])).toThrow(
        '--step must be a non-negative integer',
      );
      expect(() => parseCliArguments(['timeline', 'wf-1', '--diff'])).toThrow(
        '--diff requires two step numbers',
      );
      expect(() =>
        parseCliArguments(['timeline', 'wf-1', '--step', '2', '--diff', '1', '3']),
      ).toThrow('--step and --diff cannot be used together');
    });
  });

  describe('schedule subcommand', () => {
    it('parses schedule list', () => {
      const result = parseCliArguments(['schedule', 'list']) as ScheduleListCommand;
      expect(result.command).toBe('schedule');
      expect(result.action).toBe('list');
      expect(result.database).toBe('./weft.db');
      expect(result.storage).toBe('sqlite');
    });

    it('parses schedule storage backend flags', () => {
      const createResult = parseCliArguments([
        'schedule',
        'create',
        'echo',
        '0 * * * *',
        '--storage',
        'lmdb',
      ]) as ScheduleCreateCommand;
      expect(createResult.storage).toBe('lmdb');
    });

    it('rejects non-persistent memory storage for schedule commands', () => {
      expect(() => parseCliArguments(['schedule', 'list', '--storage', 'memory'])).toThrow(
        "Invalid storage backend 'memory'. Schedule commands support only sqlite and lmdb because data must persist across CLI invocations",
      );
    });

    it('allows schedule help to bypass storage validation', () => {
      const result = parseCliArguments([
        'schedule',
        '--help',
        '--storage',
        'memory',
      ]) as ScheduleListCommand;

      expect(result.command).toBe('schedule');
      expect(result.help).toBe(true);
    });

    it('parses schedule create with workflow module and cron expression', () => {
      const result = parseCliArguments([
        'schedule',
        'create',
        'echo',
        '0 * * * *',
        '--workflows',
        './workflows.ts',
        '--input',
        '{"payload":"nightly"}',
        '--id',
        'nightly-maintenance',
        '--overlap',
        'queue',
        '--backfill',
      ]) as ScheduleCreateCommand;

      expect(result.command).toBe('schedule');
      expect(result.action).toBe('create');
      expect(result.workflowType).toBe('echo');
      expect(result.cronExpression).toBe('0 * * * *');
      expect(result.workflows).toBe('./workflows.ts');
      expect(result.input).toBe('{"payload":"nightly"}');
      expect(result.id).toBe('nightly-maintenance');
      expect(result.overlap).toBe('queue');
      expect(result.backfill).toBe(true);
    });

    it('rejects invalid schedule overlap policies', () => {
      expect(() =>
        parseCliArguments([
          'schedule',
          'create',
          'echo',
          '0 * * * *',
          '--workflows',
          './workflows.ts',
          '--overlap',
          'parallel',
        ]),
      ).toThrow(
        "Invalid overlap policy 'parallel'. Must be one of: skip, queue, cancel-running, allow",
      );
    });

    it('parses schedule pause, resume, and cancel ids', () => {
      const pauseResult = parseCliArguments([
        'schedule',
        'pause',
        'schedule-1',
      ]) as ScheduleMutationCommand;
      expect(pauseResult.action).toBe('pause');
      expect(pauseResult.scheduleId).toBe('schedule-1');

      const resumeResult = parseCliArguments([
        'schedule',
        'resume',
        'schedule-1',
      ]) as ScheduleMutationCommand;
      expect(resumeResult.action).toBe('resume');
      expect(resumeResult.scheduleId).toBe('schedule-1');

      const cancelResult = parseCliArguments([
        'schedule',
        'cancel',
        'schedule-2',
      ]) as ScheduleMutationCommand;
      expect(cancelResult.action).toBe('cancel');
      expect(cancelResult.scheduleId).toBe('schedule-2');
    });

    it('rejects missing or unknown schedule actions', () => {
      expect(() => parseCliArguments(['schedule'])).toThrow(
        'Missing schedule action. Expected one of: list, create, pause, resume, cancel',
      );
      expect(() => parseCliArguments(['schedule', 'typo'])).toThrow(
        'Unknown schedule action "typo". Expected one of: list, create, pause, resume, cancel',
      );
    });

    it('rejects unexpected list positionals', () => {
      expect(() => parseCliArguments(['schedule', 'list', 'extra'])).toThrow(
        'schedule list does not accept positional arguments',
      );
    });

    it('rejects extra schedule create and mutation positionals', () => {
      expect(() => parseCliArguments(['schedule', 'create', 'echo', '0 * * * *', 'extra'])).toThrow(
        'schedule create expects exactly 2 positional arguments: <workflowType> <cronExpression>',
      );
      expect(() => parseCliArguments(['schedule', 'pause', 'schedule-1', 'extra'])).toThrow(
        'schedule pause expects exactly 1 positional argument: <scheduleId>',
      );
      expect(() => parseCliArguments(['schedule', 'resume', 'schedule-1', 'extra'])).toThrow(
        'schedule resume expects exactly 1 positional argument: <scheduleId>',
      );
      expect(() => parseCliArguments(['schedule', 'cancel', 'schedule-1', 'extra'])).toThrow(
        'schedule cancel expects exactly 1 positional argument: <scheduleId>',
      );
    });

    it('rejects missing schedule create and mutation positionals', () => {
      expect(() => parseCliArguments(['schedule', 'create', 'echo'])).toThrow(
        'schedule create expects exactly 2 positional arguments: <workflowType> <cronExpression>',
      );
      expect(() => parseCliArguments(['schedule', 'pause'])).toThrow(
        'schedule pause expects exactly 1 positional argument: <scheduleId>',
      );
      expect(() => parseCliArguments(['schedule', 'resume'])).toThrow(
        'schedule resume expects exactly 1 positional argument: <scheduleId>',
      );
      expect(() => parseCliArguments(['schedule', 'cancel'])).toThrow(
        'schedule cancel expects exactly 1 positional argument: <scheduleId>',
      );
    });
  });
});

describe('splitGlobPattern', () => {
  it('returns the original path when no glob characters are present', () => {
    expect(splitGlobPattern('examples/hello-world.ts')).toEqual({
      scanRoot: '.',
      pattern: 'examples/hello-world.ts',
    });
  });

  it('keeps the current directory as the scan root for top-level globs', () => {
    expect(splitGlobPattern('*.ts')).toEqual({
      scanRoot: '.',
      pattern: '*.ts',
    });
  });

  it('splits Windows-style absolute glob patterns into scan root and pattern', () => {
    expect(splitGlobPattern(String.raw`C:\work\examples\**\*.ts`)).toEqual({
      scanRoot: 'C:/work/examples',
      pattern: '**/*.ts',
    });
  });
});

describe('help text', () => {
  it('HELP_TEXT contains doctor subcommand', () => {
    expect(HELP_TEXT).toContain('doctor');
  });

  it('HELP_TEXT contains version:check subcommand', () => {
    expect(HELP_TEXT).toContain('version:check');
  });

  it('HELP_TEXT contains timeline subcommand', () => {
    expect(HELP_TEXT).toContain('timeline');
  });

  it('HELP_TEXT contains schedule subcommand', () => {
    expect(HELP_TEXT).toContain('schedule');
  });

  it('HELP_TEXT contains validate subcommand', () => {
    expect(HELP_TEXT).toContain('validate');
  });

  it('HELP_TEXT contains conformance subcommand', () => {
    expect(HELP_TEXT).toContain('conformance');
  });

  it('HELP_TEXT contains serve subcommand', () => {
    expect(HELP_TEXT).toContain('serve');
  });

  it('VALIDATE_HELP_TEXT contains exit codes section', () => {
    expect(VALIDATE_HELP_TEXT).toContain('Exit codes');
    expect(VALIDATE_HELP_TEXT).toContain('0');
    expect(VALIDATE_HELP_TEXT).toContain('1');
    expect(VALIDATE_HELP_TEXT).toContain('2');
  });

  it('VALIDATE_HELP_TEXT contains checks section', () => {
    expect(VALIDATE_HELP_TEXT).toContain('unbounded-retry');
    expect(VALIDATE_HELP_TEXT).toContain('stateful-without-compensator');
  });

  it('VALIDATE_HELP_TEXT contains --json and --help flags', () => {
    expect(VALIDATE_HELP_TEXT).toContain('--json');
    expect(VALIDATE_HELP_TEXT).toContain('--help');
  });

  it('VALIDATE_HELP_TEXT documents JSON output shape and load-error precedence', () => {
    expect(VALIDATE_HELP_TEXT).toContain('{ entries, valid, hasLoadErrors, hasValidationErrors }');
    expect(VALIDATE_HELP_TEXT).toContain('takes precedence over validation errors');
  });

  it('DOCTOR_HELP_TEXT contains --database flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--database');
  });

  it('DOCTOR_HELP_TEXT contains --json flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--json');
  });

  it('DOCTOR_HELP_TEXT contains --help flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--help');
  });

  it('VERSION_CHECK_HELP_TEXT contains --database flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--database');
  });

  it('VERSION_CHECK_HELP_TEXT contains --workflows flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--workflows');
  });

  it('VERSION_CHECK_HELP_TEXT contains --json flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--json');
  });

  it('VERSION_CHECK_HELP_TEXT contains --help flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--help');
  });

  it('CONFORMANCE_HELP_TEXT contains command, timeout, and worker environment details', () => {
    expect(CONFORMANCE_HELP_TEXT).toContain('weft conformance');
    expect(CONFORMANCE_HELP_TEXT).toContain('--timeout');
    expect(CONFORMANCE_HELP_TEXT).toContain('WEFT_WORKER_PROTOCOL_VERSION');
  });

  it('TIMELINE_HELP_TEXT contains --step and --diff flags', () => {
    expect(TIMELINE_HELP_TEXT).toContain('--step');
    expect(TIMELINE_HELP_TEXT).toContain('--diff');
    expect(TIMELINE_HELP_TEXT).toContain('--database');
  });

  it('SCHEDULE_HELP_TEXT contains list, create, pause, resume, and cancel', () => {
    expect(SCHEDULE_HELP_TEXT).toContain('schedule list');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule create');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule pause');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule resume');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule cancel');
    expect(SCHEDULE_HELP_TEXT).toContain('--storage');
    expect(SCHEDULE_HELP_TEXT).toContain('sqlite, lmdb');
    expect(SCHEDULE_HELP_TEXT).not.toContain('sqlite, lmdb, memory');
    expect(SCHEDULE_HELP_TEXT).toContain('--workflows');
  });

  it('HELP_TEXT documents --storage flag', () => {
    expect(HELP_TEXT).toContain('--storage');
  });

  it('HELP_TEXT documents --no-ui flag', () => {
    expect(HELP_TEXT).toContain('--no-ui');
  });

  it('HELP_TEXT lists all storage backends', () => {
    expect(HELP_TEXT).toContain('sqlite');
    expect(HELP_TEXT).toContain('lmdb');
    expect(HELP_TEXT).toContain('memory');
  });
});

describe('executeDoctor', () => {
  it('returns a formatted report for an in-memory database', async () => {
    const result = await executeDoctor({ database: ':memory:', json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Database:');
    expect(result.stdout).toContain('Workflows:');
    expect(result.stdout).toContain('Activities:');
    expect(result.stdout).toContain('Recommendations:');
  });

  it('returns JSON when json option is true', async () => {
    const result = await executeDoctor({ database: ':memory:', json: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });
});

describe('executeVersionCheck', () => {
  it('returns an error when workflows path is empty', async () => {
    const result = await executeVersionCheck({
      database: ':memory:',
      workflows: '',
      json: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workflows');
  });

  it('returns a JSON report for a valid workflows module', async () => {
    const database = join(tmpdir(), `weft-version-check-${crypto.randomUUID()}.db`);
    const workflows = join(tmpdir(), `weft-workflows-${crypto.randomUUID()}.ts`);
    const storage = await createStorage('sqlite', database);

    try {
      await storage.put(
        KEYS.workflow('wf-version-check'),
        encode({
          id: 'wf-version-check',
          type: 'order',
          status: 'running',
          input: null,
          version: '1.0.0',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      await Bun.write(
        workflows,
        [
          'export default {',
          '  order: {',
          '    version: "1.0.0",',
          '    handler: async function* () {',
          '      return null;',
          '    },',
          '  },',
          '};',
        ].join('\n'),
      );

      const workflowModule = await import(workflows);
      const registrations = workflowModule.default as Record<
        string,
        { handler: () => AsyncGenerator<unknown, unknown, unknown> }
      >;
      const generator = registrations['order']!.handler();
      await generator.next();

      const result = await executeVersionCheck({
        database,
        workflows,
        json: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBeUndefined();
      expect(JSON.parse(result.stdout)).toMatchObject({
        overallVerdict: 'safe',
        workflowTypes: [
          {
            type: 'order',
            storedVersion: '1.0.0',
            registeredVersion: '1.0.0',
          },
        ],
      });
    } finally {
      storage[Symbol.dispose]();
      rmSync(workflows, { force: true });
      rmSync(database, { force: true });
    }
  });
});

describe('CLI direct execution', () => {
  it('runs the CLI binary with --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--help');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('version:check');
  });

  it('runs the CLI binary with -h short flag and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '-h'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
  });

  it('runs doctor --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'doctor', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--json');
  });

  it('runs version:check --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'version:check', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('version:check');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--workflows');
    expect(stdout).toContain('--json');
  });

  it('runs conformance --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'conformance', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('conformance');
    expect(stdout).toContain('--timeout');
    expect(stdout).toContain('WEFT_WORKER_URL');
  });

  it('runs timeline --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'timeline', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('timeline');
    expect(stdout).toContain('--step');
    expect(stdout).toContain('--diff');
  });

  it('runs serve --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'serve', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--database');
  });

  it('rejects ignored serve positionals before starting the server', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', './workflows.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command './workflows.ts'");
  });

  it('rejects a misspelled subcommand before starting the server', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'timelin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command 'timelin'");
    expect(stderr).toContain("Did you mean 'timeline'?");
  });

  it('runs schedule --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'schedule', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('schedule list');
    expect(stdout).toContain('schedule create');
    expect(stdout).toContain('schedule pause');
    expect(stdout).toContain('schedule resume');
    expect(stdout).toContain('schedule cancel');
  });

  it('runs doctor against an in-memory database and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'doctor', '--database', ':memory:'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Database:');
    expect(stdout).toContain('Workflows:');
    expect(stdout).toContain('Activities:');
    expect(stdout).toContain('Recommendations:');
  });

  it('runs doctor with --json flag and outputs valid JSON', async () => {
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', 'doctor', '--database', ':memory:', '--json'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });

  it('exits with an error for an invalid storage backend', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--storage', 'postgres'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid storage backend 'postgres'");
  });

  it('exits with error when version:check is missing --workflows flag', async () => {
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', 'version:check', '--database', ':memory:'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--workflows');
  });

  it('starts the server and responds to health check', async () => {
    const port = 17233 + Math.floor(Math.random() * 1000);
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', '--port', String(port), '--database', ':memory:'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    try {
      await waitForCondition(
        async () => {
          try {
            const response = await fetch(`http://localhost:${port}/v1/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeoutMs: 3_000, intervalMs: 25, label: 'CLI health endpoint' },
      );
    } finally {
      process.kill('SIGTERM');
      await process.exited;
    }
  });

  it('accepts --storage flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help', '--storage', 'memory'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
  });

  it('accepts --no-ui flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help', '--no-ui'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
  });

  it('validates the bundled examples through the CLI entrypoint and exits 0', async () => {
    const childProcess = Bun.spawn(['bun', './src/cli-main.ts', 'validate', 'examples/**/*.ts'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await childProcess.exited;
    const stdout = await new Response(childProcess.stdout).text();
    const stderr = await new Response(childProcess.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('examples/hello-world.ts');
    expect(stdout).toContain('examples/customer-profile.ts');
    expect(stdout).toContain('No issues found.');
  });
});

describe('executeConformance', () => {
  it('returns exitCode 2 when the worker command is missing', async () => {
    const result = await executeConformance({
      timeoutMs: 500,
      json: false,
      workerCommand: [],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('worker command is required');
  });

  it('passes a conforming worker fixture', async () => {
    const result = await executeConformance({
      timeoutMs: 3_000,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-worker.ts'],
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'register',
      'task completion',
      'heartbeat',
      'cancellation',
      'reconnect',
      'graceful shutdown',
    ]);
  });

  it('formats conforming worker checks as plain text', async () => {
    const result = await executeConformance({
      timeoutMs: 3_000,
      json: false,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-worker.ts'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS register:');
    expect(result.stdout).toContain('PASS graceful shutdown:');
  });

  it('fails a worker fixture that omits protocolVersion', async () => {
    const result = await executeConformance({
      timeoutMs: 500,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-broken-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ ok: boolean }> };
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => !check.ok)).toBe(true);
  });

  it('formats failed checks as plain text when json output is disabled', async () => {
    const result = await executeConformance({
      timeoutMs: 500,
      json: false,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-broken-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAIL conformance:');
  });

  it('fails when the registered worker does not advertise the required activities', async () => {
    const result = await executeConformance({
      timeoutMs: 750,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-wrong-activities-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toEqual({
      name: 'conformance',
      ok: false,
      message: 'Timed out after 750ms waiting for conformance-echo to resolve as completed',
    });
  });

  it('surfaces a worker that disconnects before heartbeat readiness', async () => {
    const result = await executeConformance({
      timeoutMs: 1_000,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-register-exit-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toMatch(
      /^Worker register-exit-worker-[0-9a-f-]+ disconnected before heartbeat was observed$/,
    );
  });

  it('surfaces a replacement worker that disconnects before graceful shutdown', async () => {
    const launchStateFile = join(tmpdir(), `weft-short-sleep-exit-${crypto.randomUUID()}.txt`);
    const result = await executeConformance({
      timeoutMs: 1_000,
      json: true,
      workerCommand: [
        'env',
        'WEFT_SHORT_SLEEP_EXIT_MODE=replacement-disconnect',
        `WEFT_SHORT_SLEEP_EXIT_STATE_FILE=${launchStateFile}`,
        'bun',
        './src/cli/__fixtures__/conformance-short-sleep-exit-worker.ts',
      ],
    });
    rmSync(launchStateFile, { force: true });

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toContain('to become idle');
  });
});

describe('executeValidate', () => {
  it('returns exitCode 2 and stderr when no entry paths are provided', async () => {
    const result = await executeValidate({ entryPaths: [], json: false });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('entry file path is required');
    expect(result.stdout).toBe('');
  });

  it('returns exitCode 2 and stderr when entry file does not exist', async () => {
    const result = await executeValidate({
      entryPaths: ['/does/not/exist/entry.ts'],
      json: false,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('could not load entry file');
  });

  it('returns exitCode 0 and stdout with no-issues message for a clean module', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-validate-clean-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const myWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPaths: [entryPath], json: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found.');
      const loaded = await loadRegistrationsFromModule(entryPath);
      const iterator = loaded.registrations['myWorkflow']!.handler({} as never, undefined);
      await expect(iterator.next()).resolves.toEqual({ value: 'done', done: true });
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('returns exitCode 1 when an activity has unbounded retry', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-validate-error-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { ActivityDefinition } from "./src/core/types.ts";',
          'export const badActivity: ActivityDefinition = {',
          '  name: "badActivity",',
          '  execute: async (input: unknown) => input,',
          '  idempotent: true,',
          '  retry: { maxAttempts: Infinity, initialBackoff: "1s", backoffMultiplier: 2, maxBackoff: "30s" },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPaths: [entryPath], json: false });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('unbounded-retry');
      const loaded = await loadRegistrationsFromModule(entryPath);
      await expect(loaded.activities[0]!.execute('payload')).resolves.toBe('payload');
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('returns valid JSON when json: true', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-validate-json-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const myWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPaths: [entryPath], json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        valid: true,
        hasLoadErrors: false,
        hasValidationErrors: false,
        entries: [
          {
            entryPath,
            valid: true,
            issues: [],
            workflowCount: expect.any(Number),
          },
        ],
      });
      const loaded = await loadRegistrationsFromModule(entryPath);
      const iterator = loaded.registrations['myWorkflow']!.handler({} as never, undefined);
      await expect(iterator.next()).resolves.toEqual({ value: 'done', done: true });
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('returns exitCode 0 when multiple clean entry files validate', async () => {
    const firstEntryPath = join(tmpdir(), `weft-validate-multi-a-${crypto.randomUUID()}.ts`);
    const secondEntryPath = join(tmpdir(), `weft-validate-multi-b-${crypto.randomUUID()}.ts`);

    try {
      await Bun.write(
        firstEntryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const firstWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "first"; },',
          '};',
        ].join('\n'),
      );
      await Bun.write(
        secondEntryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const secondWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "second"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [firstEntryPath, secondEntryPath],
        json: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(firstEntryPath);
      expect(result.stdout).toContain(secondEntryPath);
      expect(result.stdout).toContain('No issues found.');
    } finally {
      rmSync(firstEntryPath, { force: true });
      rmSync(secondEntryPath, { force: true });
    }
  });

  it('returns exitCode 0 for the bundled examples validation gate', async () => {
    const result = await executeValidate({
      entryPaths: ['examples/**/*.ts'],
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.indexOf('examples/customer-profile.ts')).toBeLessThan(
      result.stdout.indexOf('examples/hello-world.ts'),
    );
    expect(result.stdout).toContain('examples/hello-world.ts');
    expect(result.stdout).toContain('examples/customer-profile.ts');
  });

  it('expands absolute glob patterns for bundled example validation', async () => {
    const result = await executeValidate({
      entryPaths: [join(process.cwd(), 'examples/**/*.ts')],
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(join(process.cwd(), 'examples/customer-profile.ts'));
    expect(result.stdout).toContain(join(process.cwd(), 'examples/hello-world.ts'));
  });

  it('normalizes Windows-style glob separators for bundled example validation', async () => {
    const result = await executeValidate({
      entryPaths: [String.raw`examples\**\*.ts`],
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('examples/customer-profile.ts');
    expect(result.stdout).toContain('examples/hello-world.ts');
  });

  it('deduplicates validate entries when a glob and explicit path match the same file', async () => {
    const result = await executeValidate({
      entryPaths: ['examples/**/*.ts', 'examples/hello-world.ts'],
      json: true,
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      entries: Array<{ entryPath: string }>;
      valid: boolean;
      hasLoadErrors: boolean;
      hasValidationErrors: boolean;
    };

    expect(parsed).toMatchObject({
      valid: true,
      hasLoadErrors: false,
      hasValidationErrors: false,
    });
    const validatedEntryPaths = parsed.entries.map((entry) => entry.entryPath);
    expect(validatedEntryPaths).toContain('examples/customer-profile.ts');
    expect(validatedEntryPaths).toContain('examples/hello-world.ts');
    expect(validatedEntryPaths).toContain('examples/order-processing/src/workflows/order.ts');
    expect(new Set(validatedEntryPaths).size).toBe(validatedEntryPaths.length);
  });

  it('prunes nested node_modules directories before expanding validation globs', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-glob-prune-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples', 'order-processing');
    const nestedPackagePath = join(examplePath, 'node_modules', 'weft', 'examples', 'recursive');

    try {
      mkdirSync(nestedPackagePath, { recursive: true });
      await Bun.write(join(examplePath, 'src.ts'), 'export const workflow = "clean";');
      await Bun.write(
        join(examplePath, 'src.test.ts'),
        'throw new Error("test file should be ignored");',
      );
      await Bun.write(
        join(nestedPackagePath, 'bad.ts'),
        'throw new Error("node_modules should be ignored");',
      );

      await expect(
        expandGlobEntryPaths([join(workspacePath, 'examples/**/*.ts')]),
      ).resolves.toEqual([join(workspacePath, 'examples/order-processing/src.ts')]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('includes test files when validation globs explicitly target tests', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-explicit-test-glob-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples', 'order-processing');

    try {
      mkdirSync(examplePath, { recursive: true });
      await Bun.write(join(examplePath, 'src.ts'), 'export const workflow = "clean";');
      await Bun.write(join(examplePath, 'src.test.ts'), 'export const testWorkflow = "clean";');

      await expect(
        expandGlobEntryPaths([join(workspacePath, 'examples/**/*.test.ts')]),
      ).resolves.toEqual([join(workspacePath, 'examples/order-processing/src.test.ts')]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('includes test files when validation globs explicitly target a tests directory', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-tests-directory-${crypto.randomUUID()}`);
    const testsPath = join(workspacePath, 'examples', 'order-processing', 'tests');

    try {
      mkdirSync(testsPath, { recursive: true });
      await Bun.write(
        join(testsPath, 'order-processing.test.ts'),
        'export const workflow = "test";',
      );

      await expect(
        expandGlobEntryPaths([join(workspacePath, 'examples/**/tests/**/*.ts')]),
      ).resolves.toEqual([
        join(workspacePath, 'examples/order-processing/tests/order-processing.test.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('includes test files when the scan root explicitly targets a tests directory', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-tests-scanroot-${crypto.randomUUID()}`);
    const testsPath = join(workspacePath, 'examples', 'order-processing', 'tests');

    try {
      mkdirSync(testsPath, { recursive: true });
      await Bun.write(
        join(testsPath, 'order-processing.test.ts'),
        'export const workflow = "test";',
      );

      await expect(
        expandGlobEntryPaths([join(workspacePath, 'examples/order-processing/tests/**/*.ts')]),
      ).resolves.toEqual([
        join(workspacePath, 'examples/order-processing/tests/order-processing.test.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('does not infer test-file intent from absolute checkout path segments', async () => {
    const workspacePath = join(tmpdir(), `weft-test-parent-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples', 'order-processing');

    try {
      mkdirSync(examplePath, { recursive: true });
      await Bun.write(join(examplePath, 'src.ts'), 'export const workflow = "clean";');
      await Bun.write(join(examplePath, 'src.test.ts'), 'export const testWorkflow = "clean";');

      await expect(
        expandGlobEntryPaths([join(workspacePath, 'examples/**/*.ts')]),
      ).resolves.toEqual([join(workspacePath, 'examples/order-processing/src.ts')]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('does not return a literal glob when all matches are intentionally ignored', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-ignored-only-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples');

    try {
      mkdirSync(examplePath, { recursive: true });
      await Bun.write(join(examplePath, 'only.test.ts'), 'export const testWorkflow = "clean";');

      await expect(expandGlobEntryPaths([join(workspacePath, 'examples/*.ts')])).resolves.toEqual(
        [],
      );
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('reports a validation load error instead of throwing when a glob root is missing', async () => {
    const missingGlobPath = join(
      tmpdir(),
      `weft-validate-missing-glob-${crypto.randomUUID()}`,
      'examples/**/*.ts',
    );

    const result = await executeValidate({
      entryPaths: [missingGlobPath],
      json: true,
    });

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      entries: Array<{ entryPath: string; loadError?: string }>;
      hasLoadErrors: boolean;
    };
    expect(parsed.hasLoadErrors).toBe(true);
    expect(parsed.entries[0]).toMatchObject({
      entryPath: missingGlobPath,
    });
    expect(parsed.entries[0]?.loadError).toContain('Cannot find module');
  });

  it('returns exitCode 2 when a clean entry and a missing entry are validated together', async () => {
    const cleanEntryPath = join(tmpdir(), `weft-validate-mixed-clean-${crypto.randomUUID()}.ts`);

    try {
      await Bun.write(
        cleanEntryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const cleanWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "clean"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [cleanEntryPath, '/does/not/exist/entry.ts'],
        json: false,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain(cleanEntryPath);
      expect(result.stdout).toContain('No issues found.');
      expect(result.stderr).toContain('/does/not/exist/entry.ts');
    } finally {
      rmSync(cleanEntryPath, { force: true });
    }
  });

  it('returns exitCode 1 when a clean entry and an invalid entry are validated together', async () => {
    const cleanEntryPath = join(tmpdir(), `weft-validate-mixed-clean-${crypto.randomUUID()}.ts`);
    const invalidEntryPath = join(
      tmpdir(),
      `weft-validate-mixed-invalid-${crypto.randomUUID()}.ts`,
    );

    try {
      await Bun.write(
        cleanEntryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const cleanWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "clean"; },',
          '};',
        ].join('\n'),
      );
      await Bun.write(
        invalidEntryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          `import { activity } from "${publicEntryPointUrl}";`,
          'export const sendEmail = activity({',
          '  name: "sendEmail",',
          '  idempotent: false,',
          '  execute: async () => undefined,',
          '});',
          'export const invalidWorkflow: WorkflowRegistration = {',
          '  handler: async function* (_ctx, input) {',
          '    return yield* sendEmail(input);',
          '  },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [cleanEntryPath, invalidEntryPath],
        json: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(cleanEntryPath);
      expect(result.stdout).toContain(invalidEntryPath);
      expect(result.stdout).toContain('stateful-without-compensator');
      expect(result.stderr).toBeUndefined();
    } finally {
      rmSync(cleanEntryPath, { force: true });
      rmSync(invalidEntryPath, { force: true });
    }
  });

  it('returns a stable JSON envelope for mixed load and validation outcomes', async () => {
    const invalidEntryPath = join(tmpdir(), `weft-validate-json-invalid-${crypto.randomUUID()}.ts`);

    try {
      await Bun.write(
        invalidEntryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          `import { activity } from "${publicEntryPointUrl}";`,
          'export const sendEmail = activity({',
          '  name: "sendEmail",',
          '  idempotent: false,',
          '  execute: async () => undefined,',
          '});',
          'export const invalidWorkflow: WorkflowRegistration = {',
          '  handler: async function* (_ctx, input) {',
          '    return yield* sendEmail(input);',
          '  },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [invalidEntryPath, '/does/not/exist/entry.ts'],
        json: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBeUndefined();
      expect(JSON.parse(result.stdout)).toMatchObject({
        valid: false,
        hasLoadErrors: true,
        hasValidationErrors: true,
        entries: [
          {
            entryPath: invalidEntryPath,
            valid: false,
            issues: [
              expect.objectContaining({
                code: 'stateful-without-compensator',
              }),
            ],
          },
          {
            entryPath: '/does/not/exist/entry.ts',
            loadError: expect.any(String),
          },
        ],
      });
    } finally {
      rmSync(invalidEntryPath, { force: true });
    }
  });
});

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
    const { Engine } = await import('./core/engine.ts');
    const engine = new Engine({ storage, checkpointHistory: 10 });

    try {
      async function firstCliStep() {
        return { apiKey: 'sk-cli-secret', phase: 'first' as const };
      }

      async function secondCliStep() {
        return { phase: 'second' as const };
      }

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
    const { Engine } = await import('./core/engine.ts');
    const engine = new Engine({ storage, checkpointHistory: 10 });

    try {
      async function prepareCliFailure() {
        return { phase: 'prepared' as const };
      }

      async function failCliTimeline() {
        throw new Error('cli timeline failure');
      }

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
    const { Engine } = await import('./core/engine.ts');
    const engine = new Engine({ storage });

    try {
      const timelineMissing = workflow({ name: 'timeline-missing' }).execute(async function* () {
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

describe('executeSchedule', () => {
  it('lists, creates, pauses, resumes, and cancels schedules against a SQLite database', async () => {
    const database = join(tmpdir(), `weft-schedule-${crypto.randomUUID()}.db`);
    const workflows = join(tmpdir(), `weft-schedule-workflows-${crypto.randomUUID()}.ts`);

    await Bun.write(
      workflows,
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

    const storage = await createStorage('sqlite', database);
    const { Engine } = await import('./core/engine.ts');
    let engine = new Engine({ storage });

    try {
      const scheduledEcho = workflow({ name: 'scheduledEcho' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
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
      expect(listResult.stdout).toContain('ID | Workflow Type | Status | Cron | Next Fire');

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
          }),
        );
      } finally {
        await engine[Symbol.asyncDispose]();
        verificationStorage[Symbol.dispose]();
      }
    } finally {
      rmSync(workflows, { force: true });
      rmSync(database, { force: true });
    }
  });

  it('uses the selected storage backend for schedule commands', async () => {
    const database = join(tmpdir(), `weft-schedule-lmdb-${crypto.randomUUID()}`);
    const workflows = join(tmpdir(), `weft-schedule-lmdb-workflows-${crypto.randomUUID()}.ts`);

    await Bun.write(
      workflows,
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
      const { Engine } = await import('./core/engine.ts');
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
      rmSync(workflows, { force: true });
      rmSync(database, { recursive: true, force: true });
    }
  });

  it('rejects memory storage for schedule commands before creating a fresh in-memory backend', async () => {
    const result = await executeSchedule({
      command: 'schedule',
      action: 'list',
      database: ':memory:',
      storage: 'memory' as never,
      help: false,
      json: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'Error: --storage memory is not supported for schedule commands because data does not persist across CLI invocations',
    );
  });

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

      const missingWorkflowTypeResult = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        workflows: './workflows.ts',
        cronExpression: '0 * * * *',
        input: 'null',
        backfill: false,
      } as ScheduleCreateCommand);
      expect(missingWorkflowTypeResult).toEqual({
        stdout: '',
        stderr: 'Error: missing required argument <workflowType> for schedule create',
        exitCode: 1,
      });

      const missingCronExpressionResult = await executeSchedule({
        command: 'schedule',
        action: 'create',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
        workflows: './workflows.ts',
        workflowType: 'scheduledEcho',
        input: 'null',
        backfill: false,
      } as ScheduleCreateCommand);
      expect(missingCronExpressionResult).toEqual({
        stdout: '',
        stderr: 'Error: missing required argument <cronExpression> for schedule create',
        exitCode: 1,
      });

      const missingScheduleIdResult = await executeSchedule({
        command: 'schedule',
        action: 'pause',
        database,
        storage: 'sqlite',
        help: false,
        json: false,
      } as ScheduleMutationCommand);
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
    const workflows = join(tmpdir(), `weft-schedule-input-${crypto.randomUUID()}.ts`);

    await Bun.write(
      workflows,
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
      rmSync(workflows, { force: true });
      rmSync(database, { force: true });
    }
  });

  it('surfaces schedule execution failures through the shared schedule error path', async () => {
    const database = join(tmpdir(), `weft-schedule-error-${crypto.randomUUID()}.db`);
    const workflows = join(tmpdir(), `weft-schedule-error-${crypto.randomUUID()}.ts`);

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
      rmSync(workflows, { force: true });
      rmSync(database, { force: true });
    }
  });
});

describe('loadRegistrationsFromModule', () => {
  it('extracts WorkflowRegistration from named exports', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-load-named-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { WorkflowRegistration } from "./src/diagnostics/validate.ts";',
          'export const myWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );
      const result = await loadRegistrationsFromModule(entryPath);
      expect('myWorkflow' in result.registrations).toBe(true);
      expect(result.activities).toHaveLength(0);
      const iterator = result.registrations['myWorkflow']!.handler({} as never, undefined);
      await expect(iterator.next()).resolves.toEqual({ value: 'done', done: true });
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('extracts ActivityDefinition from named exports', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-load-activity-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { ActivityDefinition } from "./src/core/types.ts";',
          'export const sendEmail: ActivityDefinition = {',
          '  name: "sendEmail",',
          '  execute: async (input: unknown) => input,',
          '};',
        ].join('\n'),
      );
      const result = await loadRegistrationsFromModule(entryPath);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]!.name).toBe('sendEmail');
      await expect(result.activities[0]!.execute('payload')).resolves.toBe('payload');
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('rejects with an error for a non-existent file', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    await expect(loadRegistrationsFromModule('/does/not/exist/workflow.ts')).rejects.toThrow();
  });

  it('returns empty registrations and activities for a module with no matching exports', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-load-empty-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(entryPath, 'export const foo = 42;\n');
      const result = await loadRegistrationsFromModule(entryPath);
      expect(Object.keys(result.registrations)).toHaveLength(0);
      expect(result.activities).toHaveLength(0);
    } finally {
      rmSync(entryPath, { force: true });
    }
  });
});

describe('createStorage', () => {
  it('creates BunSQLiteStorage for sqlite backend', async () => {
    const storage = await createStorage('sqlite', ':memory:');
    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();
  });

  it('creates MemoryStorage for memory backend', async () => {
    const storage = await createStorage('memory', './unused.db');
    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();
  });

  it('creates LMDBStorage for lmdb backend', async () => {
    const path = join(
      tmpdir(),
      `lmdb-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const storage = await createStorage('lmdb', path);

    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();

    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('returns storage implementing get/put/delete/scan', async () => {
    const storage = await createStorage('memory', '');

    await storage.put('test-key', new Uint8Array([1, 2, 3]));
    const result = await storage.get('test-key');
    expect(result).toEqual(new Uint8Array([1, 2, 3]));

    await storage.delete('test-key');
    const deleted = await storage.get('test-key');
    expect(deleted).toBeNull();

    storage[Symbol.dispose]();
  });
});
