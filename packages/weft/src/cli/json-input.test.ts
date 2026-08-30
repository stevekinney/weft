import { describe, expect, it } from 'bun:test';

import { loadJsonInput, parseJsonInput } from './json-input.ts';

describe('JSON input loading', () => {
  it('parses inline JSON and reports malformed input', () => {
    expect(parseJsonInput('{"value":42}')).toEqual({ ok: true, value: { value: 42 } });
    expect(parseJsonInput('{bad')).toMatchObject({
      ok: false,
      error: { kind: 'invalid-json' },
    });
  });

  it('loads JSON from a file, stdin, and reports missing files', async () => {
    const filePath = `/tmp/weft-json-input-${crypto.randomUUID()}.json`;
    await Bun.write(filePath, '{"source":"file"}');

    try {
      await expect(loadJsonInput(undefined, filePath)).resolves.toEqual({
        ok: true,
        value: { source: 'file' },
      });
      await expect(
        loadJsonInput(undefined, '-', async () => '{"source":"stdin"}'),
      ).resolves.toEqual({
        ok: true,
        value: { source: 'stdin' },
      });
      await expect(loadJsonInput(undefined, `${filePath}.missing`)).resolves.toMatchObject({
        ok: false,
        error: { kind: 'missing-file' },
      });
    } finally {
      await Bun.file(filePath).delete();
    }
  });
});
