/**
 * Bundle-size budget gate (plan §12, T9.3). Reads the Vite build manifest
 * (`dist/.vite/manifest.json`, written because `vite.config.ts` sets
 * `build.manifest: true`) to resolve each named surface to its exact
 * built JS + CSS files, gzips each file directly — the same transfer
 * cost a browser actually pays over a compressed connection — and
 * hard-fails when a surface exceeds its budget.
 *
 * Why the manifest instead of matching `dist/assets/<name>-*.js` by
 * filename: Rollup's hash alphabet includes `-`, so a naive prefix match
 * can't reliably tell `workers-<hash>.js` (the workers ROUTE) apart from
 * `workers-data-<hash>.js` (a shared chunk workers AND dashboard cards
 * both import). The manifest's `src/routes/<domain>/index.svelte` keys —
 * the exact dynamic-import targets `src/app/routes.ts` uses — resolve
 * this precisely.
 *
 * Budgets below are MEASURED, not plan §12's original numbers. That
 * section lists aspirational targets (entry <15 KB, dashboard <30,
 * workflow list <40, workflow detail <60, highlighted editor chunk lazy <150)
 * written before a line of Svelte + cinder existed. Cinder's own base
 * styles, design tokens, and component set cost more than several of
 * those at rest — every enforced budget here is `budgetFromMeasuredKb`
 * applied to a measured baseline (i.e. `ceil(measuredKb * 1.2)`), with
 * the plan's original figure kept alongside as context, not as the
 * ceiling. See each `planNote` for that context, and re-measure
 * (`bun run check:bundle`) + update the baseline argument in the same PR
 * after an intentional size change — this script only catches
 * *regressions*.
 *
 * Route budgets don't split "workflow list" from "workflow detail" the
 * way plan §12's wording does: `src/app/routes.ts` maps both
 * `/workflows` and `/workflows/:id` to the same dynamic import
 * (`src/routes/workflows/index.svelte`), so they build as one chunk.
 *
 * One chunk outside the per-route budgets gets its own documented
 * allowance instead of a shared "reasonable size" heuristic: Cinder's
 * lazy JsonEditor enhancement chunk, resolved by its stable output stem.
 *
 * There used to be a second one: cinder's markdown-rendering Web Worker
 * (`render-worker-*.js`, pulled in by Reviews' artifact markdown viewer).
 * `@lostgradient/cinder/markdown/rendering`'s sync `renderMarkdown` barrel
 * forced a ~1.8 MB Worker bundle into any consumer's build graph with no
 * narrower subpath to opt out (filed upstream as stevekinney/cinder#835).
 * Cinder 0.17.0 extracted markdown into `@lostgradient/markdown` and split
 * the sync and Worker-based async rendering APIs into separate subpaths
 * (`./rendering` vs. `./rendering/async`) as part of that extraction,
 * closing #835 — `artifact-view.svelte` imports `@lostgradient/markdown/
 * rendering` directly and `render-worker-*.js` no longer appears in
 * `dist/assets/` at all (verified: zero matches on a clean `bun run
 * build`, not just a smaller one). There is nothing left to budget here.
 *
 * @module
 */
import { join } from 'node:path';

const DIST_DIR = join(import.meta.dir, '..', 'dist');
const MANIFEST_PATH = join(DIST_DIR, '.vite', 'manifest.json');

/** Fraction of headroom added on top of a measured baseline. */
const HEADROOM = 0.2;

/**
 * Turns a measured gzip-KB baseline into a hard-fail byte ceiling:
 * `measuredKb * (1 + HEADROOM)`, rounded up to the nearest whole KB. Budget
 * entries below pass the measured baseline captured on a clean `bun run
 * build` directly, so the enforced ceiling is always visibly derived from
 * it — never a hand-rounded number that can drift out of sync with the
 * baseline it's supposed to be 20% over.
 */
function budgetFromMeasuredKb(measuredKb: number): number {
  return Math.ceil(measuredKb * (1 + HEADROOM)) * 1024;
}

interface ManifestEntry {
  file: string;
  css?: string[];
}

type Manifest = Record<string, ManifestEntry>;

async function readManifest(): Promise<Manifest> {
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    throw new Error(
      `check-bundle-size: no manifest at ${MANIFEST_PATH}. Run "bun run build" first — ` +
        `this script measures an existing dist/, it doesn't build one.`,
    );
  }
  return manifestFile.json();
}

/** Gzips a single built asset (relative to `dist/`) and returns its byte size. */
async function gzipSize(relativeFile: string): Promise<number> {
  const bytes = await Bun.file(join(DIST_DIR, relativeFile)).bytes();
  return Bun.gzipSync(bytes).byteLength;
}

/** Sums the gzip size of a manifest entry's own JS file plus its CSS. */
async function manifestEntryGzipSize(entry: ManifestEntry): Promise<number> {
  const files = [entry.file, ...(entry.css ?? [])];
  const sizes = await Promise.all(files.map(gzipSize));
  return sizes.reduce((total, size) => total + size, 0);
}

