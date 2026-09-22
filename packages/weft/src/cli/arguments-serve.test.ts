import { describe, expect, it } from 'bun:test';
import { parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('default subcommand (serve)', () => {
    it('defaults to serve when no subcommand is provided', () => {
      const result = parseCliArguments([]);
      expect(result.command).toBe('serve');
    });

    it('parses --port flag', () => {
      const result = parseCliArguments(['--port', '8080']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.port).toBe('8080');
    });

    it('parses -p short flag for port', () => {
      const result = parseCliArguments(['-p', '9999']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.port).toBe('9999');
    });

    it('parses --workflows flag', () => {
      const result = parseCliArguments(['--workflows', './my-workflows.ts']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.workflows).toBe('./my-workflows.ts');
    });

    it('parses -w short flag for workflows', () => {
      const result = parseCliArguments(['-w', './workflows.ts']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.workflows).toBe('./workflows.ts');
    });

    it('parses serve -w short flag for workflows', () => {
      const result = parseCliArguments(['serve', '-w', './x']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.workflows).toBe('./x');
    });

    it('throws when --workflows is an empty string', () => {
      expect(() => parseCliArguments(['--workflows', ''])).toThrow(
        '--workflows must be a non-empty path',
      );
    });

    it('defaults workflows to undefined when not provided', () => {
      const result = parseCliArguments([]);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.workflows).toBeUndefined();
    });

    it('defaults port to 7233', () => {
      const result = parseCliArguments([]);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.port).toBe('7233');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments(['--database', '/tmp/test.db']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/test.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['-d', '/tmp/other.db']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/other.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments([]);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['--help']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.help).toBe(true);
    });

    it('rejects removed console flags', () => {
      expect(() => parseCliArguments(['serve', '--console'])).toThrow('Unknown option');
      expect(() => parseCliArguments(['serve', '--console-path', '/tmp/build'])).toThrow(
        'Unknown option',
      );
    });

    it('defaults help to false', () => {
      const result = parseCliArguments([]);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.help).toBe(false);
    });

    it('parses multiple flags together', () => {
      const result = parseCliArguments(['--port', '3000', '--database', '/var/weft.db']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.port).toBe('3000');
      expect(result.database).toBe('/var/weft.db');
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['-h']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.help).toBe(true);
    });

    it('parses explicit serve subcommand arguments', () => {
      const result = parseCliArguments(['serve', '--port', '5000']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.port).toBe('5000');
    });

    it('rejects positional arguments for serve mode instead of silently ignoring them', () => {
      expect(() => parseCliArguments(['./workflows.ts', '--port', '5000'])).toThrow();
    });

    it('parses --storage flag with sqlite', () => {
      const result = parseCliArguments(['--storage', 'sqlite']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('sqlite');
    });

    it('parses --storage flag with lmdb', () => {
      const result = parseCliArguments(['--storage', 'lmdb']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('lmdb');
    });

    it('parses --storage flag with memory', () => {
      const result = parseCliArguments(['--storage', 'memory']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('memory');
    });

    it('throws for an invalid storage backend', () => {
      expect(() => parseCliArguments(['--storage', 'postgres'])).toThrow(
        "Invalid storage backend 'postgres'",
      );
    });

    it('parses -s short flag for storage', () => {
      const result = parseCliArguments(['-s', 'lmdb']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('lmdb');
    });

    it('defaults storage to sqlite', () => {
      const result = parseCliArguments([]);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.storage).toBe('sqlite');
    });

    it('rejects --no-ui now that the bundled dashboard is removed', () => {
      expect(() => parseCliArguments(['--no-ui'])).toThrow('Unknown option');
    });

    it('parses all flags combined', () => {
      const result = parseCliArguments(['-p', '4000', '-d', '/tmp/all.db', '-s', 'memory', '-h']);
      if (result.command !== 'serve') throw new Error('Unexpected command variant');
      expect(result.command).toBe('serve');
      expect(result.port).toBe('4000');
      expect(result.database).toBe('/tmp/all.db');
      expect(result.storage).toBe('memory');
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
});
