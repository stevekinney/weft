/**
 * Tests for `dashboard()`: a built-dashboard fixture served beside Weft's own
 * API and discovery endpoints on one origin, the route-collision and
 * missing-build errors it raises before a port binds, and its default
 * `distDir`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  dashboard,
  DASHBOARD_BUILD_COMMAND,
  DASHBOARD_SHELL_ROUTES,
  defaultDashboardDirectory,
  type DashboardOptions,
} from './dashboard.ts';
import type { WeftServer } from './index.ts';
import { DIRECT_HTTP_ROUTES } from './route-model.ts';

const SHELL_HTML = '<!doctype html><title>Weft</title><div id="app"></div>';
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A path that exercises a shell route; `/workflows/*` is a deep-link pattern. */
function pagePath(route: string): string {
  return route.endsWith('/*') ? `${route.slice(0, -2)}/abc123` : route;
}

async function bodyAt(url: URL): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

function writeDashboardFixture(distDir: string): void {
  mkdirSync(join(distDir, 'assets', 'images'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), SHELL_HTML);
  writeFileSync(join(distDir, 'assets', 'app-abc123.js'), 'console.log("dashboard");');
  writeFileSync(join(distDir, 'assets', 'styles-def456.css'), 'body { color: red; }');
  writeFileSync(join(distDir, 'assets', 'images', 'logo.svg'), '<svg></svg>');
  writeFileSync(join(distDir, 'assets', '%2e%2e.txt'), 'encoded filename');
  writeFileSync(join(distDir, 'assets', 'empty.txt'), '');
  writeFileSync(join(distDir, 'secret.txt'), 'outside the asset directory');
}