function requireManifestEntry(manifest: Manifest, key: string): ManifestEntry {
  const entry = manifest[key];
  if (!entry) {
    throw new Error(
      `check-bundle-size: no manifest entry for "${key}" — did src/app/routes.ts or the ` +
        `editor module path change? Update this script's budget list to match.`,
    );
  }
  return entry;
}

interface Budget {
  /** Human label for the report. */
  label: string;
  /** Hard-fail ceiling in gzip bytes. */
  maxBytes: number;
  /** Context-only note — plan §12's original target, or why there isn't one. */
  planNote: string;
  /** Resolves the measured gzip byte size for this surface. */
  measure: (manifest: Manifest) => Promise<number>;
}

/** A per-domain route budget: `src/routes/<domain>/index.svelte`'s own JS + CSS. */
function routeBudget(domain: string, maxBytes: number, planNote: string): Budget {
  return {
    label: `route: ${domain}`,
    maxBytes,
    planNote,
    measure: (manifest) =>
      manifestEntryGzipSize(requireManifestEntry(manifest, `src/routes/${domain}/index.svelte`)),
  };
}

// Baselines measured on a clean `bun run build`. Re-measure and update the
// baseline argument after an intentional size change (see the module doc
// for the rounding/headroom formula `budgetFromMeasuredKb` applies) — the
// ceiling recomputes from it automatically. Re-measured for the
// @lostgradient/weft 0.12.0→0.15.0 / @lostgradient/cinder 0.17.0→0.19.0
// bump: entry grew (~62.2 KB → ~69.2 KB, still comfortably inside its
// ceiling) from cinder's larger component set. The current baselines below
// were re-measured after the Cinder 0.19.0 JsonEditor and curated-Shiki
// migration.
const BUDGETS: Budget[] = [
  {
    label: 'entry (index.html → main bundle)',
    maxBytes: budgetFromMeasuredKb(69.15),
    planNote: 'plan §12 aspirational target: <15 KB gzip (measured baseline: ~69.2 KB)',
    measure: (manifest) => manifestEntryGzipSize(requireManifestEntry(manifest, 'index.html')),
  },
  routeBudget(
    'dashboard',
    budgetFromMeasuredKb(9.17),
    'plan §12 aspirational target: <30 KB gzip (measured baseline: ~9.3 KB, well inside budget)',
  ),
  routeBudget(
    'workflows',
    budgetFromMeasuredKb(75.72),
    'plan §12 aspirational target: workflow list <40 KB / workflow detail <60 KB gzip separately — ' +
      'built as one chunk here (see module doc); measured baseline: ~75.7 KB',
  ),
  routeBudget(
    'schedules',
    budgetFromMeasuredKb(52.6),
    'no dedicated plan §12 line item (measured baseline: ~52.6 KB)',
  ),
  routeBudget(
    'workers',
    budgetFromMeasuredKb(7.66),
    'no dedicated plan §12 line item (measured baseline: ~7.7 KB)',
  ),
  routeBudget(
    'reviews',
    budgetFromMeasuredKb(50.21),
    'no dedicated plan §12 line item (measured baseline: ~49.9 KB)',
  ),
  routeBudget(
    'storage',
    budgetFromMeasuredKb(7.4),
    'no dedicated plan §12 line item (measured baseline: ~7.5 KB)',
  ),
  routeBudget(
    'system',
    budgetFromMeasuredKb(43.43),
    'no dedicated plan §12 line item (measured baseline: ~43.2 KB)',
  ),
  {
    label: 'lazy: Cinder JsonEditor enhancement chunk',
    maxBytes: budgetFromMeasuredKb(0.86),
    planNote:
      'plan §12 aspirational target: highlighted editor chunk lazy <150 KB gzip (measured baseline: ~0.87 KB)',
    measure: async () => {
      const assets = await Array.fromAsync(
        new Bun.Glob('json-editor-enhancement-*.js').scan({ cwd: join(DIST_DIR, 'assets') }),
      );
      if (assets.length !== 1) {
        throw new Error(
          `check-bundle-size: expected one JsonEditor enhancement chunk, found ${assets.length}. ` +
            'Run "bun run build" and update this resolver if Cinder changes its chunk name.',
        );
      }
      return gzipSize(`assets/${assets[0]}`);
    },
  },
];

