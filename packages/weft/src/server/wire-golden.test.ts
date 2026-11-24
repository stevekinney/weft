/**
 * Pins what Weft puts on the wire: its OpenAPI, OpenRPC and AsyncAPI documents and its catalog
 * snapshot. When an operation legitimately changes, regenerate with the update command.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertGoldenDirectory,
  formatGoldenJson,
  GOLDEN_VERSION,
  goldenFailure,
  listGoldenDirectory,
} from "../embedded/backchannel/src/testing.ts";
import {
  buildWireGolden,
  WIRE_GOLDEN_DIRECTORY,
  writeWireGolden,
} from './wire-golden.test-support.ts';

const UPDATE_COMMAND = '(cd packages/weft && bun scripts/update-wire-golden.ts)';
const DOCUMENTS = ['openapi.json', 'openrpc.json', 'asyncapi.json'];

describe('Weft wire goldens', () => {
  it('match what Weft builds, byte for byte, and hold no other file', async () => {
    await assertGoldenDirectory(WIRE_GOLDEN_DIRECTORY, buildWireGolden(), UPDATE_COMMAND);
  });

  it('holds exactly the four golden files', async () => {
    const names = await listGoldenDirectory(WIRE_GOLDEN_DIRECTORY);
    expect(names).toEqual([
      'asyncapi.json',
      'catalog-snapshot.json',
      'openapi.json',
      'openrpc.json',
    ]);
  });

  it('writes sorted keys, two-space indentation and a trailing newline', async () => {
    for (const name of [...DOCUMENTS, 'catalog-snapshot.json']) {
      const text = await Bun.file(join(WIRE_GOLDEN_DIRECTORY, name)).text();
      expect(text, name).toBe(formatGoldenJson(JSON.parse(text)));
    }
  });

  it('masks the version of each document', async () => {
    for (const name of DOCUMENTS) {
      const text = await Bun.file(join(WIRE_GOLDEN_DIRECTORY, name)).text();
      const document = JSON.parse(text) as { info: { version: string } };
      expect(document.info.version, name).toBe(GOLDEN_VERSION);
    }
  });

  describe('the update function', () => {
    let directory: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'weft-wire-golden-'));
    });
    afterEach(async () => {
      await rm(directory, { force: true, recursive: true });
    });

    it('rewrites a directory to the goldens and removes a stray file', async () => {
      await Bun.write(join(directory, 'stray.json'), '{}\n');
      await writeWireGolden(directory);
      const written = await listGoldenDirectory(directory);
      const golden = await listGoldenDirectory(WIRE_GOLDEN_DIRECTORY);
      expect(written).toEqual(golden);
      await assertGoldenDirectory(directory, buildWireGolden(), UPDATE_COMMAND);
    });

    it('is refused by the comparison when a stray file or a changed byte is present', async () => {
      await writeWireGolden(directory);
      await Bun.write(join(directory, 'stray.json'), '{}\n');
      const strayFailure = await goldenFailure(
        assertGoldenDirectory(directory, buildWireGolden(), UPDATE_COMMAND),
      );
      expect(strayFailure).toMatch(/stray\.json/);
      await rm(join(directory, 'stray.json'));
      const path = join(directory, 'openrpc.json');
      const text = await Bun.file(path).text();
      await Bun.write(path, text.replace('"', "'"));
      const changedFailure = await goldenFailure(
        assertGoldenDirectory(directory, buildWireGolden(), UPDATE_COMMAND),
      );
      expect(changedFailure).toMatch(/openrpc\.json.*update-wire-golden/);
    });
  });
});
