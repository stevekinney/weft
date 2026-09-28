import { describe, expect, it } from 'bun:test';

import { parseCliArguments } from './parse-arguments.ts';

describe('worker argument parsing', () => {
  it('parses worker verify with manifest, registry snapshot, and json output', () => {
    const parsed = parseCliArguments([
      'worker',
      'verify',
      '--manifest',
      'worker-manifest.json',
      '--from',
      'registry.json',
      '--json',
    ]);

    expect(parsed).toEqual({
      command: 'worker',
      action: 'verify',
      manifest: 'worker-manifest.json',
      from: 'registry.json',
      help: false,
      json: true,
    });
  });

  it('allows worker verify help without required file paths', () => {
    const parsed = parseCliArguments(['worker', 'verify', '--help']);

    expect(parsed).toEqual({
      command: 'worker',
      action: 'verify',
      manifest: '',
      from: '',
      help: true,
      json: false,
    });
  });

  it('rejects unknown worker actions', () => {
    expect(() => parseCliArguments(['worker', 'run'])).toThrow('worker: expected action "verify"');
  });

  it('requires a manifest and registry snapshot unless help is requested', () => {
    expect(() => parseCliArguments(['worker', 'verify', '--from', 'registry.json'])).toThrow(
      'worker verify: --manifest is required',
    );
    expect(() =>
      parseCliArguments(['worker', 'verify', '--manifest', 'worker-manifest.json']),
    ).toThrow('worker verify: --from is required');
  });
});
