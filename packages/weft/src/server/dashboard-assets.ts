/**
 * The static-file route `dashboard()` registers for the dashboard's built
 * assets: a validated URL prefix mapped onto a directory, served through
 * verified file descriptors that refuse anything outside that directory.
 *
 * @module server/dashboard-assets
 */

import type * as fileSystem from 'node:fs';

type DashboardAssetFileSystem = {
  constants: Pick<typeof fileSystem.constants, 'O_RDONLY' | 'O_NOFOLLOW' | 'O_NONBLOCK'>;
  realpathSync: (path: string) => string;
  statSync: (path: string) => fileSystem.Stats;
  openSync: (
    path: string,
    flags: Parameters<typeof fileSystem.openSync>[1],
    mode?: Parameters<typeof fileSystem.openSync>[2],
  ) => number;
  fstatSync: (descriptor: number) => fileSystem.Stats;
  read: (
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<number>;
  closeSync: (descriptor: number) => void;
};

/**
 * A URL prefix (mounted as `${prefix}/*`) and the directory whose files it
 * serves, after validation: the prefix is a concrete path and the directory is
 * an existing directory, resolved to its real path.
 */
export interface DashboardAssetDirectory {
  prefix: string;
  directory: string;
}

function hasInvalidPrefixShape(prefix: string): boolean {
  return (
    prefix.length === 0 ||
    prefix === '/' ||
    !prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    ['?', '#', '%', '*', ':', '\\'].some((character) => prefix.includes(character))
  );
}

function validateAssetPrefix(prefix: string): void {
  if (hasInvalidPrefixShape(prefix)) {
    throw new Error(
      'Dashboard asset prefix must be an absolute path prefix without a trailing slash, wildcard, parameter, query, fragment, percent escape, or backslash',
    );
  }

  const segments = prefix.split('/').slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Dashboard asset prefix must contain only concrete, non-empty path segments');
  }

  const serializedPathname = new URL(prefix, 'http://weft.invalid').pathname;
  if (serializedPathname !== prefix) {
    throw new Error(
      `Dashboard asset prefix must round-trip through URL serialization unchanged; ${prefix} serializes as ${serializedPathname}`,
    );
  }
}

/**
 * Validate an asset prefix and resolve its directory synchronously, so a bad
 * prefix or a missing directory fails before any port is bound. Whether the
 * mounted `${prefix}/*` route overlaps Weft's own endpoints is checked by
 * `serve()`, which validates every route it is given.
 */
