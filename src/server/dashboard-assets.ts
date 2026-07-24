import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

const ROOT_API_PREFIXES = ['/api', '/v1'] as const;
const DISCOVERY_DOCUMENTS = [
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
  '/.well-known/mcp.json',
] as const;

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function overlapsDashboardPageRoute(prefix: string, route: string): boolean {
  if (route.endsWith('/*')) {
    const base = route.slice(0, -2);
    return prefix === base || prefix.startsWith(`${base}/`);
  }
  return prefix === route;
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
}

function validateAssetPrefixReservations(prefix: string, pageRoutes: readonly string[]): void {
  if (ROOT_API_PREFIXES.some((reserved) => hasPathPrefix(prefix, reserved))) {
    throw new Error('dashboardAssets.prefix must not overlap the /api or /v1 route spaces');
  }

  if (pageRoutes.some((route) => overlapsDashboardPageRoute(prefix, route))) {
    throw new Error('dashboardAssets.prefix must not overlap dashboard page routes');
  }

  if (DISCOVERY_DOCUMENTS.some((document) => document === prefix)) {
    throw new Error('dashboardAssets.prefix must not overlap a discovery document route');
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
  let directoryStats: ReturnType<typeof statSync>;
  try {
    directoryStats = statSync(resolvedDirectory);
  } catch {
    throw new Error(`dashboardAssets.directory does not exist: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`dashboardAssets.directory must be a directory: ${directory}`);
  }

  return { prefix, directory: realpathSync(resolvedDirectory) };
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

function assetResponse(directory: string, prefix: string, request: Request): Response {
  const pathname = new URL(request.url).pathname;
  const rawWildcardPath = pathname.slice(prefix.length + 1);
  let wildcardPath: string;
  try {
    // Decode the URL suffix exactly once; never decode the result again.
    wildcardPath = decodeURIComponent(rawWildcardPath);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (wildcardPath.length === 0) {
    return new Response('Not Found', { status: 404 });
  }

  const pathSegments = wildcardPath.split(/[\\/]/);
  if (pathSegments.some((segment) => segment === '..' || segment.length === 0)) {
    return new Response('Not Found', { status: 404 });
  }

  const assetPath = resolve(join(directory, ...pathSegments));
  if (!isWithinDirectory(directory, assetPath)) {
    return new Response('Not Found', { status: 404 });
  }

  let realAssetPath: string;
  try {
    realAssetPath = realpathSync(assetPath);
    if (!statSync(realAssetPath).isFile()) {
      return new Response('Not Found', { status: 404 });
    }
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (!isWithinDirectory(directory, realAssetPath)) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(Bun.file(realAssetPath));
}

export function createDashboardAssetRoute(
  assets: ResolvedDashboardAssets,
): Partial<Record<'GET' | 'HEAD', (request: Request) => Response>> {
  const handler = (request: Request): Response =>
    assetResponse(assets.directory, assets.prefix, request);
  return { GET: handler, HEAD: handler };
}
