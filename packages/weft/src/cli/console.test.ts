import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { loadConsoleMount } from './console.ts';

const fixtureEntry = fileURLToPath(
  new URL('./__fixtures__/weft-ui/dist/mount.js', import.meta.url),
);

describe('optional Weft UI mount', () => {
  it('loads the named export and derives the adjacent assets directory', async () => {
    const mount = await loadConsoleMount({
      resolveModule: () => fixtureEntry,
    });

    expect(mount.dashboard).toBeInstanceOf(Response);
    expect(mount.dashboardAssets).toEqual({
      prefix: '/assets',
      directory: fileURLToPath(new URL('./__fixtures__/weft-ui/dist/assets', import.meta.url)),
    });
  });

  it('reports an actionable install error when the optional peer is absent', async () => {
    await expect(
      loadConsoleMount({
        resolveModule: () => {
          throw new Error('missing package');
        },
      }),
    ).rejects.toThrow(
      '--console requires @lostgradient/weft-ui. Install it in the CLI project: bun add @lostgradient/weft-ui',
    );
  });

  it('rejects a module without the expected export', async () => {
    await expect(
      loadConsoleMount({
        resolveModule: () => fixtureEntry,
        importModule: async () => ({ default: () => new Response('wrong export') }),
      }),
    ).rejects.toThrow('@lostgradient/weft-ui must export a weftUi() function');
  });

  it('masks a throwing weftUi factory with an actionable diagnostic', async () => {
    await expect(
      loadConsoleMount({
        resolveModule: () => fixtureEntry,
        importModule: async () => ({
          weftUi: () => {
            throw new Error('console factory failed');
          },
        }),
      }),
    ).rejects.toThrow(
      '--console @lostgradient/weft-ui weftUi() failed; reinstall or update it, then retry, or remove --console',
    );
  });

  it('rejects an invalid dashboard route target with an actionable diagnostic', async () => {
    await expect(
      loadConsoleMount({
        resolveModule: () => fixtureEntry,
        importModule: async () => ({ weftUi: () => ({}) }),
      }),
    ).rejects.toThrow(
      '--console @lostgradient/weft-ui weftUi() failed; reinstall or update it, then retry, or remove --console',
    );
  });

  it('does not expose dynamic import errors', async () => {
    const secretPath = '/Users/example/.secrets/weft-ui-token.txt';
    await expect(
      loadConsoleMount({
        resolveModule: () => fixtureEntry,
        importModule: async () => {
          throw new Error(`failed to read ${secretPath}`);
        },
      }),
    ).rejects.toThrow(
      '--console could not load @lostgradient/weft-ui; reinstall or update it, then retry, or remove --console',
    );
    await expect(
      loadConsoleMount({
        resolveModule: () => fixtureEntry,
        importModule: async () => {
          throw new Error(`failed to read ${secretPath}`);
        },
      }),
    ).rejects.not.toThrow(secretPath);
  });

  it('does not expose the absolute missing-assets directory', async () => {
    const secretAssetsDirectory = '/Users/example/.secrets/weft-ui/assets';
    await expect(
      loadConsoleMount({
        resolveModule: () => `${secretAssetsDirectory}/mount.js`,
        importModule: async () => ({ weftUi: () => new Response('console') }),
      }),
    ).rejects.toThrow(
      '--console @lostgradient/weft-ui is missing its built assets; reinstall or update it, then retry, or remove --console',
    );
    await expect(
      loadConsoleMount({
        resolveModule: () => `${secretAssetsDirectory}/mount.js`,
        importModule: async () => ({ weftUi: () => new Response('console') }),
      }),
    ).rejects.not.toThrow(secretAssetsDirectory);
  });
});
