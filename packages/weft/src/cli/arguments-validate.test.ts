import { describe, expect, it } from 'bun:test';
import { parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('validate subcommand', () => {
    it('returns command validate when validate is the first positional', () => {
      const result = parseCliArguments(['validate']);
      expect(result.command).toBe('validate');
    });

    it('parses entry path as first positional argument', () => {
      const result = parseCliArguments(['validate', './my-workflow.ts']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.command).toBe('validate');
      expect(result.entryPaths).toEqual(['./my-workflow.ts']);
    });

    it('parses multiple entry paths in order', () => {
      const result = parseCliArguments(['validate', './examples/one.ts', './examples/two.ts']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.entryPaths).toEqual(['./examples/one.ts', './examples/two.ts']);
    });

    it('defaults entryPaths to an empty list when no positional is given', () => {
      const result = parseCliArguments(['validate']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.entryPaths).toEqual([]);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['validate', 'entry.ts', '--json']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['validate', 'entry.ts', '-j']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['validate']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.json).toBe(false);
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['validate', '--help']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['validate', '-h']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['validate']);
      if (result.command !== 'validate') throw new Error('Unexpected command variant');
      expect(result.help).toBe(false);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['validate', '--port', '8080'])).toThrow();
    });
  });
});
