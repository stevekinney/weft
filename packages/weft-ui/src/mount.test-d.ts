/**
 * Type-level test (plan §11.6): `weftConsole()` must satisfy the published
 * `DashboardRouteTarget` type from `@lostgradient/weft/server`. This file
 * asserts types only — it is not a `bun:test` file (the `.test-d.ts`
 * suffix intentionally does not match the `*.test.ts` glob `bun test`
 * runs) and is checked by `bun run typecheck` (svelte-check) instead.
 */
import type { DashboardAssets, DashboardRouteTarget } from '@lostgradient/weft/server';

import { weftConsole, weftConsoleAssets } from './mount.ts';

const dashboard: DashboardRouteTarget = weftConsole();
void dashboard;

const dashboardWithDistDir: DashboardRouteTarget = weftConsole({
  distDir: '/tmp/weft-console-dist',
});
void dashboardWithDistDir;

const assets: DashboardAssets = weftConsoleAssets();
void assets;

const assetsWithDistDir: DashboardAssets = weftConsoleAssets({
  distDir: '/tmp/weft-console-dist',
});
void assetsWithDistDir;
