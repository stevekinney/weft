import { describe, expect, it } from 'bun:test';
import { parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('version:check subcommand', () => {
    it('returns command version:check when version:check is the first positional', () => {
      const result = parseCliArguments(['version:check']);
      expect(result.command).toBe('version:check');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments(['version:check', '--database', '/tmp/vc.db']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['version:check', '-d', '/tmp/vc.db']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['version:check']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --workflows flag', () => {
      const result = parseCliArguments(['version:check', '--workflows', './workflows.ts']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('./workflows.ts');
    });

    it('parses -w short flag for workflows', () => {
      const result = parseCliArguments(['version:check', '-w', './wf.ts']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('./wf.ts');
    });

    it('defaults workflows to empty string', () => {
      const result = parseCliArguments(['version:check']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['version:check', '--help']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['version:check', '-h']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['version:check']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(false);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['version:check', '--json']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['version:check', '-j']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['version:check']);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
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
      ]);
      if (result.command !== 'version:check') throw new Error('Unexpected command variant');
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
});
