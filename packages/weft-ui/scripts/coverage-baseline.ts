/**
 * Measured coverage floor for `bun run check:coverage` (scripts/check-coverage.ts).
 *
 * This is a RATCHET, not the plan's target: `docs/implementation-plan.md` §11
 * targets 100% adjusted coverage with an explicit reviewed allowance file,
 * weft-style, once the console's surfaces stabilize. That is aspirational and
 * not enforced here — this file only records the highest measured watermark
 * so coverage cannot silently regress below it. Bump numbers upward (never
 * downward without a written reason in the PR) whenever `bun run
 * check:coverage` reports a new high-water mark; regenerate by running it and
 * copying the printed per-area/overall counts below.
 *
 * PROVISIONAL — see the note above `overall` before trusting these numbers.
 */

/** Raw hit/found counts for one coverage area (or the `overall` rollup). */
export type AreaCoverage = {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

export type CoverageBaseline = {
  measuredAt: string;
  /**
   * Re-measured 2026-08-11 after the cinder 0.23.0 / weft 0.18.0 wave.
   * Absolute covered lines rose again (23,180 → 23,273). One area moved for a
   * reason worth recording rather than silently re-baselining: `src/lib`
   * reported 60.65% against a 60.92% floor, entirely from LINE ATTRIBUTION,
   * not lost coverage. `scopes.svelte.ts`'s module doc shrank by ~25 lines
   * when the probe-and-infer explanation was replaced by the
   * `weft.system.principal` description, which renumbers the whole file and
   * shifts how the Svelte-compiled output maps back to source lines — the
   * "uncovered" lines it reports are the `AUTHORIZATION_SCOPES` literal and
   * class-declaration lines, which are plainly executed (41 passing tests in
   * `scopes.svelte.test.ts` + `scopes.svelte.integration.test.ts` exercise
   * every branch of `resolvePrincipal`, `hasScope`, `bannerMode`,
   * `denyScope`, and `scopeGate`, the last two against real `serve()`
   * instances). Coverage of the module went UP in substance: its three boot
   * outcomes are now pinned on the wire instead of against a fake client.
   *
   * Earlier note (2026-08-10), kept for context: re-measured after the
   * cinder 0.22.0 / weft 0.16.0 dependency
   * wave. Absolute covered lines ROSE (23,003 → 23,180) but a few area
   * percentages dipped fractionally, for structural reasons reviewed in that
   * change: `src/lib` lost exactly the two covered lines of the removed
   * `budget:*` scopes (weft#844); `src/routes/system` grew with the new
   * authoritative Active-alerts section (weft#843) whose compiled template
   * branches are partially covered; `tests` (= `tests/setup.ts` + the smoke
   * harnesses — test FILES are not instrumented) shifted because every test
   * file now imports `@testing-library/svelte` statically, so setup.ts's
   * dynamic-import fallback paths no longer execute. That static-import
   * conversion is itself the fix for `bun test --parallel=1` hard-failing
   * whenever the library's module-scope `beforeEach()` registration first
   * evaluated INSIDE a running test — the root cause of the coverage suite's
   * 378-failure crashes (and the likely identity of the previously
   * intermittent full-suite failure).
   *
   * Earlier note (2026-07-24), kept for context: re-measured after the
   * Cinder 0.19.0 migration. Coverage runs serially because Bun's
   * default-parallel coverage workers can collide on the integration
   * servers' ephemeral ports; the exact command is recorded in
   * package.json's `test:coverage` script.
   *
   * 2026-07-24 SIGTRAP investigation (isolated worktree): the earlier
   * full-parallel SIGTRAP (exit 133; crash report
   * ~/Library/Logs/DiagnosticReports/bun-2026-07-24-121054.ips) did NOT
   * reproduce in 3/3 loaded runs on Bun 1.3.13 — artificial load produced
   * EADDRINUSE noise instead, consistent with the port-collision rationale
   * above — and the full suite ran clean on Bun 1.3.14. Not escalated to
   * oven-sh/bun without a reproduction. Also verified: `--path-ignore-patterns`
   * takes real GLOBS matched against the path (`'*storage-client*'` excludes;
   * a bare substring like `'storage-client'` matches nothing — Jest-style
   * regex-substring expectations do not transfer), and explicitly named file
   * arguments override ignore patterns.
   */
  overall: AreaCoverage;
  areas: Record<string, AreaCoverage>;
};

/**
 * Platforms the coverage gate records separate baselines for.
 *
 * Bun's LCOV attribution is DETERMINISTIC per platform but materially
 * different between macOS and Linux: the same commit, same suite, and same
 * 1213-test pass produced e.g. `src/routes/system` 89.26% lines on darwin
 * vs 26.31% on linux (CI run 31435362335, byte-identical across a rerun —
 * some areas measure higher on linux, some lower, so neither is a subset
 * of the other). One shared floor therefore cannot gate both environments;
 * each platform ratchets against numbers measured on that platform.
 */
export type CoverageMeasurementPlatform = 'darwin' | 'linux';

/** The current process's baseline platform, or `null` when unrecognized. */
export function coverageMeasurementPlatform(): CoverageMeasurementPlatform | null {
  return process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null;
}

const DARWIN_BASELINE: CoverageBaseline = {
  // Re-measured 2026-08-24 for WFC-10 after fixing a genuine Bun 1.3.14
  // coverage-engine bug in `scripts/run-coverage.ts`: `bun test --parallel`
  // (even at N=1) implies `--isolate`, giving each test file a fresh module
  // registry. When a Svelte component is both directly unit-tested AND
  // statically imported by a sibling component also under test (e.g.
  // `timeline-tab.svelte` tested directly by `timeline-tab.test.ts` AND
  // imported by `workflow-detail.svelte`, tested by
  // `workflow-detail.test.ts`), that isolation produces two
  // differently-instrumented instances of the shared file, and Bun's LCOV
  // merge does not correctly union their per-line hit counts — one
  // instance's (lower) numbers clobber the other's. Confirmed by bisection:
  // reproducible with a fresh `BUN_RUNTIME_TRANSPILER_CACHE_PATH` (rules out
  // the persistent disk cache), independent of test order (rules out a
  // WFC-9-style ordering fix), and gone entirely once `--parallel=1` is
  // dropped (two full-suite runs without it produced near-identical LCOV,
  // 1290/1290 tests passing both times, one line differing only in a
  // timing-sensitive hit COUNT rather than hit/not-hit). Filed upstream:
  // https://github.com/oven-sh/bun/issues/40386. This is the same evidentiary bar WFC-5's Linux fix
  // (PR #12, commit a7d6603) set for a baseline correction: a directly
  // measured, reproduced, root-caused re-measurement — not a guess to absorb
  // a regression. Every area rose; none needed a downward correction.
  //
  // A small residual variance (a handful of lines out of ~34k, unrelated to
  // the --parallel bug above) exists between individual runs, isolated to
  // `src/routes/dashboard` and (rarely) `src/routes/workflows` — neither
  // touched by this ticket's domain work. Per area, this baseline uses
  // whichever observed state is the SAFE (lower-percentage) floor: for
  // `workflows`/`OVERALL` that means the exact tuple from the one lower-
  // percentage run out of 6 (workflows 92.61% lines / 93.55% functions vs.
  // the other 5 runs' 93.15%/93.58%) — an earlier version of this baseline
  // used the 5-run MAJORITY value instead, which sat above that 6th run's
  // measurement and would have failed the gate roughly 1 time in 6 for no
  // real regression; corrected before merge. `dashboard` already used the
  // lower-percentage-state methodology correctly.
  //
  // Re-measured again 2026-08-25 after the workers (`f327874`), storage
  // (`236aef7`), and system (`1c40222`) domain commits landed on top of the
  // tooling fix above — the previous entry here only reflected the
  // workflows-domain + tooling-fix state and was stale for those three
  // areas (flagged in PR #14 review). This is the final post-all-domain-work
  // measurement.
  measuredAt: '2026-08-25T00:30:00.000Z',
  overall: { linesFound: 33847, linesHit: 31753, functionsFound: 6492, functionsHit: 6155 },
  areas: {
    fixtures: { linesFound: 698, linesHit: 319, functionsFound: 69, functionsHit: 12 },
    scripts: { linesFound: 753, linesHit: 682, functionsFound: 36, functionsHit: 35 },
    src: { linesFound: 12, linesHit: 12, functionsFound: 2, functionsHit: 2 },
    'src/app': { linesFound: 1301, linesHit: 1261, functionsFound: 282, functionsHit: 267 },
    'src/lib': { linesFound: 1195, linesHit: 1186, functionsFound: 192, functionsHit: 188 },
    'src/routes/dashboard': {
      linesFound: 1444,
      linesHit: 1185,
      functionsFound: 239,
      functionsHit: 214,
    },
    'src/routes/reviews': {
      linesFound: 2264,
      linesHit: 2111,
      functionsFound: 439,
      functionsHit: 418,
    },
    'src/routes/schedules': {
      linesFound: 3500,
      linesHit: 3402,
      functionsFound: 727,
      functionsHit: 701,
    },
    'src/routes/storage': {
      linesFound: 2739,
      linesHit: 2708,
      functionsFound: 532,
      functionsHit: 520,
    },
    'src/routes/system': {
      linesFound: 4866,
      linesHit: 4846,
      functionsFound: 1002,
      functionsHit: 985,
    },
    'src/routes/workers': {
      linesFound: 3363,
      linesHit: 3209,
      functionsFound: 677,
      functionsHit: 666,
    },
    'src/routes/workflows': {
      linesFound: 11592,
      linesHit: 10735,
      functionsFound: 2281,
      functionsHit: 2134,
    },
    // Bun 1.4 / happy-dom 20.11.0 no longer needs the 25-line
    // `Element.prototype.remove()` workaround in `tests/setup.ts`. Removing
    // its two covered functions leaves the same one uncovered test helper;
    // the lower function percentage (13/14 vs. 15/16) is a denominator-only
    // source-shape change, while line coverage improves (97/120 vs. 114/145).
    tests: { linesFound: 120, linesHit: 97, functionsFound: 14, functionsHit: 13 },
  },
};

/**
 * Recorded from CI run 31500023108's bootstrap-mode output (ubuntu runner,
 * 2026-08-11) after the cinder 0.23.0 / weft 0.18.0 wave re-bootstrapped it.
 * Linux attribution differs from darwin's in both directions (see the
 * platform-divergence note on {@link CoverageMeasurementPlatform}), so these
 * numbers are NOT comparable to `DARWIN_BASELINE`'s — each ratchets only
 * against its own platform's measurements.
 */
const LINUX_BASELINE: CoverageBaseline = {
  // Re-measured 2026-08-24 for WFC-5 (PR #12): `src/routes/schedules` failed
  // the Linux gate three consecutive times with the IDENTICAL
  // `61.70% < baseline 61.71%` line/lines regression, even after the fourth
  // commit (0585822) added a new deterministic test —
  // `ScheduleDetail > a current run renders a "running" Badge on the
  // current-run link` — that specifically targets the previously-suspect
  // `{#if schedule.currentWorkflowId}` branch and DID pass on Linux CI (run
  // 32543992714, job 96959141755: `(pass) ScheduleDetail > a current run
  // renders a "running" Badge on the current-run link [1147.99ms]`).
  // Functions coverage for the same area (83.98%) matched the baseline
  // exactly, with zero regression, both before and after that test existed.
  // That is conclusive that the 0.01-point line gap is a stable Linux LCOV
  // line-attribution artifact for this file (Svelte's compiled output can
  // map lines differently across platforms — see the note on
  // `CoverageMeasurementPlatform` below), not a real uncovered line. This is
  // the same class of correction PR #11 ("Recompute Linux coverage
  // aggregate", a7fd8d6) already made for the overall aggregate, and the
  // same pattern already used above for `src/routes/dashboard`'s Linux
  // floor: "retain a slightly lower ... floor to avoid rounding a passing
  // measurement into a false regression."
  //
  // CI's `check:coverage` only prints per-area PERCENTAGES, not raw
  // linesFound/linesHit, and no LCOV artifact was uploaded for run
  // 32543992714 (`gh api .../artifacts` returned zero), so the exact current
  // Linux integers are not directly recoverable from that run's log.
  // Reconstructed instead from the known baseline pair (3748 found / 2313
  // hit = 61.7134%, i.e. the 61.71% baseline shown) plus this branch's only
  // source change in the area across all 3 code-changing commits — a 2-net-
  // line edit inside `schedule-detail.svelte`'s `{#if
  // schedule.currentWorkflowId}` Badge block (33e69e6/d16a555/0585822;
  // `schedule-detail.test.ts` gained assertions but no other `src/routes/
  // schedules` file changed). A local darwin re-measurement of the same diff
  // (`bun run check:coverage` against HEAD @ 0585822 vs. the recorded darwin
  // baseline) attributed that change as exactly +1 found / +1 hit line, with
  // functions unchanged. Enumerating every (dFound, dHit) pair with
  // 0 <= dHit <= dFound <= 8 against the printed 61.70% (i.e. a ratio in
  // [61.695%, 61.705%)) yields exactly three candidates: (3749, 2313),
  // (3752, 2315), (3755, 2317). (3749, 2313) — dFound +1, dHit +0 — is both
  // the one that mirrors darwin's measured attribution for the identical
  // diff AND the minimum of the feasible set, so it is a safe floor: if the
  // true Linux pair turns out to be either of the other two candidates
  // instead, this floor still passes against it. functionsFound/
  // functionsHit are left unchanged (487/409) since function coverage was
  // never in regression.
  //
  // Approved 2026-08-21 by the repo owner after reviewing this exact
  // evidence chain ("Yes, re-baseline it").
  //
  // Superseded 2026-08-25 for WFC-10 (PR #14): the darwin `--parallel`
  // coverage-engine fix documented on `DARWIN_BASELINE` above applies
  // equally to Linux CI (`.github/workflows/ci.yaml`'s `coverage` job runs
  // on `ubuntu-latest`), so the pre-fix Linux floor recorded here was
  // stale and no longer functioned as a real ratchet (flagged in review —
  // Linux CI could pass while losing most of the newly measured coverage,
  // since actual coverage sat far above this floor). Unlike the
  // `schedules` fix above, exact integers did not need reconstruction this
  // time: `.github/workflows/ci.yaml`'s `coverage` job now uploads
  // `coverage/lcov.info` as a build artifact (added in this same PR), so
  // this is downloaded directly from CI run 32795118494's
  // `coverage-lcov-linux` artifact and parsed with this file's own
  // `parseLcov`/`aggregateByArea` — not reconstructed or estimated.
  //
  // `workflows`/`OVERALL` here use the same safe-floor tuple as
  // `DARWIN_BASELINE`'s matching correction rather than this single CI
  // run's own (higher) sample: the darwin side measured `workflows` landing
  // in a lower-percentage state in 1 of 6 consecutive runs (92.61% lines /
  // 93.55% functions vs. the other 5 runs' 93.15%/93.58%), and this run's
  // Linux sample matched darwin's higher state exactly (11581/10788/
  // 2291/2144) — a single sample can't rule out the same variance
  // recurring here, so the lower-state tuple is used defensively rather
  // than risk a false Linux CI regression later.
  measuredAt: '2026-08-25T00:44:00.000Z',
  overall: { linesFound: 33864, linesHit: 31770, functionsFound: 6498, functionsHit: 6160 },
  areas: {
    fixtures: { linesFound: 698, linesHit: 319, functionsFound: 69, functionsHit: 12 },
    scripts: { linesFound: 753, linesHit: 682, functionsFound: 36, functionsHit: 35 },
    src: { linesFound: 12, linesHit: 12, functionsFound: 2, functionsHit: 2 },
    'src/app': { linesFound: 1301, linesHit: 1261, functionsFound: 282, functionsHit: 267 },
    'src/lib': { linesFound: 1195, linesHit: 1186, functionsFound: 192, functionsHit: 188 },
    'src/routes/dashboard': {
      linesFound: 1444,
      linesHit: 1185,
      functionsFound: 239,
      functionsHit: 214,
    },
    'src/routes/reviews': {
      linesFound: 2264,
      linesHit: 2111,
      functionsFound: 439,
      functionsHit: 418,
    },
    'src/routes/schedules': {
      linesFound: 3500,
      linesHit: 3402,
      functionsFound: 727,
      functionsHit: 701,
    },
    'src/routes/storage': {
      linesFound: 2739,
      linesHit: 2708,
      functionsFound: 532,
      functionsHit: 520,
    },
    'src/routes/system': {
      linesFound: 4866,
      linesHit: 4846,
      functionsFound: 1002,
      functionsHit: 985,
    },
    'src/routes/workers': {
      linesFound: 3380,
      linesHit: 3226,
      functionsFound: 683,
      functionsHit: 672,
    },
    'src/routes/workflows': {
      linesFound: 11592,
      linesHit: 10735,
      functionsFound: 2281,
      // Bun 1.4.0 changed Linux-only Svelte coverage attribution for
      // `timeline-tab.svelte`: the exact pre-upgrade main artifact reported
      // 531/511 lines and 118/114 functions, while the Bun 1.4 artifact
      // reports 542/458 and 108/103. The aggregate baseline already carried
      // the new line vocabulary; this one-function correction records the
      // measured 1.4 function tuple. All 1,395 tests still pass, and Darwin
      // remains gated against its independently measured floor above.
      functionsHit: 2133,
    },
    // Same source-shape correction as the Darwin baseline above. The setup
    // module is platform-independent; Linux CI measures the same test helper
    // vocabulary even though application LCOV attribution differs by platform.
    tests: { linesFound: 120, linesHit: 97, functionsFound: 14, functionsHit: 13 },
  },
};

export const COVERAGE_BASELINES: Record<CoverageMeasurementPlatform, CoverageBaseline | null> = {
  darwin: DARWIN_BASELINE,
  linux: LINUX_BASELINE,
};
