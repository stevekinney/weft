import * as fileSystem from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import { API_PREFIX, DIRECT_HTTP_ROUTES, ROOT_API_PREFIX } from './route-model.ts';

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
 * Static files belonging to an externally supplied dashboard.
 *
 * `prefix` is mounted as `${prefix}/*`; `directory` must exist before
 * `serve()` is called.
 *
 * @example
 * ```ts
 * import type { DashboardAssets } from '@lostgradient/weft/server';
 *
 * const dashboardAssets: DashboardAssets = {
 *   prefix: '/assets',
 *   directory: './dist/assets',
 * };
 * ```
 */
export interface DashboardAssets {
  prefix: string;
  directory: string;
}

export interface ResolvedDashboardAssets {
  prefix: string;
  directory: string;
}

function overlapsDashboardPageRoute(prefix: string, route: string): boolean {
  if (route.endsWith('/*')) {
    const base = route.slice(0, -2);
    return prefix === base || prefix.startsWith(`${base}/`);
  }
  return prefix === route;
}

function overlapsWildcardRoute(prefix: string, route: string): boolean {
  return prefix === route || prefix.startsWith(`${route}/`) || route.startsWith(`${prefix}/`);
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

function validateAssetPrefixShape(prefix: string): void {
  if (hasInvalidPrefixShape(prefix)) {
    throw new Error(
      'dashboardAssets.prefix must be an absolute path prefix without a trailing slash, wildcard, parameter, query, fragment, percent escape, or backslash',
    );
  }

  const segments = prefix.split('/').slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('dashboardAssets.prefix must contain only concrete, non-empty path segments');
  }

  const serializedPathname = new URL(prefix, 'http://weft.invalid').pathname;
  if (serializedPathname !== prefix) {
    throw new Error(
      `dashboardAssets.prefix must round-trip through URL serialization unchanged; ${prefix} serializes as ${serializedPathname}`,
    );
  }
}

function validateAssetPrefixReservations(prefix: string, pageRoutes: readonly string[]): void {
  const reservedRoutes = [
    API_PREFIX,
    ROOT_API_PREFIX,
    ...DIRECT_HTTP_ROUTES.map(({ path }) => path),
  ];
  if (reservedRoutes.some((reserved) => overlapsWildcardRoute(prefix, reserved))) {
    throw new Error(
      'dashboardAssets.prefix must not overlap the /api, /v1, or direct HTTP route spaces',
    );
  }

  if (pageRoutes.some((route) => overlapsDashboardPageRoute(prefix, route))) {
    throw new Error('dashboardAssets.prefix must not overlap dashboard page routes');
  }
}

function validateAssetPrefix(prefix: string, pageRoutes: readonly string[]): void {
  validateAssetPrefixShape(prefix);
  validateAssetPrefixReservations(prefix, pageRoutes);
}

export function resolveDashboardAssets(
  value: unknown,
  pageRoutes: readonly string[],
): ResolvedDashboardAssets {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dashboardAssets must be an object with prefix and directory strings');
  }

  if (!('prefix' in value) || !('directory' in value)) {
    throw new Error('dashboardAssets.prefix and dashboardAssets.directory must be strings');
  }
  const prefix = value.prefix;
  const directory = value.directory;
  if (typeof prefix !== 'string' || typeof directory !== 'string') {
    throw new Error('dashboardAssets.prefix and dashboardAssets.directory must be strings');
  }

  validateAssetPrefix(prefix, pageRoutes);

  const resolvedDirectory = resolvePath(directory);
  let directoryStats: ReturnType<typeof fileSystem.statSync>;
  try {
    directoryStats = fileSystem.statSync(resolvedDirectory);
  } catch {
    throw new Error(`dashboardAssets.directory does not exist: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`dashboardAssets.directory must be a directory: ${directory}`);
  }

  return { prefix, directory: fileSystem.realpathSync(resolvedDirectory) };
}

function isWithinDirectory(directory: string, path: string): boolean {
  const pathRelativeToDirectory = relative(directory, path);
  return (
    pathRelativeToDirectory.length > 0 &&
    pathRelativeToDirectory !== '..' &&
    !pathRelativeToDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelativeToDirectory)
  );
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

  const assetPath = resolvePath(join(directory, ...pathSegments));
  if (!isWithinDirectory(directory, assetPath)) {
    return undefined;
  }

  return assetPath;
}

function isVerifiedAssetFile(
  request: Request,
  canonicalStats: fileSystem.Stats,
  openedStats: fileSystem.Stats,
): boolean {
  return (
    !request.signal.aborted &&
    canonicalStats.isFile() &&
    openedStats.isFile() &&
    openedStats.dev === canonicalStats.dev &&
    openedStats.ino === canonicalStats.ino
  );
}

function createAssetStream(
  descriptor: number,
  assetFileSystem: DashboardAssetFileSystem,
): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      assetFileSystem.closeSync(descriptor);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      try {
        const bytesRead = await assetFileSystem.read(
          descriptor,
          buffer,
          0,
          buffer.byteLength,
          null,
        );
        if (bytesRead === 0) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
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
    fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
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
    if (
      !isWithinDirectory(directory, postOpenAssetPath) ||
      !isVerifiedAssetFile(request, canonicalStats, fileStats)
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

    const assetStream = createAssetStream(descriptor, assetFileSystem);
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
  assets: ResolvedDashboardAssets,
  assetFileSystem?: DashboardAssetFileSystem,
): Partial<Record<'GET' | 'HEAD', (request: Request) => Response>> {
  const fileSystemForAsset = assetFileSystem ?? {
    ...fileSystem,
    read: readAssetDescriptor,
  };
  const handler = (request: Request): Response =>
    assetResponse(assets.directory, assets.prefix, request, fileSystemForAsset);
  return { GET: handler, HEAD: handler };
}
