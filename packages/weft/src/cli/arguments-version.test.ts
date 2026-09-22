import { describe, expect, it } from 'bun:test';
import { VERSION } from '../index.ts';
import { executeVersion, parseCliArguments } from './index.ts';

describe('CLI argument parsing', () => {
  describe('version request', () => {
    it('parses --version as a leading flag', () => {
      const result = parseCliArguments(['--version']);
      expect(result.command).toBe('version');
    });

    it('parses -v as a leading short flag', () => {
      const result = parseCliArguments(['-v']);
      expect(result.command).toBe('version');
    });

    it('parses the bare version subcommand', () => {
      const result = parseCliArguments(['version']);
      expect(result.command).toBe('version');
    });

    it('ignores tokens after the leading version request', () => {
      const result = parseCliArguments(['version', '--port', '9000']);
      expect(result.command).toBe('version');
    });

    it('does not honor --version after a real subcommand', () => {
      // A subcommand owns its own option line: serve rejects --version as an
      // unknown option rather than silently short-circuiting to the version.
      expect(() => parseCliArguments(['serve', '--version'])).toThrow('Unknown option');
    });

    it('does not honor -v after a real subcommand', () => {
      // The short flag has the same leading-only semantics as --version.
      expect(() => parseCliArguments(['serve', '-v'])).toThrow('Unknown option');
    });

    it('lets a leading version request win over a trailing --help', () => {
      // The leading token short-circuits before any per-command --help handling.
      const result = parseCliArguments(['--version', '--help']);
      expect(result.command).toBe('version');
    });

    it('executeVersion prints the exported VERSION constant and exits 0', () => {
      const result = executeVersion();
      expect(result.stdout).toBe(VERSION);
      expect(result.exitCode).toBe(0);
    });
  });
});