interface BudgetResult {
  budget: Budget;
  actualBytes: number;
  withinBudget: boolean;
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

/**
 * Total-chunk-count regression guard.
 *
 * The per-surface budgets above measure each ROUTE and each documented
 * lazy chunk — but a full-shiki-bundle-style regression (see this
 * script's module docs: the bug this file was written to catch a recurrence
 * of) doesn't grow any
 * of those. It adds ~250 new grammar chunks and ~50 new theme chunks
 * that no per-surface budget names, so none of the checks above would
 * ever go red for it — `vite build` prints its own advisory ">500 kB
 * chunk" warning in that scenario but still exits 0. This asserts total
 * `.js` chunk count in `dist/assets/` instead, which that class of
 * regression can't avoid tripping.
 *
 * Baseline history: 391 chunks were measured with the original bare-
 * `shiki` bug present, 97 after that fix (`@lostgradient/cinder@0.16.1`
 * era). The bug reappeared one module deeper in `@lostgradient/cinder
 * @0.17.0` — `<CodeBlock>`'s default highlighter no longer imports bare
 * `shiki`, but still statically imports shiki's full `shiki/langs`/
 * `shiki/themes` tables (353 chunks measured before this baseline's
 * fix) — closed by aliasing those two specifiers instead
 * curated highlighter entrypoint, which also shrank the
 * baseline below the original 97 (down to 56: cinder's older bare-`shiki`
 * shim curated a fake `shiki` module entirely, while this version only
 * needs to curate the two tables cinder's adapter actually reads). This
 * check exists so a reintroduction, from any future importer of a
 * full-catalog shiki module, fails CI instead of quietly bloating `dist/`
 * again.
 *
 * The headroom here is deliberately much looser than `HEADROOM` above
 * (2x, not 1.2x): this guard's job is catching a catastrophic multiplier,
 * not tracking the one-or-two-chunk growth ordinary feature work adds
 * across the other tracks building on this codebase in parallel.
 */
const MEASURED_JS_CHUNK_COUNT = 353;
const CHUNK_COUNT_HEADROOM_MULTIPLIER = 2;
const MAX_JS_CHUNK_COUNT = MEASURED_JS_CHUNK_COUNT * CHUNK_COUNT_HEADROOM_MULTIPLIER;

async function countJsChunks(): Promise<number> {
  const glob = new Bun.Glob('*.js');
  const matches = await Array.fromAsync(glob.scan({ cwd: join(DIST_DIR, 'assets') }));
  return matches.length;
}

async function run(): Promise<void> {
  const manifest = await readManifest();

  const results: BudgetResult[] = await Promise.all(
    BUDGETS.map(async (budget) => {
      const actualBytes = await budget.measure(manifest);
      return { budget, actualBytes, withinBudget: actualBytes <= budget.maxBytes };
    }),
  );

  const labelWidth = Math.max(...results.map((result) => result.budget.label.length));
  console.log('Bundle size budgets (gzip):\n');
  for (const { budget, actualBytes, withinBudget } of results) {
    const status = withinBudget ? 'OK  ' : 'FAIL';
    console.log(
      `  [${status}] ${budget.label.padEnd(labelWidth)}  ${formatKb(actualBytes).padStart(11)} / ` +
        `${formatKb(budget.maxBytes).padStart(11)} budget`,
    );
    console.log(`           ${' '.repeat(labelWidth)}  ${budget.planNote}`);
  }

  const jsChunkCount = await countJsChunks();
  const chunkCountWithinBudget = jsChunkCount <= MAX_JS_CHUNK_COUNT;
  console.log(
    `  [${chunkCountWithinBudget ? 'OK  ' : 'FAIL'}] total JS chunk count in dist/assets/`.padEnd(
      labelWidth + 10,
    ) +
      `  ${String(jsChunkCount).padStart(11)} / ${String(MAX_JS_CHUNK_COUNT).padStart(11)} budget`,
  );
  console.log(
    `           ${' '.repeat(labelWidth)}  regression guard for a full-shiki-bundle-style chunk explosion ` +
      `(measured baseline: ${MEASURED_JS_CHUNK_COUNT})`,
  );

  const failures = results.filter((result) => !result.withinBudget);
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${results.length} bundle size budget(s) exceeded:`);
    for (const { budget, actualBytes } of failures) {
      console.error(
        `  - ${budget.label}: ${formatKb(actualBytes)} exceeds the ${formatKb(budget.maxBytes)} budget ` +
          `by ${formatKb(actualBytes - budget.maxBytes)}`,
      );
    }
  }
  if (!chunkCountWithinBudget) {
    console.error(
      `\ntotal JS chunk count ${jsChunkCount} exceeds the regression-guard budget of ${MAX_JS_CHUNK_COUNT} ` +
        `(baseline ${MEASURED_JS_CHUNK_COUNT} × ${CHUNK_COUNT_HEADROOM_MULTIPLIER}). This usually means a ` +
        `full-catalog shiki import (bare "shiki", or "shiki/langs"/"shiki/themes" imported outside ` +
        `the curated loader maps) slipped into the build — see src/lib/code-highlighter.ts.`,
    );
  }
  if (failures.length > 0 || !chunkCountWithinBudget) {
    process.exit(1);
  }

  console.log(`\nAll ${results.length} bundle size budgets and the chunk-count guard passed.`);
}

await run();
