/**
 * `dashboard()`: Weft's server with its prebuilt dashboard on the same origin.
 *
 * A built dashboard is a directory holding `index.html` and an `assets/`
 * directory of the files that page loads. `dashboard()` serves `index.html` at
 * every page route in {@link DASHBOARD_SHELL_ROUTES} and the files under
 * `assets/` at `/assets/*`, so the page must reference its scripts and styles
 * below `/assets/`. It registers both through `serve({ routes })`, so Weft's
 * API and discovery endpoints keep answering on the same server.
 *
 * @module server/dashboard
 */

import { createDashboardAssetRoute, resolveDashboardAssetDirectory } from './dashboard-assets.ts';
import { serve, type ServeOptions, type ServeRoutes, type WeftServer } from './index.ts';

/**
 * The page routes that answer with the dashboard's `index.html`. They are
 * specific rather than a blanket `/*`, which would swallow the API, and each
 * one is a client-side route the dashboard renders. `/workflows/*` covers a
 * workflow's detail pages.
 */
export const DASHBOARD_SHELL_ROUTES = [
  '/',
  '/workflows',
  '/workflows/*',
  '/reviews',
  '/workers',
  '/schedules',
  '/storage',
  '/system',
] as const;

/** URL prefix under which the dashboard's `assets/` directory is served. */
export const DASHBOARD_ASSET_PREFIX = '/assets';

/** Every route key `dashboard()` adds to `serve({ routes })`. */
const DASHBOARD_ROUTE_KEYS: readonly string[] = [
  ...DASHBOARD_SHELL_ROUTES,
  `${DASHBOARD_ASSET_PREFIX}/*`,
];

/** The command, run in the `@lostgradient/weft` package, that builds the default dashboard directory. */
export const DASHBOARD_BUILD_COMMAND = 'bun scripts/build-dashboard.ts';

/**
 * Options for {@link dashboard}: everything {@link serve} accepts, plus where
 * the built dashboard lives.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, type DashboardOptions } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * const options: DashboardOptions = { engine, port: 7233, distDir: './dashboard' };
 * void options;
 * ```
 */
export interface DashboardOptions extends ServeOptions {
  /**
   * Directory containing the built dashboard: `index.html` plus an `assets/`
   * directory. Defaults to the `dashboard/` directory at the root of the
   * `@lostgradient/weft` package.
   */
  distDir?: string;
}

/**
 * The default {@link DashboardOptions.distDir}: the `dashboard/` directory at
 * the root of the `@lostgradient/weft` package, two levels above this module.
 */
export function defaultDashboardDirectory(): string {
  const url = process.getBuiltinModule('node:url');
  return url.fileURLToPath(new URL('../../dashboard', import.meta.url));
}

function isFile(path: string): boolean {
  try {
    return process.getBuiltinModule('node:fs').statSync(path).isFile();
  } catch {
    return false;
  }
}

function createDashboardRoutes(distDir: string): ServeRoutes {
  const paths = process.getBuiltinModule('node:path');
  const directory = paths.resolve(distDir);
  const indexPath = paths.join(directory, 'index.html');
  if (!isFile(indexPath)) {
    throw new Error(
      `Weft's dashboard is not built: ${directory} has no index.html. Build it by running \`${DASHBOARD_BUILD_COMMAND}\` in the @lostgradient/weft package, or pass distDir.`,
    );
  }
  const assets = resolveDashboardAssetDirectory(
    DASHBOARD_ASSET_PREFIX,
    paths.join(directory, 'assets'),
  );
  // A Response whose body is a BunFile is read from disk on every request, so
  // a rebuilt index.html is served without restarting the server.
  const shell = new Response(Bun.file(indexPath), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const routes: ServeRoutes = {};
  for (const route of DASHBOARD_SHELL_ROUTES) {
    routes[route] = shell;
  }
  routes[`${DASHBOARD_ASSET_PREFIX}/*`] = createDashboardAssetRoute(assets);
  return routes;
}

/**
 * Start Weft's server with its prebuilt dashboard mounted on the same origin.
 *
 * Accepts every {@link ServeOptions} field, calls {@link serve}, and returns its
 * {@link WeftServer}. The dashboard's page routes and its `/assets/*` route are
 * added to `options.routes`; a key in `options.routes` that the dashboard also
 * registers is an error. Both that and a `distDir` with no `index.html` throw
 * synchronously, before a port is bound.
 *
 * @example
 * ```ts
 * import { dashboard, Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * await using server = dashboard({ engine, port: 7233, distDir: './dashboard' });
 * console.log(`Weft and its dashboard at ${server.url}`);
 * ```
 */
export function dashboard(options: DashboardOptions): WeftServer {
  const { distDir = defaultDashboardDirectory(), routes: callerRoutes, ...serveOptions } = options;
  const conflicts = Object.keys(callerRoutes ?? {}).filter((routeKey) =>
    DASHBOARD_ROUTE_KEYS.includes(routeKey),
  );
  if (conflicts.length > 0) {
    throw new Error(
      `dashboard() registers these routes itself, so remove them from routes: ${conflicts.join(', ')}`,
    );
  }
  return serve({ ...serveOptions, routes: { ...callerRoutes, ...createDashboardRoutes(distDir) } });
}