export function resolveDashboardAssetDirectory(
  prefix: string,
  directory: string,
): DashboardAssetDirectory {
  validateAssetPrefix(prefix);

  const fileSystem = process.getBuiltinModule('node:fs');
  const paths = process.getBuiltinModule('node:path');
  const resolvedDirectory = paths.resolve(directory);
  let directoryStats: ReturnType<typeof fileSystem.statSync>;
  try {
    directoryStats = fileSystem.statSync(resolvedDirectory);
  } catch {
    throw new Error(`Dashboard asset directory does not exist: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`Dashboard asset directory must be a directory: ${directory}`);
  }

  return { prefix, directory: fileSystem.realpathSync(resolvedDirectory) };
}

function isWithinDirectory(directory: string, path: string): boolean {
  const paths = process.getBuiltinModule('node:path');
  const pathRelativeToDirectory = paths.relative(directory, path);
  return (
    pathRelativeToDirectory.length > 0 &&
    pathRelativeToDirectory !== '..' &&
    !pathRelativeToDirectory.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(pathRelativeToDirectory)
  );
}

function hasSameFileIdentity(left: fileSystem.Stats, right: fileSystem.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function resolveAssetPath(directory: string, prefix: string, request: Request): string | undefined {
  if (request.signal.aborted) {
    return undefined;
  }

  const pathname = new URL(request.url).pathname;
  const rawWildcardPath = pathname.slice(prefix.length + 1);
  let wildcardPath: string;
  try {
    // Decode the URL suffix exactly once; never decode the result again.
    wildcardPath = decodeURIComponent(rawWildcardPath);
  } catch {
    return undefined;
  }
  if (wildcardPath.length === 0) {
    return undefined;
  }

  const pathSegments = wildcardPath.split(/[\\/]/);
  if (pathSegments.some((segment) => segment === '..' || segment.length === 0)) {
    return undefined;
  }

  const paths = process.getBuiltinModule('node:path');
  const assetPath = paths.resolve(paths.join(directory, ...pathSegments));
  if (!isWithinDirectory(directory, assetPath)) {
    return undefined;
  }

  return assetPath;
}

function isVerifiedAssetDescriptor(
  request: Request,
  directory: string,
  canonicalStats: fileSystem.Stats,
  openedStats: fileSystem.Stats,
  postOpenStats: fileSystem.Stats,
  postOpenAssetPath: string,
  openedAssetPath: string | undefined,
): boolean {
  return (
    !request.signal.aborted &&
    isWithinDirectory(directory, postOpenAssetPath) &&
    (openedAssetPath === undefined || isWithinDirectory(directory, openedAssetPath)) &&
    canonicalStats.isFile() &&
    openedStats.isFile() &&
    postOpenStats.isFile() &&
    hasSameFileIdentity(openedStats, canonicalStats) &&
    hasSameFileIdentity(openedStats, postOpenStats)
  );
}

function resolveOpenedDescriptorPath(
  descriptor: number,
  assetFileSystem: DashboardAssetFileSystem,
): string | undefined {
  for (const descriptorPath of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const resolvedPath = assetFileSystem.realpathSync(descriptorPath);
      if (resolvedPath.startsWith('/proc/self/fd/') || resolvedPath.startsWith('/dev/fd/')) {
        continue;
      }
      return resolvedPath;
    } catch {
      // Linux exposes descriptor targets through /proc; Darwin and BSD use /dev.
    }
  }
  return undefined;
}

function createAssetStream(
  descriptor: number,
  verifiedSize: number,
  assetFileSystem: DashboardAssetFileSystem,
): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let closed = false;
  let cancelled = false;
  let position = 0;
  let remainingBytes = verifiedSize;
  let inFlightRead: Promise<number> | undefined;
  const close = (): void => {
    if (!closed) {
      closed = true;
      assetFileSystem.closeSync(descriptor);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      if (remainingBytes === 0) {
        close();
        controller.close();
        return;
      }

      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remainingBytes));
      const read = assetFileSystem.read(descriptor, buffer, 0, buffer.byteLength, position);
      inFlightRead = read;
      try {
        const bytesRead = await read;
        if (cancelled) {
          close();
          return;
        }
        if (bytesRead === 0) {
          close();
          controller.error(
            new Error('Dashboard asset ended before its verified content length was read.'),
          );
          return;
        }

        const boundedBytesRead = Math.min(bytesRead, remainingBytes);
        position += boundedBytesRead;
        remainingBytes -= boundedBytesRead;
        controller.enqueue(buffer.subarray(0, boundedBytesRead));
        if (remainingBytes === 0) {
          close();
          controller.close();
        }
      } catch (error) {
        close();
        if (!cancelled) controller.error(error);
      } finally {
        if (inFlightRead === read) inFlightRead = undefined;
      }
    },
    async cancel() {
      cancelled = true;
      try {
        await inFlightRead;
      } catch {
        // The pull path owns read failures; cancellation only waits for settlement.
      }
      close();
    },
  });

  return { stream, close };
}

function readAssetDescriptor(
  descriptor: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | null,
): Promise<number> {
  return new Promise((_resolve, reject) => {
    process
      .getBuiltinModule('node:fs')
      .read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
        if (error) reject(error);
        else _resolve(bytesRead);
      });
  });
}

function assetResponse(
  directory: string,
  prefix: string,
  request: Request,
  assetFileSystem: DashboardAssetFileSystem,
): Response {
  const assetPath = resolveAssetPath(directory, prefix, request);
  if (assetPath === undefined) {
    return new Response('Not Found', { status: 404 });
  }

  let descriptor: number | undefined;
  try {
    const realAssetPath = assetFileSystem.realpathSync(assetPath);
    if (!isWithinDirectory(directory, realAssetPath)) {
      return new Response('Not Found', { status: 404 });
    }

    const canonicalStats = assetFileSystem.statSync(realAssetPath);
    descriptor = assetFileSystem.openSync(
      realAssetPath,
      assetFileSystem.constants.O_RDONLY |
        assetFileSystem.constants.O_NOFOLLOW |
        assetFileSystem.constants.O_NONBLOCK,
    );
    const fileStats = assetFileSystem.fstatSync(descriptor);
    const postOpenAssetPath = assetFileSystem.realpathSync(realAssetPath);
    const postOpenStats = assetFileSystem.statSync(postOpenAssetPath);
    const openedAssetPath = resolveOpenedDescriptorPath(descriptor, assetFileSystem);
    if (
      !isVerifiedAssetDescriptor(
        request,
        directory,
        canonicalStats,
        fileStats,
        postOpenStats,
        postOpenAssetPath,
        openedAssetPath,
      )
    ) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = {
      'content-length': String(fileStats.size),
      'content-type': Bun.file(realAssetPath).type,
    };
    if (request.method === 'HEAD') {
      return new Response(null, { headers });
    }

    const assetStream = createAssetStream(descriptor, fileStats.size, assetFileSystem);
    try {
      const response = new Response(assetStream.stream, { headers });
      descriptor = undefined;
      return response;
    } catch {
      assetStream.close();
      descriptor = undefined;
      return new Response('Not Found', { status: 404 });
    }
  } catch {
    return new Response('Not Found', { status: 404 });
  } finally {
    if (descriptor !== undefined) {
      assetFileSystem.closeSync(descriptor);
    }
  }
}

export function createDashboardAssetRoute(
  assets: DashboardAssetDirectory,
  assetFileSystem?: DashboardAssetFileSystem,
): Partial<Record<'GET' | 'HEAD', (request: Request) => Response>> {
  const fileSystemForAsset = assetFileSystem ?? {
    ...process.getBuiltinModule('node:fs'),
    read: readAssetDescriptor,
  };
  const handler = (request: Request): Response =>
    assetResponse(assets.directory, assets.prefix, request, fileSystemForAsset);
  return { GET: handler, HEAD: handler };
}
