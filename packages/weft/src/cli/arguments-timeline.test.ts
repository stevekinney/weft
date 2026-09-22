import { describe, expect, it } from 'bun:test';
import { parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('timeline subcommand', () => {
    it('returns command timeline when timeline is the first positional', () => {
      const result = parseCliArguments(['timeline', 'wf-1']);
      if (result.command !== 'timeline') throw new Error('Unexpected command variant');
      expect(result.command).toBe('timeline');
      expect(result.workflowId).toBe('wf-1');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --step for timeline', () => {
      const result = parseCliArguments(['timeline', 'wf-1', '--step', '2']);
      if (result.command !== 'timeline') throw new Error('Unexpected command variant');
      expect(result.step).toBe(2);
    });

    it('parses --diff with two positional step numbers', () => {
      const result = parseCliArguments(['timeline', 'wf-1', '--diff', '1', '2']);
      if (result.command !== 'timeline') throw new Error('Unexpected command variant');
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
});
