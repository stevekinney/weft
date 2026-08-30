/**
 * Bun-mount integration test (plan §3.1, §11.5: "a booted `serve({ dashboard })`
 * serves the shell at all page routes and never shadows `/api/*` or root
 * discovery routes"). Boots a REAL in-process `serve({ engine, dashboard,
 * dashboardAssets })` — no mock server, per §11.3 — and proves the
 * `@lostgradient/weft@0.16.0` mount contract this package's README documents:
 *
 * - The shell HTML answers `200` at every `DASHBOARD_PAGE_ROUTES` entry —
 *   eight routes as of weft 0.16.0 (weft#841 extended the table with
 *   `/schedules`, `/storage`, `/system`, making the console's leaf routes
 *   real deep-linkable page routes).
 * - `dashboardAssets` (weft#840) serves the shell's content-hashed files
 *   under `/assets/*` from the mount itself — the reverse-proxy workaround
 *   the README used to document is obsolete, and this test is the guard
 *   that it stays obsolete.
 * - The mount never shadows the API or discovery routes: `/v1/health` and
 *   `/openapi.json` still answer as API endpoints, and an unknown `/assets/*`
 *   path 404s instead of falling back to the shell.
 *
 * Uses a synthetic `distDir` (a temp directory shaped like a Vite build:
 * `index.html` + `assets/<hashed>.js`/`.css`) rather than the repo's real
 * `dist/` — `bun run test` runs before `bun run build` in the gate, so the
 * real bundle may not exist yet; the mount contract under test (route table +
 * asset serving) is shape-dependent, not content-dependent. The e2e suite
 * exercises the real bundle separately.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '@lostgradient/weft';
import { DASHBOARD_PAGE_ROUTES, serve } from '@lostgradient/weft/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { weftUi, weftUiAssets } from '../../src/mount.ts';

const SHELL_HTML =
  '<!doctype html><html><body><div id="app">weft console shell</div></body></html>';
const ASSET_JS = 'console.log("weft console chunk");';
const ASSET_CSS = ':root { --weft-ui: 1; }';

async function createMountTestEngine() {
  return Engine.create({ workflows: {} });
}

let distDir: string;
let server: ReturnType<typeof serve>;
let engine: Awaited<ReturnType<typeof createMountTestEngine>>;
let baseUrl: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'weft-ui-mount-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), SHELL_HTML);
  writeFileSync(join(distDir, 'assets', 'index-abc123.js'), ASSET_JS);
  writeFileSync(join(distDir, 'assets', 'index-abc123.css'), ASSET_CSS);

  engine = await createMountTestEngine();
  server = serve({
    engine,
    port: 0,
    unauthenticatedAccess: 'allow',
    dashboard: weftUi({ distDir }),
    dashboardAssets: weftUiAssets({ distDir }),
  });
  baseUrl = server.url.replace(/\/+$/, '');
});

afterAll(async () => {
  await server.stop();
  await engine.shutdown();
  rmSync(distDir, { recursive: true, force: true });
});

describe('serve({ dashboard, dashboardAssets }) — weft 0.16.0 mount contract', () => {
  test('the shell HTML answers 200 at every DASHBOARD_PAGE_ROUTES entry', async () => {
    // `/workflows/*` is a wildcard pattern — probe it with a concrete id.
    const probePaths = DASHBOARD_PAGE_ROUTES.map((route) =>
      route === '/workflows/*' ? '/workflows/wf_deep_link_probe' : route,
    );

    for (const path of probePaths) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toStartWith('text/html');
      expect(await response.text()).toBe(SHELL_HTML);
    }
  });

  test('the route table includes the weft#841 leaf routes', () => {
    // Pins the adoption this repo depends on: /schedules, /storage, /system
    // are real page routes, not client-side-only sub-routes anymore.
    expect(DASHBOARD_PAGE_ROUTES).toContain('/schedules');
    expect(DASHBOARD_PAGE_ROUTES).toContain('/storage');
    expect(DASHBOARD_PAGE_ROUTES).toContain('/system');
  });

  test('dashboardAssets serves the built JS and CSS under /assets/*', async () => {
    const js = await fetch(`${baseUrl}/assets/index-abc123.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(ASSET_JS);

    const css = await fetch(`${baseUrl}/assets/index-abc123.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(ASSET_CSS);
  });

  test('an unknown /assets/* path 404s instead of serving the shell', async () => {
    const response = await fetch(`${baseUrl}/assets/does-not-exist.js`);
    expect(response.status).toBe(404);
  });

  test('the mount never shadows the API or discovery routes', async () => {
    const health = await fetch(`${baseUrl}/v1/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toStartWith('application/json');

    const openapi = await fetch(`${baseUrl}/openapi.json`);
    expect(openapi.status).toBe(200);
    expect(openapi.headers.get('content-type')).toStartWith('application/json');
  });
});
