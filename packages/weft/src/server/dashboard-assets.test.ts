/**
 * Tests for the verified static-file route `dashboard()` mounts at
 * `/assets/*`: prefix and directory validation, and the descriptor checks that
 * keep every response inside the asset directory. `dashboard.test.ts` covers
 * the same route served over HTTP.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fileSystem from 'node:fs';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  outcomeOf,
  rethrow,
  SCENARIO_HANG_GUARD_MILLISECONDS,
} from '../testing/module-scope-scenario.test-support.ts';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { createDashboardAssetRoute, resolveDashboardAssetDirectory } from './dashboard-assets.ts';

function supportsSymlinks(directory: string): boolean {
  const probePath = join(directory, '.symlink-probe');
  try {
    symlinkSync(directory, probePath);
    rmSync(probePath);
    return true;
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (errorCode === 'EACCES' || errorCode === 'EPERM' || errorCode === 'ENOTSUP') {
      console.warn(
        `Skipping symlink asset test: platform rejected symlink creation (${errorCode})`,
      );
      return false;
    }
    throw error;
  }
}

// The FIFO scenario runs the native `mkfifo` binary, so it runs here at module scope, off Bun's
// five-second per-test clock; its test rethrows the outcome.
const fifoScenario = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
  const fifoPath = join(directory, 'asset.fifo');
  try {
    try {
      execFileSync('mkfifo', [fifoPath], { timeout: SCENARIO_HANG_GUARD_MILLISECONDS });
    } catch (error) {
      const errorCode =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (errorCode === 'ENOENT' || errorCode === 'EACCES' || errorCode === 'EPERM') return;
      throw error;
    }
    const assets = resolveDashboardAssetDirectory('/assets', directory);
    const route = createDashboardAssetRoute(assets);
    expect(route.GET!(new Request('http://weft.test/assets/asset.fifo')).status).toBe(404);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveDashboardAssetDirectory', () => {
  it('rejects prefixes that are not concrete absolute paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      for (const prefix of [
        '',
        '/',
        'assets',
        '/assets/',
        '/assets//',
        '/assets/.',
        '/assets/..',
        '/assets/*',
        '/assets/:file',
        '/assets?version=1',
        '/assets#top',
        '/assets/%2e%2e',
        '/assets\\files',
      ]) {
        expect(() => resolveDashboardAssetDirectory(prefix, directory), prefix).toThrow(
          /^Dashboard asset prefix must/,
        );
      }
      for (const prefix of ['/assets//files', '/assets/./files', '/assets/../files']) {
        expect(() => resolveDashboardAssetDirectory(prefix, directory), prefix).toThrow(
          'Dashboard asset prefix must contain only concrete, non-empty path segments',
        );
      }
      for (const prefix of ['/asset files', '/café']) {
        expect(() => resolveDashboardAssetDirectory(prefix, directory), prefix).toThrow(
          /URL serialization/,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a missing directory and a file in place of a directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      const missingDirectory = join(directory, 'missing');
      expect(() => resolveDashboardAssetDirectory('/assets', missingDirectory)).toThrow(
        `Dashboard asset directory does not exist: ${missingDirectory}`,
      );

      const filePath = join(directory, 'not-a-directory.txt');
      writeFileSync(filePath, 'file');
      expect(() => resolveDashboardAssetDirectory('/assets', filePath)).toThrow(
        `Dashboard asset directory must be a directory: ${filePath}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves the directory to its real path', () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      const directory = join(parentDirectory, 'assets');
      mkdirSync(directory);
      expect(resolveDashboardAssetDirectory('/static/assets', directory)).toEqual({
        prefix: '/static/assets',
        directory: fileSystem.realpathSync(directory),
      });
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });
});

describe('createDashboardAssetRoute', () => {
  it('does not serve a symlink that escapes the dashboard asset directory', async () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const outsideFile = join(parentDirectory, 'outside.txt');
    try {
      mkdirSync(directory);
      writeFileSync(outsideFile, 'outside asset');
      if (!supportsSymlinks(parentDirectory)) return;
      symlinkSync(outsideFile, join(directory, 'outside.txt'));
      symlinkSync(join(directory, 'missing.txt'), join(directory, 'broken.txt'));

      const route = createDashboardAssetRoute(resolveDashboardAssetDirectory('/assets', directory));

      const response = route.GET!(new Request('http://weft.test/assets/outside.txt'));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(outsideFile);

      const brokenLinkResponse = route.GET!(new Request('http://weft.test/assets/broken.txt'));
      expect(brokenLinkResponse.status).toBe(404);
      expect(await brokenLinkResponse.text()).not.toContain(directory);
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('returns not found for an aborted dashboard asset request', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets);
      const controller = new AbortController();
      controller.abort();

      const emptyPathResponse = route.GET!(new Request('http://weft.test/assets/'));
      expect(emptyPathResponse.status).toBe(404);

      const response = route.GET!(
        new Request('http://weft.test/assets/app.js', { signal: controller.signal }),
      );
      expect(response.status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes the descriptor when constructing an asset response fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const originalResponse = globalThis.Response;
    const originalCloseSync = fileSystem.closeSync;
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      let closeCount = 0;
      const route = createDashboardAssetRoute(assets, {
        ...fileSystem,
        closeSync: (descriptor: number) => {
          closeCount += 1;
          return originalCloseSync(descriptor);
        },
        read: async (descriptor, buffer, offset, length, position) =>
          await new Promise<number>((resolve, reject) => {
            fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          }),
      });
      globalThis.Response = class extends originalResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          if (body instanceof ReadableStream) {
            throw new Error('response construction failed');
          }
          super(body, init);
        }
      };

      const response = route.GET!(new Request('http://weft.test/assets/app.js'));
      expect(response.status).toBe(404);
      expect(closeCount).toBe(1);
    } finally {
      globalThis.Response = originalResponse;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not serve a symlink installed after canonical validation', async () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const assetPath = join(directory, 'app.js');
    const outsideFile = join(parentDirectory, 'outside.js');
    try {
      mkdirSync(directory);
      writeFileSync(assetPath, 'validated asset');
      writeFileSync(outsideFile, 'replacement asset');
      if (!supportsSymlinks(parentDirectory)) return;
      const originalOpenSync = fileSystem.openSync;
      let replaced = false;
      let replacementError: unknown;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => 0,
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          if (String(path).endsWith(join('app.js')) && !replaced) {
            try {
              rmSync(assetPath);
              symlinkSync(outsideFile, assetPath);
            } catch (error) {
              replacementError = error;
              throw error;
            }
            replaced = true;
          }
          return originalOpenSync(path, flags, mode);
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));
      if (replacementError !== undefined) throw replacementError;
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('replacement asset');
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('does not serve an asset after an ancestor directory is replaced', () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const nestedDirectory = join(directory, 'nested');
    const outsideDirectory = join(parentDirectory, 'outside');
    const outsideFile = join(outsideDirectory, 'app.js');
    try {
      mkdirSync(nestedDirectory, { recursive: true });
      mkdirSync(outsideDirectory);
      writeFileSync(join(nestedDirectory, 'app.js'), 'validated asset');
      writeFileSync(outsideFile, 'replacement asset');
      if (!supportsSymlinks(parentDirectory)) return;
      const originalOpenSync = fileSystem.openSync;
      let replaced = false;
      let replacementError: unknown;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => 0,
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          if (String(path).endsWith(join('nested', 'app.js')) && !replaced) {
            try {
              rmSync(nestedDirectory, { recursive: true });
              symlinkSync(outsideDirectory, nestedDirectory);
            } catch (error) {
              replacementError = error;
              throw error;
            }
            replaced = true;
          }
          return originalOpenSync(path, flags, mode);
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/nested/app.js'));
      if (replacementError !== undefined) throw replacementError;
      expect(response.status).toBe(404);
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('does not serve an outside descriptor when an ancestor is restored after opening', async () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const nestedDirectory = join(directory, 'nested');
    const savedDirectory = join(directory, 'saved-nested');
    const outsideDirectory = join(parentDirectory, 'outside');
    try {
      mkdirSync(nestedDirectory, { recursive: true });
      mkdirSync(outsideDirectory);
      writeFileSync(join(nestedDirectory, 'app.js'), 'validated asset');
      writeFileSync(join(outsideDirectory, 'app.js'), 'outside asset');
      if (!supportsSymlinks(parentDirectory)) return;

      const originalStatSync = fileSystem.statSync;
      const originalOpenSync = fileSystem.openSync;
      let ancestorSwapped = false;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => 0,
        realpathSync: (path: Parameters<typeof fileSystem.realpathSync>[0]) => {
          const value = String(path);
          if (value.startsWith('/proc/self/fd/') || value.startsWith('/dev/fd/')) {
            throw new Error('Descriptor path aliases are unavailable');
          }
          return fileSystem.realpathSync(path);
        },
        statSync: (path: Parameters<typeof fileSystem.statSync>[0]) => {
          if (String(path).endsWith(join('nested', 'app.js')) && !ancestorSwapped) {
            renameSync(nestedDirectory, savedDirectory);
            symlinkSync(outsideDirectory, nestedDirectory);
            ancestorSwapped = true;
          }
          return originalStatSync(path);
        },
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          const descriptor = originalOpenSync(path, flags, mode);
          if (String(path).endsWith(join('nested', 'app.js')) && ancestorSwapped) {
            rmSync(nestedDirectory);
            renameSync(savedDirectory, nestedDirectory);
          }
          return descriptor;
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/nested/app.js'));

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('outside asset');
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('serves verified assets when descriptor path aliases are unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assetFileSystem = {
        ...fileSystem,
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) =>
          await new Promise<number>((resolve, reject) => {
            fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          }),
        realpathSync: (path: Parameters<typeof fileSystem.realpathSync>[0]) => {
          const value = String(path);
          if (value.startsWith('/proc/self/fd/') || value.startsWith('/dev/fd/')) {
            throw new Error('Descriptor path aliases are unavailable');
          }
          return fileSystem.realpathSync(path);
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);

      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('dashboard');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serves verified assets when descriptor aliases resolve to their namespace paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assetFileSystem = {
        ...fileSystem,
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) =>
          await new Promise<number>((resolve, reject) => {
            fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          }),
        realpathSync: (path: Parameters<typeof fileSystem.realpathSync>[0]) => {
          const value = String(path);
          if (value.startsWith('/proc/self/fd/')) {
            throw new Error('Linux descriptor path alias is unavailable');
          }
          if (value.startsWith('/dev/fd/')) {
            return value;
          }
          return fileSystem.realpathSync(path);
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);

      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('dashboard');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams only the file size verified before reading starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const assetPath = join(directory, 'app.js');
    const originalRead = fileSystem.read;
    try {
      writeFileSync(assetPath, 'safe');
      let appended = false;
      const assetFileSystem = {
        ...fileSystem,
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (!appended) {
            appendFileSync(assetPath, ' outside');
            appended = true;
          }
          return await new Promise<number>((resolve, reject) => {
            originalRead(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          });
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.headers.get('content-length')).toBe('4');
      expect(await response.text()).toBe('safe');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('errors the response stream when an asset is truncated after verification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const assetPath = join(directory, 'app.js');
    try {
      writeFileSync(assetPath, 'dashboard');
      let truncated = false;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => {
          if (!truncated) {
            truncateSync(assetPath, 0);
            truncated = true;
          }
          return 0;
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.headers.get('content-length')).toBe('9');
      expect(await throwingRejectionOf(response.text())).toThrow(
        'Dashboard asset ended before its verified content length was read.',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight asset read before closing on cancellation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const originalCloseSync = fileSystem.closeSync;
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      let closed = 0;
      let resolveRead!: (bytesRead: number) => void;
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const pendingRead = new Promise<number>((resolve) => {
        resolveRead = resolve;
      });
      const assetFileSystem = {
        ...fileSystem,
        closeSync: (descriptor: number) => {
          closed += 1;
          return originalCloseSync(descriptor);
        },
        read: async () => {
          markReadStarted();
          return await pendingRead;
        },
      };
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));
      const reader = response.body!.getReader();
      const read = reader.read();
      await readStarted;

      const cancellation = reader.cancel();
      await Promise.resolve();
      expect(closed).toBe(0);

      resolveRead(0);
      await cancellation;
      await read;
      expect(closed).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-regular dashboard assets without blocking on a FIFO', () =>
    rethrow(fifoScenario));

  it('closes dashboard asset descriptors for successful, rejected, and cancelled requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const originalOpenSync = fileSystem.openSync;
    const originalCloseSync = fileSystem.closeSync;
    const originalRead = fileSystem.read;
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assets = resolveDashboardAssetDirectory('/assets', directory);
      let opened = 0;
      let closed = 0;
      let readCount = 0;
      let readFailure = false;
      const assetFileSystem = {
        ...fileSystem,
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          opened += 1;
          return originalOpenSync(path, flags, mode);
        },
        closeSync: (descriptor: number) => {
          closed += 1;
          return originalCloseSync(descriptor);
        },
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (readFailure) throw new Error('asset read failed');
          readCount += 1;
          return await new Promise<number>((resolve, reject) => {
            originalRead(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          });
        },
      };
      const route = createDashboardAssetRoute(assets, assetFileSystem);

      for (let index = 0; index < 5; index += 1) {
        const response = route.GET!(new Request('http://weft.test/assets/app.js'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('dashboard');
        const readsBeforeHead = readCount;
        expect(
          route.HEAD!(new Request('http://weft.test/assets/app.js', { method: 'HEAD' })).status,
        ).toBe(200);
        expect(readCount).toBe(readsBeforeHead);
      }
      expect(readCount).toBeGreaterThan(0);
      expect(route.GET!(new Request('http://weft.test/assets/missing.js')).status).toBe(404);
      readFailure = true;
      const failedResponse = route.GET!(new Request('http://weft.test/assets/app.js'));
      expect(failedResponse.status).toBe(200);
      expect(await throwingRejectionOf(failedResponse.text())).toThrow('asset read failed');
      readFailure = false;
      const cancelledResponse = route.GET!(new Request('http://weft.test/assets/app.js'));
      const reader = cancelledResponse.body!.getReader();
      await reader.cancel();

      expect(closed).toBe(opened);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
