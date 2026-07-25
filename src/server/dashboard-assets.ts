import * as fileSystem from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { API_PREFIX, DIRECT_HTTP_ROUTES, ROOT_API_PREFIX } from './route-model.ts';

type DashboardAssetFileSystem = {
  constants: Pick<typeof fileSystem.constants, 'O_RDONLY' | 'O_NOFOLLOW'>;
  realpathSync: (path: string) => string;
  openSync: (
    path: string,
    flags: Parameters<typeof fileSystem.openSync>[1],
    mode?: Parameters<typeof fileSystem.openSync>[2],
  ) => number;
  fstatSync: (descriptor: number) => fileSystem.Stats;
  readFileSync: (descriptor: number) => Buffer;
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

  const resolvedDirectory = resolve(directory);
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

  const assetPath = resolve(join(directory, ...pathSegments));
  if (!isWithinDirectory(directory, assetPath)) {
    return undefined;
  }

  return assetPath;
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

    descriptor = assetFileSystem.openSync(
      realAssetPath,
      assetFileSystem.constants.O_RDONLY | assetFileSystem.constants.O_NOFOLLOW,
    );
    const fileStats = assetFileSystem.fstatSync(descriptor);
    if (request.signal.aborted || !fileStats.isFile()) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = {
      'content-length': String(fileStats.size),
      'content-type': Bun.file(realAssetPath).type,
    };
    if (request.method === 'HEAD') {
      return new Response(null, { headers });
    }

    return new Response(assetFileSystem.readFileSync(descriptor), { headers });
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
  const fileSystemForAsset = assetFileSystem ?? fileSystem;
  const handler = (request: Request): Response =>
    assetResponse(assets.directory, assets.prefix, request, fileSystemForAsset);
  return { GET: handler, HEAD: handler };
}
