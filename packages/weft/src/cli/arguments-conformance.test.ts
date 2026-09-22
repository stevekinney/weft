import { describe, expect, it } from 'bun:test';
import { parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('conformance subcommand', () => {
    it('returns command conformance when conformance is the first positional', () => {
      const result = parseCliArguments([
        'conformance',
        '--timeout',
        '2500',
        '--',
        'bun',
        'worker.ts',
      ]);
      if (result.command !== 'conformance') throw new Error('Unexpected command variant');
      expect(result.command).toBe('conformance');
      expect(result.timeoutMs).toBe(2500);
      expect(result.workerCommand).toEqual(['bun', 'worker.ts']);
    });

    it('parses conformance help and json flags', () => {
      const result = parseCliArguments(['conformance', '--json', '--help']);
      if (result.command !== 'conformance') throw new Error('Unexpected command variant');
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
});
