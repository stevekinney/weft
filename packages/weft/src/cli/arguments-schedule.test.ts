import { describe, expect, it } from 'bun:test';
import { parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('schedule subcommand', () => {
    it('parses schedule list', () => {
      const result = parseCliArguments(['schedule', 'list']);
      if (result.command !== 'schedule' || result.action !== 'list')
        throw new Error('Unexpected command variant');
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
      ]);
      if (createResult.command !== 'schedule' || createResult.action !== 'create')
        throw new Error('Unexpected command variant');
      expect(createResult.storage).toBe('lmdb');
    });

    it('rejects non-persistent memory storage for schedule commands', () => {
      expect(() => parseCliArguments(['schedule', 'list', '--storage', 'memory'])).toThrow(
        "Invalid storage backend 'memory'. Schedule commands support only sqlite and lmdb because data must persist across CLI invocations",
      );
    });

    it('allows schedule help to bypass storage validation', () => {
      const result = parseCliArguments(['schedule', '--help', '--storage', 'memory']);
      if (result.command !== 'schedule' || result.action !== 'list')
        throw new Error('Unexpected command variant');

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
        '--jitter',
        '45s',
      ]);
      if (result.command !== 'schedule' || result.action !== 'create')
        throw new Error('Unexpected command variant');

      expect(result.command).toBe('schedule');
      expect(result.action).toBe('create');
      expect(result.workflowType).toBe('echo');
      expect(result.cronExpression).toBe('0 * * * *');
      expect(result.workflows).toBe('./workflows.ts');
      expect(result.input).toBe('{"payload":"nightly"}');
      expect(result.id).toBe('nightly-maintenance');
      expect(result.overlap).toBe('queue');
      expect(result.backfill).toBe(true);
      expect(result.jitter).toBe('45s');
    });

    it('parses --revision-policy on schedule create (WFT-20)', () => {
      const result = parseCliArguments([
        'schedule',
        'create',
        'echo',
        '0 * * * *',
        '--workflows',
        './workflows.ts',
        '--revision-policy',
        'pinned',
      ]);
      if (result.command !== 'schedule' || result.action !== 'create')
        throw new Error('Unexpected command variant');

      expect(result.revisionPolicy).toBe('pinned');
    });

    it('omits revisionPolicy when --revision-policy is not supplied', () => {
      const result = parseCliArguments([
        'schedule',
        'create',
        'echo',
        '0 * * * *',
        '--workflows',
        './workflows.ts',
      ]);
      if (result.command !== 'schedule' || result.action !== 'create')
        throw new Error('Unexpected command variant');

      expect(result.revisionPolicy).toBeUndefined();
    });

    it('rejects an unknown --revision-policy value', () => {
      expect(() =>
        parseCliArguments([
          'schedule',
          'create',
          'echo',
          '0 * * * *',
          '--workflows',
          './workflows.ts',
          '--revision-policy',
          'sometimes',
        ]),
      ).toThrow("Invalid revision policy 'sometimes'. Must be one of: active-at-fire, pinned");
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
      const pauseResult = parseCliArguments(['schedule', 'pause', 'schedule-1']);
      if (pauseResult.command !== 'schedule' || pauseResult.action !== 'pause')
        throw new Error('Unexpected command variant');
      expect(pauseResult.action).toBe('pause');
      expect(pauseResult.scheduleId).toBe('schedule-1');

      const resumeResult = parseCliArguments(['schedule', 'resume', 'schedule-1']);
      if (resumeResult.command !== 'schedule' || resumeResult.action !== 'resume')
        throw new Error('Unexpected command variant');
      expect(resumeResult.action).toBe('resume');
      expect(resumeResult.scheduleId).toBe('schedule-1');

      const cancelResult = parseCliArguments(['schedule', 'cancel', 'schedule-2']);
      if (cancelResult.command !== 'schedule' || cancelResult.action !== 'cancel')
        throw new Error('Unexpected command variant');
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
