/**
 * Type-level test (plan §11.6): `weftUi()` must satisfy the published
 * `DashboardRouteTarget` type from `@lostgradient/weft/server`. This file
 * asserts types only — it is not a `bun:test` file (the `.test-d.ts`
 * suffix intentionally does not match the `*.test.ts` glob `bun test`
 * runs) and is checked by `bun run typecheck` (svelte-check) instead.
 */
import type { DashboardAssets, DashboardRouteTarget } from '@lostgradient/weft/server';

import { weftUi, weftUiAssets } from './mount.ts';

const dashboard: DashboardRouteTarget = weftUi();
void dashboard;

const dashboardWithDistDir: DashboardRouteTarget = weftUi({
  distDir: '/tmp/weft-ui-dist',
});
void dashboardWithDistDir;

const assets: DashboardAssets = weftUiAssets();
void assets;

const assetsWithDistDir: DashboardAssets = weftUiAssets({
  distDir: '/tmp/weft-ui-dist',
});
void assetsWithDistDir;
