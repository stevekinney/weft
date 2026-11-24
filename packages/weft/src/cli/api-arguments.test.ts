import { describe, expect, it } from 'bun:test';

import { parseApiArguments } from './api-arguments.ts';

describe('parseApiArguments --dry-run', () => {
  it('is off unless given, and on with the flag', () => {
    expect(parseApiArguments(['weft.workflows.purge'])).not.toHaveProperty('dryRun');
    expect(parseApiArguments(['weft.workflows.purge', '--dry-run'])).toMatchObject({
      operationName: 'weft.workflows.purge',
      dryRun: true,
    });
  });

  it('cannot be combined with --list or --describe', () => {
    expect(() => parseApiArguments(['--list', '--dry-run'])).toThrow('--dry-run');
    expect(() => parseApiArguments(['--describe', 'weft.workflows.purge', '--dry-run'])).toThrow(
      '--dry-run',
    );
  });
});