describe('dashboard', () => {
  let distDir: string;
  let engine: Engine;
  let server: WeftServer | undefined;

  beforeEach(() => {
    distDir = mkdtempSync(join(tmpdir(), 'weft-dashboard-'));
    writeDashboardFixture(distDir);
    engine = new Engine({ storage: new MemoryStorage() });
    server = undefined;
  });

  afterEach(async () => {
    await server?.stop();
    engine[Symbol.dispose]();
    rmSync(distDir, { recursive: true, force: true });
  });

  function startDashboard(options: Partial<DashboardOptions> = {}): WeftServer {
    server = dashboard({
      engine,
      port: 0,
      hostname: '127.0.0.1',
      unauthenticatedAccess: 'allow',
      publicOrigin: 'http://discovery.test',
      workerShutdownTimeoutMs: 50,
      distDir,
      ...options,
    });
    return server;
  }

  it('serves the shell, an asset, and Weft health on the returned server origin', async () => {
    const { url } = startDashboard();

    expect(DASHBOARD_SHELL_ROUTES).toEqual([
      '/',
      '/workflows',
      '/workflows/*',
      '/reviews',
      '/workers',
      '/schedules',
      '/storage',
      '/system',
    ]);
    for (const route of DASHBOARD_SHELL_ROUTES) {
      const response = await fetch(new URL(pagePath(route), url));
      expect(response.status, route).toBe(200);
      expect(response.headers.get('content-type'), route).toBe('text/html; charset=utf-8');
      expect(await response.text(), route).toBe(SHELL_HTML);
    }

    const script = await fetch(new URL('/assets/app-abc123.js', url));
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(await script.text()).toBe('console.log("dashboard");');

    const health = await fetch(new URL('/v1/health', url));
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe('ok');

    for (const path of [...DIRECT_HTTP_ROUTES.map((route) => route.path), '/api/v1/health']) {
      const response = await fetch(new URL(path, url));
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toContain(SHELL_HTML);
    }
  });

  it('reads index.html on every request, so a rebuild needs no restart', async () => {
    const { url } = startDashboard();
    expect(await bodyAt(new URL('/', url))).toBe(SHELL_HTML);

    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Rebuilt</title>');
    expect(await bodyAt(new URL('/workflows', url))).toBe('<!doctype html><title>Rebuilt</title>');
  });

  it('serves only files inside the asset directory through GET and HEAD', async () => {
    const { url } = startDashboard();

    const stylesheetHead = await fetch(new URL('/assets/styles-def456.css', url), {
      method: 'HEAD',
    });
    expect(stylesheetHead.status).toBe(200);
    expect(stylesheetHead.headers.get('content-type')).toContain('text/css');
    expect(await stylesheetHead.text()).toBe('');

    const image = await fetch(new URL('/assets/images/logo.svg', url));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toContain('image/svg+xml');

    const encodedFilename = await fetch(new URL('/assets/%252e%252e.txt', url));
    expect(encodedFilename.status).toBe(200);
    expect(await encodedFilename.text()).toBe('encoded filename');

    // A zero-byte asset ends its stream before any read.
    const emptyAsset = await fetch(new URL('/assets/empty.txt', url));
    expect(emptyAsset.status).toBe(200);
    expect(await emptyAsset.text()).toBe('');

    for (const path of [
      '/assets/missing-999.js',
      '/assets/%',
      '/assets/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets//app-abc123.js',
    ]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain(distDir);
    }

    const post = await fetch(new URL('/assets/app-abc123.js', url), { method: 'POST' });
    expect(post.status).toBe(404);
    expect(await post.text()).not.toContain('dashboard');

    // There is no blanket catch-all: an unknown root path still reaches Weft.
    const unknownRoot = await fetch(new URL('/nonsense', url));
    expect(unknownRoot.status).toBe(404);
  });

  it('serves caller routes beside the dashboard routes', async () => {
    const { url } = startDashboard({ routes: { '/status': new Response('custom status') } });

    expect(await bodyAt(new URL('/status', url))).toBe('custom status');
    expect(await bodyAt(new URL('/', url))).toBe(SHELL_HTML);
  });

  it('throws before binding a port when caller routes contain a dashboard route', () => {
    const bunServe = spyOn(Bun, 'serve');
    try {
      for (const routeKey of ['/', '/workflows/*', '/system', '/assets/*']) {
        expect(() => startDashboard({ routes: { [routeKey]: new Response('mine') } })).toThrow(
          `dashboard() registers these routes itself, so remove them from routes: ${routeKey}`,
        );
      }
      expect(() =>
        startDashboard({
          routes: { '/status': new Response('ok'), '/reviews': new Response('mine') },
        }),
      ).toThrow('remove them from routes: /reviews');
      expect(bunServe).not.toHaveBeenCalled();
    } finally {
      bunServe.mockRestore();
    }
    expect(server).toBeUndefined();
  });

  it('leaves reserved-path checks on caller routes to serve()', () => {
    expect(() => startDashboard({ routes: { '/api/x': new Response('mine') } })).toThrow(
      '"/api/x" overlaps /api, /v1, /mcp, /jsonrpc, or a direct route',
    );
  });

  it('throws before binding a port when distDir has no index.html', () => {
    const emptyDirectory = join(distDir, 'empty');
    mkdirSync(emptyDirectory);
    const bunServe = spyOn(Bun, 'serve');
    try {
      expect(() => startDashboard({ distDir: emptyDirectory })).toThrow(
        `Weft's dashboard is not built: ${emptyDirectory} has no index.html. Build it by running \`${DASHBOARD_BUILD_COMMAND}\``,
      );
      expect(() => startDashboard({ distDir: join(distDir, 'index.html') })).toThrow(
        "Weft's dashboard is not built",
      );
      expect(bunServe).not.toHaveBeenCalled();
    } finally {
      bunServe.mockRestore();
    }
  });

  it('throws before binding a port when distDir has no assets directory', () => {
    rmSync(join(distDir, 'assets'), { recursive: true });
    expect(() => startDashboard()).toThrow(
      `Dashboard asset directory does not exist: ${join(distDir, 'assets')}`,
    );
  });

  it('defaults distDir to the dashboard directory at the package root', async () => {
    expect(defaultDashboardDirectory()).toBe(join(PACKAGE_ROOT, 'dashboard'));
    const manifest = (await Bun.file(join(PACKAGE_ROOT, 'package.json')).json()) as {
      name: string;
    };
    expect(manifest.name).toBe('@lostgradient/weft');
  });

  // Applies to a checkout without a dashboard build; a built tree serves it instead.
  it.skipIf(existsSync(join(PACKAGE_ROOT, 'dashboard', 'index.html')))(
    'without distDir, names the default directory and the build command when it is not built',
    () => {
      expect(() => dashboard({ engine, port: 0, unauthenticatedAccess: 'allow' })).toThrow(
        `Weft's dashboard is not built: ${join(PACKAGE_ROOT, 'dashboard')} has no index.html. Build it by running \`bun scripts/build-dashboard.ts\` in the @lostgradient/weft package, or pass distDir.`,
      );
    },
  );
});
