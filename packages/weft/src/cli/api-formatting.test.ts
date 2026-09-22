import { describe, expect, it } from 'bun:test';

import { formatAccess } from './api.ts';
import { parseCliArguments } from './parse-arguments.ts';
import { findCliSubcommandName } from './subcommand-detection.ts';

describe('api access formatting', () => {
  it('formats every catalog access shape', () => {
    expect(formatAccess({ kind: 'public' })).toBe('public');
    expect(formatAccess({ kind: 'authenticated' })).toBe('authenticated');
    expect(formatAccess({ kind: 'scoped', scopes: ['events:read', 'workflows:read'] })).toBe(
      'events:read,workflows:read',
    );
    expect(formatAccess({ kind: 'optionalAuth', scopes: ['events:read'] })).toBe(
      'optional:events:read',
    );
    expect(
      formatAccess({
        kind: 'scopedAlternatives',
        alternatives: [['events:read', 'workflows:read'], ['streams:read']],
      }),
    ).toBe('events:read&workflows:read|streams:read');
  });
});

describe('api argument parser', () => {
  it('parses list, describe, input, and confirmation flags', () => {
    expect(parseCliArguments(['api', '--list', '--json'])).toEqual({
      command: 'api',
      list: true,
      yes: false,
      help: false,
      json: true,
    });

    expect(parseCliArguments(['api', '--describe', 'weft.workflows.list'])).toEqual({
      command: 'api',
      describe: 'weft.workflows.list',
      list: false,
      yes: false,
      help: false,
      json: false,
    });

    expect(parseCliArguments(['--describe', 'weft.workflows.list', 'api'])).toEqual({
      command: 'api',
      describe: 'weft.workflows.list',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(findCliSubcommandName(['--describe', 'api', 'doctor'])).toBe('doctor');

    expect(
      parseCliArguments([
        'api',
        'weft.workflows.cancel',
        '--input',
        '{"workflowId":"wf"}',
        '--yes',
        '--profile',
        'local',
      ]),
    ).toMatchObject({
      command: 'api',
      operationName: 'weft.workflows.cancel',
      input: '{"workflowId":"wf"}',
      yes: true,
      profile: 'local',
    });
  });

  it('rejects ambiguous input sources', () => {
    expect(() =>
      parseCliArguments(['api', 'weft.workflows.list', '--input', '{}', '--input-file', 'in.json']),
    ).toThrow(/--input and --input-file/);
  });

  it('rejects conflicting list and describe selectors and ignores flag-only argv', () => {
    expect(() => parseCliArguments(['api', '--list', '--describe', 'weft.workflows.list'])).toThrow(
      /--list cannot be combined/,
    );
    expect(findCliSubcommandName(['--describe', 'weft.workflows.list'])).toBeUndefined();
  });
});
