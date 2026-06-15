import { $, Glob } from 'bun';
import { execFileSync } from 'node:child_process';

// Bun parses `bunfig.toml` natively when imported, so `coveragePathIgnorePatterns`
// stays a single source of truth (no hand-rolled TOML parse that could drift). The
// path resolves relative to THIS file, so it holds regardless of the invocation cwd.
import bunfig from '../bunfig.toml';

type ExecFileFailure = Error & {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  status?: number;
};

type CoverageResult = {
  covered: boolean;
  lines: { total: number; hit: number; missed: number };
  functions: { total: number; hit: number; missed: number };
  uncoveredFiles: string[];
};

type FileCoverageResult = {
  covered: boolean;
  lines: { total: number; hit: number; missed: number };
  functions: { total: number; hit: number; missed: number };
};

type CoverageAllowance = {
  functions?: number;
  lines?: Set<number>;
};

type CoverageAllowanceEntry = readonly [path: string, allowance: CoverageAllowance];

/**
 * Build one allowance layer from its raw entry array, failing loudly on a duplicate
 * key WITHIN the layer. A `new Map([...])` silently keeps only the last entry for a
 * repeated key, so a copy-paste duplicate inside a single literal would quietly drop
 * an allowance with no signal (this exact bug shipped mid-PR in #516). Keeping the
 * entries as a named array and asserting `length === unique keys` here turns that
 * silent drop into a build-time error naming the layer and key.
 */
export function buildAllowanceLayer(
  layerName: string,
  entries: ReadonlyArray<CoverageAllowanceEntry>,
): Map<string, CoverageAllowance> {
  const seen = new Set<string>();
  for (const [path] of entries) {
    if (seen.has(path)) {
      throw new Error(
        `Duplicate coverage-allowance key "${path}" within ${layerName}. ` +
          'A Map literal silently keeps only the last entry for a repeated key; ' +
          'merge the two entries into one so no allowance is dropped.',
      );
    }
    seen.add(path);
  }
  return new Map(entries);
}

type NamedAllowanceLayer = readonly [name: string, layer: ReadonlyMap<string, CoverageAllowance>];

/**
 * Assert that two refresh layers partition their keys: a key in BOTH means removing
 * its row from one layer silently re-activates the other layer's (often
 * stale-line-numbered) allowance — a silent gate flip. The two layers are passed by
 * direct reference rather than matched by name against the ordered layer list, so a
 * renamed or mistyped layer can never silently skip this check (which would defeat
 * the whole point: a guard against silent allowance failures must not itself fail
 * silently). Base/override layering against a refresh layer stays legal.
 */
function assertRefreshLayersPartitionKeys(
  first: NamedAllowanceLayer,
  second: NamedAllowanceLayer,
): void {
  const [firstName, firstLayer] = first;
  const [secondName, secondLayer] = second;
  for (const key of firstLayer.keys()) {
    if (secondLayer.has(key)) {
      throw new Error(
        `Coverage-allowance key "${key}" appears in both ${firstName} and ${secondName}. ` +
          'A key may live in at most one refresh layer, or removing one row silently ' +
          'reactivates the other layer’s (possibly stale) allowance.',
      );
    }
  }
}

/**
 * Assemble the final allowance map from its ordered layers (last layer wins for a
 * shadowed key — the intended base→override mechanic), after asserting the two
 * mutually-exclusive refresh layers partition their keys (see
 * {@link assertRefreshLayersPartitionKeys}).
 */
export function assembleAllowanceLayers(
  layers: ReadonlyArray<NamedAllowanceLayer>,
  refreshLayers: readonly [NamedAllowanceLayer, NamedAllowanceLayer],
): Map<string, CoverageAllowance> {
  assertRefreshLayersPartitionKeys(refreshLayers[0], refreshLayers[1]);
  const assembled = new Map<string, CoverageAllowance>();
  for (const [, layer] of layers) {
    for (const [key, allowance] of layer) {
      assembled.set(key, allowance);
    }
  }
  return assembled;
}

/**
 * Read `coveragePathIgnorePatterns` from `bunfig.toml`. A file matching one of these is
 * excluded from LCOV instrumentation entirely — it never appears as an `SF:` record — so
 * any allowance keyed to such a path is DEAD: it ignores nothing and its line numbers
 * silently drift as the file is edited, looking live while being inert (this is what
 * happened to the old `scripts/check-coverage.ts` self-allowance, dead since 501d14ef).
 * Reading the patterns from `bunfig.toml` keeps it the single source of truth rather than
 * hardcoding the list here.
 */
export function readCoveragePathIgnorePatterns(): string[] {
  const patterns = bunfig.test?.coveragePathIgnorePatterns;
  if (patterns === undefined) return [];
  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern: unknown) => typeof pattern !== 'string')
  ) {
    throw new Error(
      'bunfig.toml [test].coveragePathIgnorePatterns must be an array of strings; ' +
        `got ${JSON.stringify(patterns)}.`,
    );
  }
  return patterns;
}

/**
 * Whether an allowance key (a repo-relative file path) would be excluded by a
 * `coveragePathIgnorePatterns` entry. Bun matches these patterns against LCOV file paths
 * as GLOBS — NOT substrings — so this uses {@link Glob} for every pattern. Verified
 * empirically (see the characterization test in `check-coverage.test.ts`): a bare
 * `nested` does NOT exclude `sub/nested-file.ts` (a substring matcher would wrongly flag
 * it — a false positive), while `*`, `?`, `[…]`, and `**` all behave as glob
 * metacharacters (a `*`-only matcher would miss `?`/`[…]` — a false negative). An exact
 * filename like `scripts/check-coverage.ts` is a glob with no metacharacters and matches
 * the literal path. Matching Bun exactly is the whole point: a mismatch produces either a
 * dead allowance that slips through or a live allowance wrongly rejected.
 */
function allowanceKeyMatchesIgnorePattern(key: string, pattern: string): boolean {
  return new Glob(pattern).match(key);
}

/**
 * Reject any allowance key that matches a `coveragePathIgnorePatterns` entry. Such a key
 * is a dead allowance — the file it names is never instrumented, so the allowance can
 * never fire — and worse, its line numbers drift silently as the file changes. This
 * closes the dead-allowance class systematically, the same way {@link buildAllowanceLayer}
 * (within-layer duplicates) and {@link assertRefreshLayersPartitionKeys} (cross-shadowed
 * refresh keys) close the duplicate / cross-shadow classes (#539).
 */
export function assertNoAllowanceKeyIsCoverageIgnored(
  allowances: ReadonlyMap<string, CoverageAllowance>,
  ignorePatterns: readonly string[],
): void {
  for (const key of allowances.keys()) {
    for (const pattern of ignorePatterns) {
      if (allowanceKeyMatchesIgnorePattern(key, pattern)) {
        throw new Error(
          `Coverage-allowance key "${key}" matches coveragePathIgnorePatterns entry ` +
            `"${pattern}" in bunfig.toml. That file is excluded from LCOV instrumentation, ` +
            'so the allowance is dead (it ignores nothing and its line numbers drift ' +
            'silently). Remove the allowance entry, or un-ignore the path in bunfig.toml.',
        );
      }
    }
  }
}

const COVERAGE_TEST_TIMEOUT_MS = 30_000;
const COVERAGE_TEST_FILE_GLOBS = ['*test.ts', '*spec.ts'] as const;

function isExecFileFailure(error: unknown): error is ExecFileFailure {
  return error instanceof Error;
}

function writeCapturedOutput(output: Buffer | string | undefined): void {
  if (output === undefined) return;
  if (typeof output === 'string') {
    process.stderr.write(output);
    return;
  }
  process.stderr.write(output);
}

function isGeneratedCoverageArtifact(filePath: string): boolean {
  // Bun records generated fixture paths relative to the coverage-run CWD, so worktree
  // depth changes the number of `../` segments and the temp root may be `var/folders/`,
  // `private/tmp/`, or `tmp/` (#503). The second matcher still gates this to known
  // fixture names, so a non-fixture temp file is not caught.
  if (
    /(?:\.\.\/)+(?:private\/)?(?:var\/folders\/|tmp\/)/.test(filePath) &&
    /(?:\/weft-(?:schedule(?:-lmdb)?-(?:workflows|input)|cli-edge-workflows)-[^/]+\.ts$|\/weft-validate-[^/]+\/[^/]+\.ts$|\/weft-validate-(?:json-invalid|mixed-(?:clean|invalid)|multi-[ab])-[^/]+\.ts$)/.test(
      filePath,
    )
  ) {
    return true;
  }

  return false;
}

function createLineSet(startLine: number, endLine: number): Set<number> {
  return new Set(
    Array.from({ length: endLine - startLine + 1 }, (_value, index) => startLine + index),
  );
}

function createMergedLineSet(...lineSets: Array<Set<number>>): Set<number> {
  return new Set(lineSets.flatMap((lineSet) => [...lineSet]));
}

const BASE_COVERAGE_ALLOWANCES = buildAllowanceLayer('BASE_COVERAGE_ALLOWANCES', [
  // No self-allowance for scripts/check-coverage.ts: bunfig.toml excludes it via
  // `coveragePathIgnorePatterns = ["scripts/check-coverage.ts"]` (since 501d14ef),
  // so the file never appears as an `SF:` record in LCOV and any allowance for it
  // is dead — COVERAGE_ALLOWANCES.get('scripts/check-coverage.ts') can never fire.
  // The old entry's `createLineSet(153, 265)` range was also already stale after
  // this PR shifted the file's lines (flagged by Cursor Bugbot on #538).
  [
    'scripts/generate-operation-client.ts',
    {
      // The type-generation logic is exercised in-process by the generator test
      // suite. The remaining lines are the `import.meta.main` child-process
      // entrypoint plus a Bun line-mapping miss on the object-render close
      // brace after the function's returned string has already been asserted.
      lines: new Set([117, 118, 119, 120, 121, 122, 262]),
    },
  ],
  [
    'scripts/run-gates.ts',
    {
      // `runPipeline` / `main` (ordering, fail-fast, framing, summary) are
      // unit-tested in scripts/run-gates.test.ts with a stub gate runner. The
      // excluded surface is `spawnGate` (lines 88-101) and the `import.meta.main`
      // entrypoint (line 189): both shell out to real `bun run` child processes,
      // exercised end-to-end by `bun run validate` / `bun run prepack`. This is
      // the same allowance shape this script uses for its own shell wrapper.
      functions: 1,
      lines: createMergedLineSet(createLineSet(88, 101), new Set([189])),
    },
  ],
  [
    'scripts/verify-no-test-sleeps.ts',
    {
      // The detector and CLI status handling are unit-tested in-process. The
      // remaining two lines are the `import.meta.main` wrapper that only
      // executes when Bun launches the script as a standalone program.
      lines: new Set([204, 205]),
    },
  ],
  [
    'examples/hello-world/src/index.ts',
    {
      // The example module exports are covered in-process by `src/examples.test.ts`.
      // The remaining four lines are the `import.meta.main` demo entrypoint, which
      // only runs in a child `bun run` process and is therefore outside Bun's
      // parent-process LCOV instrumentation.
      lines: new Set([68, 69, 71, 72]),
    },
  ],
  [
    'src/benchmarks/benchmark-subprocess.ts',
    {
      // These branches only execute when a child benchmark subprocess fails to
      // emit a valid payload. The happy path is exercised by the benchmark
      // suite, but the failure branches require synthetic subprocess faults.
      lines: new Set([49, 50, 59, 64]),
    },
  ],
  [
    'src/benchmarks/workflow-starts-runner.ts',
    {
      // The throughput benchmark intentionally measures a fresh `bun run`
      // subprocess because Bun coverage does not propagate into child runs.
      // The direct helper exports are exercised in-process by the test suite;
      // the remaining runner path is only observed through the child process.
      functions: 2,
      lines: createMergedLineSet(
        createLineSet(24, 67),
        createLineSet(73, 75),
        createLineSet(77, 90),
      ),
    },
  ],
  [
    'src/core/compression.ts',
    {
      // Bun's coverage run cannot simulate runtimes where brotli support is absent.
      lines: new Set([20, 21, 23]),
    },
  ],
  [
    'src/core/engine.ts',
    {
      // Bun's lcov output for this file reports aggregate misses on a trivial
      // public wrapper plus nested async cleanup closures that are exercised by
      // the engine cleanup suite. The affected lines are coverage-mapping drift,
      // not untested user-visible behavior.
      functions: 9,
      lines: createMergedLineSet(
        createLineSet(2574, 2578),
        createLineSet(8297, 8299),
        new Set([8363]),
      ),
    },
  ],
  [
    'src/core/context/child-workflow-pipe.ts',
    {
      lines: new Set([44, 46, 47, 64, 65, 101, 114]),
    },
  ],
  [
    'src/core/context/durable-operations.ts',
    {
      lines: new Set([113, 117, 118, 119]),
    },
  ],
  [
    'src/core/context/parallel-cache-entry.ts',
    {
      functions: 1,
    },
  ],
  [
    'src/core/context/parallel-operations.ts',
    {
      functions: 1,
      lines: new Set([
        30, 31, 32, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 77, 78, 79, 86, 87,
        88, 171, 172, 173, 191, 192, 193, 295, 296, 297, 310, 328, 329, 331, 332, 333, 334, 335,
        336, 337, 338, 339, 340, 342,
      ]),
    },
  ],
  [
    'src/core/context/session-state.ts',
    {
      lines: new Set([64, 66, 126, 131, 142]),
    },
  ],
  [
    'src/core/engine/attributes-tags.ts',
    {
      functions: 1,
      lines: new Set([101, 187, 188, 190, 327, 356, 387, 405, 406, 407, 419, 468, 475, 476, 482]),
    },
  ],
  [
    'src/core/engine/broadcast.ts',
    {
      lines: new Set([46]),
    },
  ],
  [
    'src/core/engine/bulk-operations.ts',
    {
      lines: new Set([87, 245, 425, 426]),
    },
  ],
  [
    'src/core/engine/callback-creators.ts',
    {
      functions: 17,
      lines: new Set([
        209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 223, 224, 225, 226, 239, 333, 369, 409,
        643, 644, 645, 646, 653, 656, 657, 658, 659, 663, 707, 716, 751, 752, 753, 754, 755, 955,
      ]),
    },
  ],
  [
    'src/core/engine/child-workflow.ts',
    {
      lines: new Set([99, 122]),
    },
  ],
  [
    'src/core/engine/constraints.ts',
    {
      lines: new Set([60, 65]),
    },
  ],
  [
    'src/core/engine/handle-result.ts',
    {
      lines: new Set([63, 84, 85, 98, 100, 101, 121]),
    },
  ],
  [
    'src/core/engine/index.ts',
    {
      functions: 2,
    },
  ],
  [
    'src/core/engine/inline-launch-queue.ts',
    {
      functions: 1,
      lines: new Set([29, 31, 32, 33, 42, 43, 75, 165]),
    },
  ],
  [
    'src/core/engine/inline-parking.ts',
    {
      lines: new Set([119, 120, 123, 140, 142, 143, 144, 145]),
    },
  ],
  [
    'src/core/engine/lifecycle.ts',
    {
      functions: 2,
      lines: new Set([
        85, 86, 87, 88, 89, 90, 91, 142, 162, 163, 164, 179, 180, 247, 248, 249, 250, 251, 295, 443,
        444, 445, 446, 782, 783, 784, 933, 934, 935, 1194, 1203, 1204, 1205, 1206, 1207, 1208, 1209,
        1210, 1211, 1212, 1213, 1214, 1243, 1251, 1252, 1253, 1284, 1288, 1340, 1341, 1342, 1343,
        1344, 1345, 1346, 1347, 1348, 1349, 1350, 1351, 1352, 1353, 1354, 1355, 1385, 1386, 1387,
        1388, 1389, 1390, 1391, 1392,
      ]),
    },
  ],
  [
    'src/core/engine/listing.ts',
    {
      lines: new Set([132]),
    },
  ],
  [
    'src/core/engine/operations-coordination.ts',
    {
      lines: new Set([
        74, 75, 76, 81, 82, 83, 84, 85, 86, 92, 286, 290, 326, 327, 328, 329, 330, 331, 332, 333,
        365,
      ]),
    },
  ],
  [
    'src/core/engine/operations-data.ts',
    {
      lines: new Set([66]),
    },
  ],
  [
    'src/core/engine/operations-router.ts',
    {
      lines: new Set([
        114, 121, 124, 125, 128, 129, 130, 131, 132, 133, 135, 138, 139, 140, 141, 142, 143, 144,
        145, 268,
      ]),
    },
  ],
  [
    'src/core/engine/operations-time.ts',
    {
      lines: new Set([
        126, 131, 132, 133, 134, 135, 141, 142, 143, 144, 145, 152, 153, 154, 155, 156, 164, 165,
        166, 167, 168, 177, 211, 224,
      ]),
    },
  ],
  [
    'src/core/engine/pending-updates.ts',
    {
      functions: 1,
      lines: new Set([45, 79]),
    },
  ],
  [
    'src/core/engine/queries.ts',
    {
      lines: new Set([16]),
    },
  ],
  [
    'src/core/engine/registration.ts',
    {
      lines: new Set([196]),
    },
  ],
  [
    'src/core/engine/reviews.ts',
    {
      lines: new Set([85, 153, 154, 170, 180, 184, 185, 225]),
    },
  ],
  [
    'src/core/engine/schedules.ts',
    {
      lines: new Set([77, 195, 245, 367, 389, 392, 407, 468, 473]),
    },
  ],
  [
    'src/core/engine/signals.ts',
    {
      lines: new Set([
        83, 93, 96, 115, 119, 133, 199, 289, 291, 292, 293, 294, 296, 297, 298, 311, 319, 321, 322,
        323, 324, 325, 327, 328, 329, 330, 331, 332,
      ]),
    },
  ],
  [
    'src/core/engine/state-utilities.ts',
    {
      functions: 1,
      lines: new Set([84, 160, 192, 204, 242, 264, 275, 315, 340, 360, 410, 411, 412, 413]),
    },
  ],
  [
    'src/core/engine/storage-io.ts',
    {
      functions: 1,
      lines: new Set([68]),
    },
  ],
  [
    'src/core/engine/strategy-helpers.ts',
    {
      lines: new Set([42, 44, 45, 46, 47, 48, 49]),
    },
  ],
  [
    'src/core/engine/sub-operation.ts',
    {
      lines: new Set([161, 213, 215]),
    },
  ],
  [
    'src/core/engine/termination.ts',
    {
      lines: new Set([
        159, 160, 188, 292, 403, 410, 411, 412, 413, 415, 419, 420, 421, 422, 424, 506, 612, 638,
        639,
      ]),
    },
  ],
  [
    'src/core/engine/updates.ts',
    {
      lines: new Set([146, 341, 348]),
    },
  ],
  [
    'src/core/engine/validation.ts',
    {
      functions: 2,
      lines: new Set([
        41, 47, 51, 69, 95, 101, 110, 137, 163, 178, 183, 199, 208, 215, 224, 228, 256, 281, 282,
        284, 285, 302, 307, 316, 322, 327, 355, 361, 366, 374, 379, 384, 389,
      ]),
    },
  ],
  [
    'src/core/schedule.ts',
    {
      // The remaining misses are Bun line-mapping noise on fully tested
      // branches plus the bounded search guard that would require forcing
      // 100,000 failed cron iterations without any matching date.
      functions: 1,
      lines: new Set([356, 530]),
    },
  ],
  [
    'src/core/schedule/cron-formatter.ts',
    {
      functions: 1,
      lines: new Set([185, 187]),
    },
  ],
  [
    'src/core/schedule/cron-occurrence.ts',
    {
      lines: new Set([183]),
    },
  ],
  [
    'src/core/scheduler/duration.ts',
    {
      lines: new Set([38, 39, 40, 46, 47, 48, 91]),
    },
  ],
  [
    'src/core/scheduler/timer-sources.ts',
    {
      lines: new Set([26, 79, 80, 81, 82]),
    },
  ],
  [
    'src/core/tenant-quotas/manager-storage.ts',
    {
      lines: new Set([32, 51, 73, 95, 100, 101, 102, 103, 105]),
    },
  ],
  [
    'src/core/tenant-quotas/storage-helpers.ts',
    {
      lines: new Set([
        47, 54, 121, 129, 145, 153, 158, 168, 196, 210, 215, 220, 228, 234, 239, 258, 265, 273,
      ]),
    },
  ],
  [
    'src/core/inline-execution-strategy.ts',
    {
      // Bun reports one unnamed aggregate function miss in this class-based
      // module despite complete line coverage and direct behavioral tests.
      functions: 1,
    },
  ],
  [
    'src/core/worker-execution-strategy.ts',
    {
      // Bun reports one unnamed aggregate function miss in this worker wrapper
      // despite complete line coverage and direct behavioral tests.
      functions: 1,
    },
  ],
  [
    'src/server/handler.ts',
    {
      // Bun leaves a handful of schedule-error return lines and
      // route-precedence helper branches uncovered even after the dedicated
      // handler regression tests exercise them, and it also leaves the
      // defensive malformed-route rethrow line uncovered.
      functions: 1,
      lines: new Set([228, 232, 236, 515, 516, 558, 560, 602, 735, 2170]),
    },
  ],
  [
    'src/server/index.ts',
    {
      // Line coverage is complete. Bun still reports one unnamed aggregate
      // function miss in the surrounding fetch/websocket adapter despite the
      // JSON-RPC hand-off and auth-contract error path being exercised directly.
      functions: 1,
    },
  ],
  [
    'src/server/authentication/index.ts',
    {
      lines: new Set([137]),
    },
  ],
  [
    'src/server/handler/index.ts',
    {
      lines: new Set([85, 86]),
    },
  ],
  [
    'src/server/operations/fork-workflow.ts',
    {
      // Bun leaves the fallback fault-return line uncovered after the
      // non-EngineFailure shapeFault branch is exercised directly in tests.
      lines: new Set([93]),
    },
  ],
  [
    'src/server/operations/resume-workflow.ts',
    {
      // Bun leaves the fallback fault-return line uncovered after the
      // non-EngineFailure shapeFault branch is exercised directly in tests.
      lines: new Set([74]),
    },
  ],
  [
    'src/server/operations/timeout-workflow.ts',
    {
      // Bun leaves the fallback fault-return line uncovered after the
      // non-EngineFailure shapeFault branch is exercised directly in tests.
      lines: new Set([58]),
    },
  ],
  [
    'src/server/json-rpc-websocket.ts',
    {
      // Line coverage is complete. Bun still reports one unnamed aggregate
      // function miss in this closure-heavy session adapter after the error,
      // termination, and subscription branches are exercised directly.
      functions: 1,
    },
  ],
  [
    'src/server/runtime/websocket-stream.ts',
    {
      functions: 1,
    },
  ],
  [
    'src/server/stdio-session.ts',
    {
      // Bun maps the closing lines of the main framing loops as uncovered even
      // though the oversize, resync, partial-frame, and chunked-admission paths
      // all execute. It also leaves one unnamed aggregate function miss in this
      // adapter after the writer-close and admission helpers are covered.
      functions: 1,
      lines: new Set([353, 392]),
    },
  ],
  [
    'src/server/workflow-event-feed.ts',
    {
      // Bun maps the closing line of the live-drain generator's intentional
      // infinite loop as uncovered. Every exit path returns from inside the loop
      // and is covered by behavioral tests.
      lines: new Set([405]),
    },
  ],
]);

const COVERAGE_ALLOWANCE_OVERRIDES = buildAllowanceLayer('COVERAGE_ALLOWANCE_OVERRIDES', [
  // Post-#182 line movement plus newer runtime-exclusive surfaces shifted a
  // substantial amount of Bun's coverage noise. Keep the allowances aligned
  // with the current source layout rather than pretending these are new test
  // gaps when they still require cross-runtime or instrumentation-only paths.
  [
    'src/cli/conformance.ts',
    {
      // These are private conformance-harness race exits: predicates throwing
      // inside the bounded wait loop, or a worker disconnecting between a
      // successful poll and the follow-up dispatch or cancel action.
      // The real success path and invalid-worker path are covered end-to-end;
      // deterministic coverage here would require replacing the server runtime
      // with a fake and would no longer validate the protocol contract.
      functions: 1,
      lines: new Set([55, 106, 161, 232]),
    },
  ],
  [
    'src/core/context/session-state.ts',
    {
      functions: 6,
      lines: new Set([
        71, 73, 133, 138, 151, 152, 153, 157, 161, 165, 170, 229, 244, 247, 250, 251, 252, 253, 256,
        259, 260, 261, 262, 263, 264, 265, 268, 269, 270, 271, 272, 273, 274,
      ]),
    },
  ],
  [
    'src/core/context/parallel-operations.ts',
    {
      functions: 1,
      lines: new Set([
        30, 31, 32, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 77, 78, 79, 86, 87,
        88, 171, 172, 173, 191, 192, 193, 295, 296, 297, 310, 328, 329, 331, 332, 333, 334, 335,
        336, 337, 338, 339, 340, 342,
      ]),
    },
  ],
  [
    'src/core/engine/attributes-tags.ts',
    {
      functions: 1,
      lines: new Set([102, 189, 190, 192, 329, 358, 389, 421, 470, 477, 478, 484]),
    },
  ],
  [
    'src/core/engine/bulk-operations.ts',
    {
      lines: new Set([87, 245, 408, 409]),
    },
  ],
  [
    'src/core/engine/callback-creators.ts',
    {
      functions: 20,
      lines: createMergedLineSet(
        createLineSet(220, 229),
        createLineSet(234, 237),
        new Set([250, 356, 394]),
        createLineSet(434, 436),
        createLineSet(705, 708),
        new Set([715]),
        createLineSet(718, 721),
        new Set([725]),
        createLineSet(727, 731),
        new Set([789, 800]),
        createLineSet(837, 841),
        new Set([1060]),
      ),
    },
  ],
  [
    'src/core/engine/child-workflow.ts',
    {
      lines: new Set([104, 128, 139]),
    },
  ],
  [
    'src/core/engine/inline-launch-queue.ts',
    {
      functions: 1,
      lines: new Set([29, 31, 32, 33, 42, 43, 75, 166]),
    },
  ],
  [
    'src/core/engine/lifecycle.ts',
    {
      functions: 3,
      lines: createMergedLineSet(
        createLineSet(201, 207),
        new Set([262]),
        createLineSet(282, 284),
        new Set([299, 300]),
        createLineSet(367, 371),
        new Set([417]),
        createLineSet(567, 570),
        createLineSet(911, 913),
        createLineSet(1062, 1064),
        new Set([1291, 1316]),
        createLineSet(1327, 1344),
        new Set([1380, 1409]),
        createLineSet(1417, 1419),
        new Set([1450, 1454]),
        createLineSet(1507, 1523),
        createLineSet(1553, 1560),
      ),
    },
  ],
  [
    'src/core/engine/operations-coordination.ts',
    {
      lines: new Set([
        74, 75, 76, 81, 82, 83, 84, 85, 86, 92, 288, 292, 328, 329, 330, 331, 332, 333, 334, 335,
        367,
      ]),
    },
  ],
  [
    'src/core/engine/operations-router.ts',
    {
      lines: new Set([
        121, 128, 131, 132, 135, 136, 137, 138, 139, 140, 142, 145, 146, 147, 148, 149, 150, 151,
        152, 279,
      ]),
    },
  ],
  [
    'src/core/engine/operations-state.ts',
    {
      lines: new Set([44, 45, 46, 47, 48, 49, 50, 51, 52]),
    },
  ],
  [
    'src/core/engine/operations-time.ts',
    {
      lines: new Set([
        127, 132, 133, 134, 135, 136, 142, 143, 144, 145, 146, 153, 154, 155, 156, 157, 165, 166,
        167, 168, 169, 178, 212, 225,
      ]),
    },
  ],
  [
    'src/core/engine/queries.ts',
    {
      lines: new Set([17]),
    },
  ],
  [
    'src/core/engine/schedules.ts',
    {
      lines: new Set([78, 196, 246, 368, 390, 393, 408, 469, 474]),
    },
  ],
  [
    'src/core/engine/state-utilities.ts',
    {
      functions: 1,
      lines: new Set([86, 168, 200, 212, 250, 272, 283, 323, 348, 368, 418, 419, 420, 421]),
    },
  ],
  [
    'src/core/engine/strategy-helpers.ts',
    {
      lines: new Set([46, 48, 49, 50, 51, 52, 53]),
    },
  ],
  [
    'src/core/engine/sub-operation.ts',
    {
      lines: new Set([
        91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
        111, 112, 113, 114, 115, 116, 190, 210, 212,
      ]),
    },
  ],
  [
    'src/core/engine/termination.ts',
    {
      lines: new Set([
        159, 160, 188, 289, 376, 383, 384, 385, 386, 388, 392, 393, 394, 395, 397, 479, 585, 611,
        612,
      ]),
    },
  ],
  [
    'src/core/engine/validation.ts',
    {
      functions: 2,
      lines: new Set([
        41, 47, 51, 69, 95, 101, 110, 137, 163, 178, 183, 199, 208, 215, 224, 228, 256, 281, 282,
        284, 285, 314, 319, 328, 334, 339, 367, 373, 378, 386, 391, 396, 401,
      ]),
    },
  ],
  [
    'src/core/interceptor/index.ts',
    {
      functions: 1,
      lines: new Set([25, 26, 27]),
    },
  ],
  [
    'src/core/search-attributes.ts',
    {
      lines: new Set([175, 176, 177, 178, 179, 180]),
    },
  ],
  [
    'src/core/types/activity.ts',
    {
      lines: new Set([249, 250, 251, 256]),
    },
  ],
  [
    'src/core/types/message-handles.ts',
    {
      functions: 2,
      lines: new Set([94, 108, 109, 110]),
    },
  ],
  [
    'src/core/types/schedules.ts',
    {
      functions: 1,
      lines: new Set([90, 91, 92]),
    },
  ],
  [
    // One overload/declaration function Bun cannot attribute line coverage to.
    // (The former line allowance pointed past end-of-file — the file is 400
    // lines — and covered no real uncovered line, so it was removed.)
    'src/core/types/workflow-function.ts',
    {
      functions: 1,
    },
  ],
  [
    'src/server/api-catalog.ts',
    {
      lines: new Set([159, 160, 164, 165, 167, 168, 169, 170, 172, 174]),
    },
  ],
  [
    'src/server/asyncapi.ts',
    {
      lines: new Set([96, 191, 192, 193, 194, 195]),
    },
  ],
  [
    'src/server/authorization.ts',
    {
      lines: new Set([159]),
    },
  ],
  [
    'src/server/json-rpc-websocket.ts',
    {
      functions: 5,
      lines: new Set([118, 156]),
    },
  ],
  [
    'src/server/openapi-schemas.ts',
    {
      lines: new Set([73, 91, 92]),
    },
  ],
  [
    'src/server/openapi.ts',
    {
      lines: new Set([117, 118]),
    },
  ],
  [
    'src/server/operation-catalog/stream-pipeline.ts',
    {
      functions: 2,
      lines: new Set([
        34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
        57, 58, 59, 60, 61, 62, 63, 255,
      ]),
    },
  ],
  [
    'src/server/operation-catalog/workflow-adapter.ts',
    {
      lines: new Set([178, 179, 180, 181, 182, 186, 187, 190, 191, 192, 193, 194, 198, 199]),
    },
  ],
  [
    'src/server/operations/query-workflow.ts',
    {
      lines: new Set([118, 119, 120, 121, 122]),
    },
  ],
  [
    'src/server/operations/storage.ts',
    {
      functions: 2,
      lines: new Set([
        112, 113, 114, 115, 116, 183, 184, 190, 191, 192, 197, 198, 199, 200, 201, 255, 328, 329,
        330,
      ]),
    },
  ],
  [
    'src/server/stdio-session.ts',
    {
      functions: 1,
      lines: new Set([354, 393]),
    },
  ],
  [
    'src/service-worker/setup.ts',
    {
      functions: 1,
      lines: new Set([154, 157, 158, 159, 160, 249, 250, 251, 253, 254, 328, 329, 330]),
    },
  ],
  [
    'src/storage/auto.ts',
    {
      functions: 1,
      lines: new Set([67, 68, 69, 70, 107, 109, 110, 111, 112, 113, 114, 116, 117, 118, 121]),
    },
  ],
  [
    'src/storage/resolve.ts',
    {
      // Pre-existing untestable runtime-detection and driver-import fallback
      // branches: Node/web-extension/IndexedDB resolver paths (never the active
      // runtime under the Bun test suite), the SQLite "neither runtime" throw,
      // and the LMDB/Turso resolver + Turso validator bodies (need a real driver).
      // Line numbers refreshed after the WS2 refactor moved the configuration
      // types out into storage-configuration.ts; the function count is unchanged.
      functions: 6,
      lines: new Set([
        70, 71, 72, 73, 74, 79, 80, 81, 82, 83, 87, 96, 98, 99, 100, 101, 102, 103, 105, 113, 115,
        116, 117, 118, 119, 120, 122, 123, 124, 125, 126, 135, 136, 137, 140, 141, 142, 143, 144,
        145, 183, 191, 216, 237, 244, 245, 246, 247, 273, 274, 275, 276, 277, 278,
      ]),
    },
  ],
  [
    'src/storage/web-extension.ts',
    {
      functions: 12,
      lines: new Set([
        195, 196, 197, 266, 267, 268, 269, 270, 271, 272, 273, 274, 332, 333, 334, 335, 336, 337,
        338, 339, 340, 341, 342, 343, 344, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387,
        427, 428, 429, 430, 437, 438, 439, 440, 441, 442, 443, 444, 459,
      ]),
    },
  ],
  [
    'src/testing/event-loop.ts',
    {
      functions: 1,
      lines: new Set([20, 21]),
    },
  ],
  [
    'src/workers/workflow-runner.ts',
    {
      functions: 3,
      lines: new Set([78, 79, 80, 81, 82, 83, 86, 87, 93, 94, 95, 96, 97]),
    },
  ],
]);

// Keep the fresh mainline coverage refresh separate from the historical base
// allowances so line-movement updates are mechanically reviewable and do not
// create duplicate keys inside a single Map literal.
const CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES = buildAllowanceLayer(
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES',
  [
    [
      'scripts/lib/workflow-visibility-backfill.ts',
      {
        lines: new Set([
          61, 130, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199,
        ]),
      },
    ],
    ['src/cli/codegen-emit.ts', { lines: new Set([303, 313, 357, 358, 425, 427]) }],
    [
      'src/cli/codegen.ts',
      {
        functions: 1,
        lines: new Set([91, 92, 153, 154, 203, 248, 249, 379, 410, 411, 412, 414, 415, 416, 417]),
      },
    ],
    [
      'src/cli/conformance.ts',
      {
        functions: 1,
        lines: new Set([55, 106, 128, 146, 150, 151, 166, 167, 168, 221, 287, 325]),
      },
    ],
    ['src/client/http-handle.ts', { functions: 1 }],
    ['src/client/http-schedule-handle.ts', { functions: 1 }],
    ['src/client/local.ts', { functions: 1, lines: new Set([124]) }],
    [
      'src/core/context/parallel-operations.ts',
      {
        functions: 1,
        lines: new Set([
          30, 31, 32, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 77, 78, 79, 86,
          87, 88, 171, 172, 173, 191, 192, 193, 295, 296, 297, 310, 330, 331, 333, 334, 335, 336,
          337, 338, 339, 340, 341, 342, 344,
        ]),
      },
    ],
    ['src/core/engine/aggregate.ts', { functions: 1, lines: new Set([47, 48, 49, 50, 51, 52]) }],
    [
      'src/core/engine/attributes-tags.ts',
      {
        functions: 2,
        lines: new Set([
          50, 51, 53, 191, 220, 253, 285, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301,
          302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319,
          320, 321,
        ]),
      },
    ],
    [
      'src/core/engine/bulk-operations.ts',
      {
        functions: 1,
        lines: new Set([572, 588, 714, 715, 716, 717, 723, 724, 725, 726, 879]),
      },
    ],
    [
      'src/core/engine/completed-review-storage.ts',
      { lines: new Set([18, 30, 108, 113, 114, 115, 117, 118, 119, 120, 124]) },
    ],
    ['src/core/engine/index.ts', { functions: 1 }],
    [
      'src/core/engine/inline-parking.ts',
      { functions: 1, lines: new Set([204, 205, 206, 207, 208, 209, 210, 211]) },
    ],
    [
      'src/core/engine/list-candidate-resolution.ts',
      {
        lines: new Set([
          42, 45, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
          68, 69, 70, 71, 72, 73, 74, 75, 76, 78, 80, 81, 82, 83,
        ]),
      },
    ],
    ['src/core/engine/listing.ts', { lines: new Set([52, 83, 180, 202]) }],
    ['src/core/engine/review-list-entries.ts', { lines: new Set([84, 145]) }],
    ['src/core/engine/reviews.ts', { lines: new Set([148, 208, 209, 225, 235, 239, 240, 286]) }],
    [
      'src/core/engine/state-utilities.ts',
      { lines: new Set([282, 286, 287, 288, 289, 297, 301, 302, 303, 304, 305, 306, 317, 318]) },
    ],
    ['src/core/engine/validation.ts', { lines: new Set([291]) }],
    ['src/core/engine/workflow-indexes.ts', { functions: 1, lines: new Set([43, 44, 45, 46, 47]) }],
    ['src/core/engine/workflow-state-stream.ts', { lines: new Set([114]) }],
    ['src/core/types/definition-schema-to-json.ts', { lines: new Set([135, 136, 137, 140, 141]) }],
    ['src/core/worker-checkpoint-resume-state.ts', { functions: 1 }],
    ['src/core/worker-execution-strategy.ts', { functions: 2 }],
    [
      'src/mcp/access.ts',
      { functions: 1, lines: new Set([36, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 117]) },
    ],
    ['src/mcp/dispatcher.ts', { functions: 7, lines: new Set([110, 111, 114, 210, 211, 212]) }],
    [
      'src/mcp/http.ts',
      {
        lines: new Set([
          110, 111, 112, 113, 114, 115, 116, 117, 193, 194, 217, 227, 270, 349, 350, 351, 352, 353,
          356, 357, 358, 359,
        ]),
      },
    ],
    [
      'src/mcp/list-filter.ts',
      {
        lines: new Set([
          64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 88, 89, 90, 91, 92, 93, 94, 95, 96,
          102,
        ]),
      },
    ],
    ['src/mcp/protocol.ts', { functions: 3, lines: new Set([89, 94, 95, 96, 101]) }],
    [
      'src/mcp/resources.ts',
      {
        functions: 2,
        lines: new Set([
          39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
          61, 62, 63, 64, 65, 66, 67, 68, 130, 163, 188, 203, 204,
        ]),
      },
    ],
    ['src/mcp/session.ts', { functions: 1, lines: new Set([152, 153, 154]) }],
    [
      'src/mcp/stdio.ts',
      {
        functions: 3,
        lines: new Set([
          98, 99, 100, 101, 102, 121, 122, 200, 201, 202, 203, 204, 205, 206, 207, 232, 233, 270,
          271, 272, 273, 332, 333, 352, 353, 354, 355, 356, 357, 358, 359,
        ]),
      },
    ],
    [
      'src/mcp/tools.ts',
      {
        functions: 1,
        lines: new Set([67, 124, 125, 158, 178, 179, 292, 293, 294, 295, 296, 352, 353, 379]),
      },
    ],
    [
      'src/server/api-catalog.ts',
      { lines: new Set([161, 162, 166, 167, 169, 170, 171, 172, 174, 176]) },
    ],
    ['src/server/handler/index.ts', { lines: new Set([38, 47]) }],
    ['src/server/json-rpc-dispatch.ts', { lines: new Set([188, 189]) }],
    ['src/server/openapi.ts', { lines: new Set([334]) }],
    ['src/server/openrpc.ts', { lines: new Set([178, 179, 180, 199, 200, 201]) }],
    [
      'src/server/operation-catalog/workflow-adapter.ts',
      { lines: new Set([179, 180, 181, 182, 183, 187, 188, 191, 192, 193, 194, 195, 199, 200]) },
    ],
    [
      'src/server/operations/aggregate-workflows.ts',
      {
        functions: 2,
        lines: new Set([
          78, 79, 80, 81, 82, 83, 84, 103, 104, 105, 106, 107, 116, 117, 118, 135, 136, 137, 138,
          148,
        ]),
      },
    ],
    [
      'src/server/operations/bulk-filter-helpers.ts',
      {
        functions: 1,
        lines: new Set([
          262, 267, 272, 277, 282, 287, 295, 296, 297, 298, 306, 307, 308, 309, 310, 311, 312, 313,
          314, 315, 316, 317, 318, 374, 377, 380, 387, 392, 397, 403, 444, 456, 469, 479,
        ]),
      },
    ],
    [
      'src/server/operations/failure-category-filter.ts',
      { functions: 1, lines: new Set([13, 14, 15, 16, 17, 18, 19]) },
    ],
    [
      'src/server/operations/get-task-diagnostics.ts',
      { lines: new Set([228, 229, 230, 231, 232]) },
    ],
    ['src/server/operations/list-workflows.ts', { functions: 1 }],
    ['src/server/operations/query-workflow.ts', { lines: new Set([112, 113, 114, 115, 116]) }],
    [
      'src/server/operations/start-workflow.ts',
      { functions: 1, lines: new Set([174, 199, 200, 201, 205, 210, 211, 212, 233]) },
    ],
    [
      'src/server/operations/worker-drain.ts',
      { functions: 2, lines: new Set([251, 258, 259, 260, 264, 265, 266, 267, 268]) },
    ],
    [
      'src/storage/turso.ts',
      {
        // This is the defensive rollback-suppression helper used after a libSQL
        // transaction already failed. Real libSQL rollback failures are not
        // deterministic to trigger; the behavior preserves the original failure.
        // The retry sleep is only reached on a transient libSQL busy response,
        // which is covered structurally by the retry caller and hard to force
        // deterministically through the public adapter without timing races.
        functions: 1,
        lines: new Set([48, 49, 50, 56, 57, 58]),
      },
    ],
    ['src/testing/fake-timers.test-support.ts', { lines: new Set([232]) }],
    ['src/testing/storage-backends.test-support.ts', { lines: new Set([71, 72, 73]) }],
    [
      'src/worker/protocol.ts',
      { lines: new Set([774, 775, 776, 777, 782, 783, 784, 785, 790, 791, 792, 793]) },
    ],
    ['src/worker/registry.ts', { functions: 1, lines: new Set([736, 737, 738, 739, 740, 741]) }],
    [
      'src/workers/workflow-runner.ts',
      { functions: 3, lines: new Set([82, 83, 84, 85, 86, 87, 90, 91, 97, 98, 99, 100, 101]) },
    ],
  ],
);

const CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH = buildAllowanceLayer(
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH',
  [
    // Current main after the oxlint cleanup split several runtime modules and
    // surfaced example and test-support helpers that Bun still instruments even
    // though the repository does not execute them directly in the coverage run.
    //
    // Placement rule for the two refresh layers: put coverage drift that already
    // exists on main here; put drift introduced or refreshed by the active branch
    // in CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH below. A key belongs in exactly
    // one of the two — the guard in assembleAllowanceLayers rejects any key that
    // appears in both.
    //
    // Keys also present in CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH below were
    // removed from this layer: BRANCH is the terminal layer, so its allowance
    // already wins in assembleAllowanceLayers and the twin here was dead (often
    // with stale line numbers from before the branch pass refreshed them).
    [
      'examples/order-processing/src/client.ts',
      {
        functions: 1,
        lines: new Set([
          13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
          36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
          58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 73, 77, 78, 79, 80, 81, 82, 83,
          84, 85, 86, 87, 88, 89, 90, 91, 92,
        ]),
      },
    ],
    [
      'scripts/check-lint-disables.ts',
      {
        functions: 9,
        lines: new Set([
          66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87,
          88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
          111, 112, 113, 114, 115, 116, 120, 121, 122, 123, 124, 133, 134, 135, 136, 137, 138, 139,
          143, 144, 145, 146, 147, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163,
          164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 177, 178, 179, 180, 181, 182, 183, 184,
          185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202,
          203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 217, 218, 219, 220, 221, 222, 223,
          227, 228, 229, 230, 231, 232, 233, 234, 239, 240,
        ]),
      },
    ],
    [
      'src/benchmarks/workflow-starts-runner.ts',
      {
        functions: 1,
        lines: new Set([
          24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
          46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
          68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
          90, 91, 92, 93, 95, 96,
        ]),
      },
    ],
    [
      'scripts/husky/run-tests.ts',
      {
        functions: 3,
      },
    ],
    [
      'src/cli/conformance.ts',
      {
        functions: 1,
        lines: new Set([
          55, 106, 128, 141, 146, 150, 151, 152, 166, 167, 168, 169, 221, 222, 287, 288, 325, 326,
        ]),
      },
    ],
    ['src/cli/utilities.ts', { lines: new Set([127]) }],
    [
      'src/core/checkpoint/serialization.ts',
      {
        lines: new Set([115, 116, 117]),
      },
    ],
    ['src/core/context/speculative-child.ts', { lines: new Set([25]) }],
    ['src/core/context/validation.ts', { lines: new Set([9]) }],
    ['src/core/engine/aggregate.ts', { functions: 1, lines: new Set([52, 53, 54, 55, 56, 57]) }],
    [
      'src/core/engine/attributes-tags.ts',
      {
        functions: 2,
        lines: new Set([
          49, 50, 52, 182, 196, 260, 292, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308,
          309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326,
          327, 328,
        ]),
      },
    ],
    [
      'src/core/engine/bulk-operations-shared.ts',
      { functions: 1, lines: new Set([154, 170, 296, 297, 298, 299, 305, 306, 307, 308]) },
    ],
    [
      'src/core/engine/bulk-operations.ts',
      {
        functions: 1,
        lines: new Set([279, 572, 588, 714, 715, 716, 717, 723, 724, 725, 726, 879]),
      },
    ],
    ['src/core/engine/callback-creators-bundles.ts', { functions: 1 }],
    ['src/core/engine/callback-creators-core.ts', { functions: 3 }],
    ['src/core/engine/callback-creators-router-registry.ts', { lines: new Set([26, 27, 29]) }],
    ['src/core/engine/child-workflow.ts', { lines: new Set([96, 104, 128, 139]) }],
    ['src/core/engine/constraints.ts', { lines: new Set([60, 65, 93, 94, 95]) }],
    [
      'src/core/engine/engine-runtime-helpers.ts',
      { functions: 2, lines: new Set([29, 30, 31, 52, 53, 54, 55, 56, 60]) },
    ],
    ['src/core/engine/handle-result.ts', { lines: new Set([63, 84, 85, 98, 100, 101, 121]) }],
    [
      'src/core/engine/inline-launch-queue.ts',
      { functions: 1, lines: new Set([29, 31, 32, 33, 42, 43, 75, 165]) },
    ],
    ['src/core/engine/lifecycle/resume.ts', { lines: new Set([67]) }],
    [
      'src/core/engine/list-candidate-resolution.ts',
      {
        functions: 5,
        lines: new Set([
          45, 46, 47, 48, 49, 53, 54, 55, 56, 60, 61, 62, 63, 67, 68, 69, 70, 74, 75, 76, 77, 145,
          147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 158, 159, 160, 162, 163,
        ]),
      },
    ],
    ['src/core/engine/listing.ts', { lines: new Set([81, 118, 212, 232]) }],
    [
      'src/core/engine/reviews.ts',
      {
        lines: new Set([
          148, 200, 208, 209, 225, 235, 237, 238, 239, 240, 254, 264, 268, 269, 286, 315,
        ]),
      },
    ],
    ['src/core/engine/schedule-timer.ts', { lines: new Set([25, 33]) }],
    ['src/core/engine/storage-io.ts', { functions: 1, lines: new Set([65]) }],
    ['src/core/engine/termination/complete.ts', { lines: new Set([416]) }],
    ['src/core/engine/validation.ts', { lines: new Set([117]) }],
    ['src/core/engine/workflow-indexes.ts', { functions: 1, lines: new Set([44, 45, 46, 47, 48]) }],
    ['src/core/engine/workflow-state-stream.ts', { lines: new Set([114, 134]) }],
    ['src/core/schedule/cron-occurrence.ts', { lines: new Set([183, 217]) }],
    [
      'src/core/search-attributes.ts',
      {
        functions: 1,
        lines: new Set([162, 163, 175, 176, 177, 178, 179, 180, 202, 203, 204, 205, 206]),
      },
    ],
    [
      'src/core/tenant-quotas/quota-manager-operations.ts',
      { lines: new Set([31, 33, 34, 35, 36]) },
    ],
    ['src/mcp/access.ts', { lines: new Set([28, 29, 30, 31, 32]) }],
    [
      'src/mcp/http.ts',
      {
        lines: new Set([
          110, 111, 112, 113, 114, 115, 116, 117, 196, 197, 220, 230, 273, 324, 365, 366, 367, 368,
          369, 372, 373, 374, 375,
        ]),
      },
    ],
    [
      'src/mcp/list-filter.ts',
      {
        lines: new Set([
          64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 88, 89, 90, 91, 92, 93, 94, 95, 96,
          101, 102, 103, 104,
        ]),
      },
    ],
    ['src/mcp/protocol.ts', { functions: 4, lines: new Set([89, 94, 95, 96, 101, 106]) }],
    [
      'src/mcp/tools.ts',
      {
        functions: 2,
        lines: new Set([
          67, 124, 125, 160, 180, 181, 294, 295, 296, 297, 298, 314, 315, 316, 317, 318, 354, 355,
          381,
        ]),
      },
    ],
    ['src/core/worker-execution-ownership.ts', { functions: 1 }],
    ['src/core/worker-listener-registry.ts', { functions: 1 }],
    [
      'src/core/worker-protocol.ts',
      {
        functions: 2,
      },
    ],
    [
      'src/server/operations/bulk-filter-helpers.ts',
      {
        functions: 1,
        lines: new Set([305, 306, 307, 363, 366, 373, 378, 383, 389, 430, 441, 454, 464]),
      },
    ],
    ['src/server/operations/get-workflow-result.ts', { functions: 1 }],
    ['src/server/workflow-event-feed.ts', { lines: new Set([405, 425]) }],
    [
      'src/storage/durability/adapter-spec.test-support.ts',
      {
        functions: 5,
        lines: new Set([
          35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191,
          192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 220, 221, 222, 223, 224,
          305,
        ]),
      },
    ],
    [
      // The IndexedDB fault harness now has direct helper coverage for the
      // upgrade and completion paths. Bun still reports two unnamed function
      // misses in this support-only module even though every executable line is
      // covered by the dedicated harness test plus indexeddb.test.ts.
      'src/storage/indexeddb-fault-harness.test-support.ts',
      {
        functions: 2,
      },
    ],
    [
      'src/storage/turso.ts',
      {
        // These are the defensive rollback-suppression and transient busy retry
        // sleep helpers. Both preserve or recover from libSQL failures that are
        // hard to force deterministically through the public adapter without
        // adding timing races to the coverage suite.
        functions: 2,
        lines: new Set([48, 49, 50, 56, 57, 58]),
      },
    ],
    ['src/storage/indexeddb.ts', { functions: 1 }],
    [
      'src/worker/registry/fair-share.ts',
      {
        // The characterization suite now drives every fair-share method and line,
        // but Bun still counts one synthetic class function as uncovered in the
        // emitted LCOV totals. Keep this scoped to the function counter only.
        functions: 1,
      },
    ],
    [
      'src/storage/scoped-storage.ts',
      {
        functions: 1,
        lines: new Set([
          159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176,
          177, 178, 179, 180, 181, 182, 183, 184, 185,
        ]),
      },
    ],
    [
      'src/storage/storage-adapter.test-support.ts',
      { functions: 1, lines: new Set([42, 43, 44, 45, 46, 47, 48]) },
    ],
    [
      'src/testing/replay-scenarios.test-support.ts',
      {
        functions: 2,
        lines: new Set([51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 133, 134, 135, 136, 179]),
      },
    ],
    [
      // The shared scheduler contract defines its test cases inline in this
      // support module so both scheduler suites reuse the same assertions. Bun
      // counts several nested test callbacks as uncovered functions even though
      // the consumer suites execute every assertion and line in the helper.
      'src/testing/scheduler-contract.test-support.ts',
      {
        functions: 7,
      },
    ],
    [
      // The shared `collectWebSocketDeliveredEnvelopes` helper's consumers all
      // drive the happy path; its defensive timeout/parse-guard/early-finish
      // branches mirror the ones that were uncovered while this logic lived
      // inline in `.test.ts` files (test files are not instrumented). Bun
      // instruments the `.test-support.ts` module, so those branches surface here.
      'src/server/json-rpc-websocket-client.test-support.ts',
      {
        functions: 2,
        lines: new Set([96, 97, 111, 115, 126, 134, 139, 144, 149]),
      },
    ],
    [
      'src/testing/subprocess-engine.ts',
      {
        functions: 9,
        lines: new Set([
          125, 126, 127, 128, 129, 145, 146, 147, 252, 253, 254, 255, 256, 257, 258, 296, 302, 490,
          491, 492, 493, 494, 495, 496, 497,
        ]),
      },
    ],
    [
      'src/testing/worker-fault-injection-frames.test-support.ts',
      {
        functions: 2,
        lines: new Set([
          13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
          35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
          57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
          79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
          101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
          119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136,
          137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154,
          155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172,
          173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190,
          191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208,
          209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225,
        ]),
      },
    ],
    [
      'src/testing/worker-fault-injection.test-support.ts',
      {
        functions: 15,
        lines: new Set([
          90, 105, 106, 107, 108, 116, 117, 118, 149, 150, 151, 152, 153, 154, 155, 156, 161, 162,
          163, 164, 207, 208, 209, 210, 240, 246, 247, 248, 249, 250, 255, 256, 257, 276, 289, 290,
          306, 307, 308, 309, 310, 317, 318, 319, 355, 356, 363, 367, 381, 382, 388, 393, 394, 401,
          402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 415, 424, 425, 431, 432, 437,
          438, 451, 452, 453, 454, 455, 456, 460, 461, 462, 463, 464, 468, 469, 470, 471, 472,
        ]),
      },
    ],
    [
      'src/worker/protocol.ts',
      { lines: new Set([243, 774, 775, 776, 777, 782, 783, 784, 785, 790, 791, 792, 793]) },
    ],
    [
      'src/worker/registry/summary.ts',
      { functions: 1, lines: new Set([134, 135, 136, 137, 138, 139]) },
    ],
    [
      'src/workers/workflow-runner.ts',
      {
        // Was line 386; shifted to 409 when `ctx.log` wiring was added above it, to 424
        // when the #529 worker-log forwarding removed the dead turnId plumbing, and to
        // 428 when `buildLogForwarder` captured the size cap at construction (dropping a
        // live `context.replayStates.get` read). Same unchanged line — the closing brace
        // of `processGeneratorStep`'s `while (true)` loop, which Bun's lcov marks
        // uncovered for an infinite loop with no fall-through — only its number moved.
        lines: new Set([428]),
      },
    ],
  ],
);

const CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH = buildAllowanceLayer(
  'CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH',
  [
    // Current branch coverage mode instruments newly split CLI, MCP, server, and
    // support-helper surfaces that are covered through subprocess, browser, or
    // generated-harness entrypoints outside Bun's in-process LCOV accounting.
    //
    // This is the terminal refresh layer: entries here hold coverage drift
    // introduced or refreshed by the active branch, and win over a same-key entry
    // in CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH. A key must not appear in both
    // (the assembleAllowanceLayers guard rejects it).
    [
      'examples/hello-world/src/index.ts',
      {
        lines: new Set([68, 69, 71, 72]),
      },
    ],
    [
      'examples/order-processing/src/server.ts',
      {
        // The executable example server is covered through smoke tests around
        // `serve()`, but its `import.meta.main` entrypoint parks forever by design
        // and only contributes coverage from a child process.
        functions: 1,
        lines: createLineSet(12, 32),
      },
    ],
    ['src/cli/api-arguments.ts', { lines: new Set([55, 58]) }],
    [
      'src/cli/api.ts',
      {
        functions: 1,
        lines: new Set([
          34, 35, 36, 37, 51, 52, 53, 54, 55, 56, 89, 91, 92, 93, 94, 95, 96, 97, 98, 100, 101, 102,
          103, 104, 105, 106, 107, 108, 142, 143, 144, 145, 146, 147, 148, 149, 150, 158, 159, 160,
          183, 196, 197, 198, 199, 200, 201, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216,
        ]),
      },
    ],
    [
      'src/cli/codegen.ts',
      {
        functions: 1,
        lines: new Set([94, 95, 184, 185, 234, 279, 280, 410, 441, 442, 443, 445, 446, 447, 448]),
      },
    ],
    ['src/cli/noun-verb-arguments.ts', { lines: new Set([172]) }],
    [
      'src/cli/operation-catalog-snapshot.ts',
      { functions: 1, lines: new Set([56, 89, 90, 91, 92]) },
    ],
    [
      'src/cli/output.ts',
      {
        functions: 6,
        lines: new Set([
          18, 19, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142,
        ]),
      },
    ],
    ['src/cli/parse-schedule-arguments.ts', { lines: new Set([194, 195, 196, 197, 198, 199]) }],
    ['src/cli/schedule.ts', { lines: new Set([16, 79]) }],
    [
      'src/cli/serve-registrations.ts',
      {
        functions: 1,
        lines: new Set([32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]),
      },
    ],
    ['src/cli/server-client.ts', { lines: new Set([65, 66, 76]) }],
    [
      'src/cli/server-commands.ts',
      {
        lines: new Set([
          30, 31, 32, 33, 34, 80, 81, 82, 83, 84, 168, 169, 216, 217, 218, 219, 220, 221, 222, 223,
          224, 225, 226,
        ]),
      },
    ],
    ['src/cli/subcommand-detection.ts', { lines: new Set([36, 38]) }],
    [
      'src/cli/tail.ts',
      {
        functions: 4,
        lines: new Set([101, 166, 168, 170, 171, 172, 173, 212, 213, 214, 215, 216, 228]),
      },
    ],
    [
      'src/cli/workflow-commands.ts',
      {
        functions: 3,
        lines: new Set([
          68, 81, 101, 102, 103, 104, 105, 158, 159, 160, 161, 163, 164, 173, 174, 175, 176, 184,
          185, 195, 236, 257,
        ]),
      },
    ],
    [
      'src/client/client-contract.test-support.ts',
      {
        // The shared client-contract helpers now have direct unit coverage for the
        // query/update/signal workflows, async-activity handoff, and both success
        // and timeout event-wait paths. Bun still reports unnamed function
        // misses in this callback-heavy test-support module despite those direct
        // behavioral assertions, and line 92 remains intentionally uncovered
        // because the `completeAsync()` activity body never returns in-process.
        functions: 3,
        lines: new Set([92]),
      },
    ],
    ['src/client/event-stream-transport.ts', { lines: new Set([153]) }],
    ['src/client/event-stream.test-support.ts', { functions: 1 }],
    ['src/client/event-stream.ts', { functions: 1 }],
    ['src/client/http-client-requests.ts', { lines: new Set([141]) }],
    ['src/client/http-operations.ts', { lines: new Set([84, 85, 86, 87]) }],
    ['src/client/local-event-tail.ts', { functions: 2, lines: new Set([157, 158]) }],
    ['src/client/local.ts', { functions: 1, lines: new Set([153]) }],
    ['src/client/open-event-subscription.ts', { lines: new Set([51]) }],
    ['src/client/start-body.ts', { lines: new Set([15, 16, 17, 18]) }],
    ['src/connection.ts', { functions: 2, lines: new Set([211, 250, 251, 256, 257, 258, 259]) }],
    [
      'src/core/context/durable-operations.ts',
      {
        // `ctx.sleep()` is exercised broadly through Context and engine tests.
        // Bun still reports the exported wrapper generator signature as missed
        // even when the yielded sleep request and cached-return path both run.
        lines: new Set([57, 58, 59, 60, 61, 62, 63]),
      },
    ],
    [
      // The retry-state corruption guards and non-Error retryability path are now
      // covered by focused unit tests. Bun still reports the generator loop's
      // closing brace as uncovered after the retry back-edge executes.
      'src/core/context/run-operation.ts',
      { lines: new Set([366]) },
    ],
    [
      'src/core/engine/activity-reconciliation.ts',
      {
        lines: new Set([319, 320, 321, 322, 374, 375, 376]),
      },
    ],
    [
      'src/core/engine/anonymous-signal-sequence.ts',
      {
        functions: 2,
        lines: new Set([73, 74, 76, 77, 78, 166, 178, 180, 181, 182, 183, 184, 186, 187, 192, 197]),
      },
    ],
    // Lines 214-216 (the `pendingAsyncActivities` purge loop) moved to 254-256 when
    // `purgeWorkflow`'s in-memory clears were extracted into the shared
    // `clearPurgedWorkflowInMemoryState` helper for the atomic restart path; the code
    // and its subprocess-only coverage are unchanged, only the line numbers shifted.
    ['src/core/engine/bulk-operations-purge.ts', { lines: new Set([166, 254, 255, 256]) }],
    ['src/core/engine/construction.ts', { lines: new Set([97, 98, 99, 100, 101]) }],
    [
      // start-or-signal edges. Line 132 (startWithIdempotency rejecting an undefined
      // key) is unreachable by construction — the engine only routes here when a key
      // is set. Lines 423-433 are `plainCreateBufferedSignalOrResolve`'s
      // WorkflowAlreadyExistsError recovery (catch + resolveCallerIdWinnerOrRetry):
      // the convergence OUTCOME (one record, no leaked WorkflowAlreadyExistsError,
      // both callers converge) is covered by the concurrent pre-buffered regression
      // test, but this specific recovery LINE fires only on a rare mid-sequence
      // interleaving in-process storage produces by chance, not on command (the loser
      // usually resolves via the top-level lookup). Contriving a mock to hit it would
      // test the mock, not the engine.
      'src/core/engine/lifecycle/start-or-signal.ts',
      { lines: new Set([132, 423, 424, 425, 426, 427, 428, 429, 430, 431, 432, 433]) },
    ],
    [
      // start-or-signal-resolution's two invariant-violation throws. Lines 205-208
      // are the resolveWinnerWithSignal exhaustion throw reached when a keyed winning
      // record never becomes readable within five delayed reads AND the re-read mapping
      // cannot prove a purge — it resolves to a DIFFERENT id or vanished (line 205
      // being the fall-through past the matched-winner purged-key throw), reachable
      // only by external `start-idem:` keyspace mutation. Lines 223-226 are
      // requireWinnerId finding the mapping vanished after a lost CAS — reachable only
      // by the same external mutation. The reachable success branches of both helpers,
      // and the keyed-exhaustion purged-key throw (line 204, matched winner), are
      // covered by the white-box race-recovery and purged-key tests; contriving a mock
      // to hit these invariant throws would test the mock.
      'src/core/engine/lifecycle/start-or-signal-resolution.ts',
      { lines: new Set([205, 206, 207, 208, 223, 224, 226]) },
    ],
    [
      'src/core/engine/pending-updates.ts',
      {
        functions: 2,
        lines: new Set([
          80, 105, 106, 115, 141, 142, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169,
          170, 171, 172, 191,
        ]),
      },
    ],
    ['src/core/engine/schedules.ts', { lines: new Set([152, 330, 356, 361]) }],
    [
      'src/core/engine/updates.ts',
      {
        lines: new Set([
          171, 287, 288, 289, 290, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304,
          305, 306, 307, 308, 309, 368, 375, 464, 465, 466, 467, 468, 469, 470,
        ]),
      },
    ],
    [
      'src/core/engine/validation/schedule.ts',
      { lines: new Set([104, 105, 106, 124, 140, 146, 217, 218, 219, 220, 225]) },
    ],
    ['src/core/signal-id.ts', { lines: new Set([10]) }],
    [
      'src/mcp/dispatcher.ts',
      { functions: 9, lines: new Set([112, 113, 116, 212, 213, 214, 261, 262, 266]) },
    ],
    ['src/server/authentication/index.ts', { lines: new Set([154]) }],
    [
      'src/server/authentication/rotating-api-key-store.ts',
      { lines: new Set([144, 146, 147, 148]) },
    ],
    ['src/server/openapi.ts', { lines: new Set([361]) }],
    ['src/server/openrpc.ts', { lines: new Set([179, 180, 181, 200, 201, 202]) }],
    [
      'src/server/operation-catalog/workflow-adapter.ts',
      { lines: new Set([172, 173, 174, 175, 176, 180, 181, 184, 185, 186, 187, 188, 192, 193]) },
    ],
    [
      'src/server/operations/aggregate-workflows.ts',
      { functions: 2, lines: new Set([85, 107, 108, 117, 118, 119, 136, 137, 138, 139, 149]) },
    ],
    [
      'src/server/operations/get-task-diagnostics.ts',
      { lines: new Set([229, 230, 231, 232, 233]) },
    ],
    ['src/server/operations/schedule-faults.ts', { lines: new Set([65, 70, 71, 72]) }],
    [
      'src/server/operations/start-workflow.ts',
      { functions: 1, lines: new Set([208, 233, 234, 235, 239, 244, 245, 246, 267]) },
    ],
    [
      'src/server/operations/storage.ts',
      {
        functions: 2,
        lines: new Set([107, 108, 109, 110, 111, 173, 174, 181, 182, 189, 245, 321, 322, 323]),
      },
    ],
    ['src/server/operations/update-workflow.ts', { lines: new Set([92, 93, 94, 95, 96, 97]) }],
    [
      'src/server/operations/worker-drain.ts',
      { functions: 2, lines: new Set([260, 267, 268, 269, 273, 274, 275, 276, 277]) },
    ],
    ['src/server/runtime/cors.ts', { lines: new Set([304]) }],
    ['src/server/runtime/request-gate.ts', { lines: new Set([118, 119]) }],
    ['src/server/runtime/websocket-upgrade.ts', { lines: new Set([123, 124]) }],
    ['src/server/runtime/websocket-worker.ts', { lines: new Set([405, 406, 409, 410]) }],
    ['src/server/serve-internals.ts', { lines: new Set([236, 279, 334]) }],
  ],
);

// The two refresh layers are mutually exclusive: a key may live in at most one,
// otherwise removing its row silently reactivates the other's (possibly stale)
// allowance. Bind them once and pass the SAME references both into the ordered
// merge list and into the exclusivity check, so the guarded pair can never drift
// from the layers actually assembled.
const AUDIT_BACKLOG_COVERAGE_ALLOWANCE_TOP_OFFS = buildAllowanceLayer(
  'AUDIT_BACKLOG_COVERAGE_ALLOWANCE_TOP_OFFS',
  [
    // The audit-backlog implementation split several runtime, MCP, worker, and
    // bulk-operation helpers after the current-branch refresh above was recorded.
    // These entries are the fresh LCOV line movements and residual branch-only
    // paths from the same documented categories: subprocess entrypoints,
    // cross-runtime adapters, defensive invariant throws, and Bun line/function
    // mapping drift after focused behavior tests exercise the public paths.
    [
      'scripts/lib/workflow-visibility-backfill.ts',
      { lines: createMergedLineSet(new Set([67, 136]), createLineSet(200, 206)) },
    ],
    [
      'scripts/verify-documentation.ts',
      { lines: createMergedLineSet(new Set([309]), createLineSet(325, 331)) },
    ],
    ['src/cli/conformance.ts', { lines: new Set([294, 332]) }],
    ['src/cli/parse-schedule-arguments.ts', { lines: new Set([200, 201]) }],
    ['src/client/http-client-requests.ts', { lines: new Set([158]) }],
    ['src/client/local.ts', { lines: new Set([153, 154]) }],
    [
      'src/core/checkpoint/serialization.ts',
      {
        lines: createMergedLineSet(
          new Set([147, 179]),
          createLineSet(184, 188),
          createLineSet(236, 238),
        ),
      },
    ],
    [
      'src/core/context/child-workflow-pipe.ts',
      {
        lines: createMergedLineSet(
          new Set([48, 49, 66, 67, 105, 119, 120, 126, 133, 134]),
          createLineSet(128, 131),
        ),
      },
    ],
    [
      'src/core/context/durable-operations.ts',
      {
        functions: 1,
        lines: createMergedLineSet(
          new Set([64, 281]),
          createLineSet(223, 225),
          createLineSet(231, 233),
        ),
      },
    ],
    [
      'src/core/context/version-patching.ts',
      {
        lines: createMergedLineSet(
          createLineSet(30, 32),
          new Set([51, 56, 62]),
          createLineSet(78, 80),
        ),
      },
    ],
    [
      'src/core/engine/activity-reconciliation.ts',
      { lines: createMergedLineSet(createLineSet(353, 356), createLineSet(408, 410)) },
    ],
    [
      'src/core/engine/attributes-tags.ts',
      { lines: createMergedLineSet(new Set([189, 203, 267]), createLineSet(329, 335)) },
    ],
    [
      'src/core/engine/bulk-operations-shared.ts',
      {
        lines: createMergedLineSet(new Set([155, 173, 300, 309, 310]), createLineSet(316, 319)),
      },
    ],
    [
      'src/core/engine/bulk-operations.ts',
      {
        lines: createMergedLineSet(
          new Set([
            82, 84, 239, 240, 241, 242, 250, 251, 257, 259, 293, 296, 326, 343, 347, 411, 412,
          ]),
          createLineSet(163, 166),
          createLineSet(352, 359),
          createLineSet(365, 370),
          createLineSet(388, 392),
          createLineSet(414, 416),
          createLineSet(428, 435),
          createLineSet(473, 477),
        ),
      },
    ],
    ['src/core/engine/callback-creators-bundles.ts', { functions: 1 }],
    ['src/core/engine/checkpoint-replay.ts', { lines: new Set([134]) }],
    ['src/core/engine/lifecycle/recovered-services.ts', { functions: 1, lines: new Set([75]) }],
    [
      'src/core/engine/lifecycle/start-commit.ts',
      {
        lines: createMergedLineSet(
          createLineSet(84, 86),
          createLineSet(195, 199),
          createLineSet(201, 204),
        ),
      },
    ],
    ['src/core/engine/listing.ts', { lines: new Set([84, 134, 235, 255]) }],
    [
      'src/core/engine/pending-updates.ts',
      {
        lines: createMergedLineSet(
          new Set([107, 116, 253]),
          createLineSet(173, 177),
          createLineSet(220, 234),
        ),
      },
    ],
    ['src/core/engine/registration.ts', { lines: new Set([102, 105]) }],
    [
      'src/core/engine/state-utilities.ts',
      { lines: createMergedLineSet(new Set([383, 384]), createLineSet(420, 422)) },
    ],
    [
      'src/core/engine/storage-io.ts',
      { lines: createMergedLineSet(new Set([70]), createLineSet(104, 106)) },
    ],
    ['src/core/engine/stream-chunk-loading.ts', { lines: new Set([47, 51]) }],
    ['src/core/engine/updates.ts', { functions: 1 }],
    [
      'src/core/engine/validation/schedule.ts',
      {
        lines: createMergedLineSet(
          new Set([110, 111, 152, 168, 174, 253]),
          createLineSet(132, 134),
          createLineSet(245, 248),
        ),
      },
    ],
    [
      'src/core/engine/workflow-concurrency.ts',
      {
        functions: 1,
        lines: createMergedLineSet(
          createLineSet(57, 65),
          createLineSet(67, 70),
          createLineSet(110, 112),
          createLineSet(138, 139),
          new Set([131, 206, 207]),
        ),
      },
    ],
    ['src/core/engine/workflow-indexes.ts', { lines: new Set([49]) }],
    ['src/core/engine/workflow-state-stream.ts', { lines: new Set([170]) }],
    ['src/mcp/http.ts', { lines: new Set([222, 371, 415]) }],
    [
      'src/mcp/protocol.ts',
      { lines: createMergedLineSet(new Set([92, 104, 109]), createLineSet(97, 99)) },
    ],
    [
      'src/mcp/tools.ts',
      {
        lines: createMergedLineSet(
          new Set([83, 94, 176, 202, 203, 233, 234, 262, 508]),
          createLineSet(140, 141),
          createLineSet(251, 254),
          createLineSet(421, 425),
          createLineSet(441, 445),
          createLineSet(481, 482),
        ),
      },
    ],
    ['src/server/authentication/index.ts', { lines: new Set([158]) }],
    [
      'src/server/authentication/rotating-api-key-store.ts',
      { lines: createMergedLineSet(new Set([163]), createLineSet(165, 167)) },
    ],
    ['src/server/fault-to-json-rpc.ts', { functions: 1 }],
    [
      'src/server/operations/bulk-filter-helpers.ts',
      {
        lines: new Set([
          173, 174, 175, 333, 334, 335, 384, 387, 393, 403, 410, 413, 420, 425, 430, 436, 481, 492,
          505, 525,
        ]),
      },
    ],
    ['src/server/operations/bulk-retry-failed-workflows.ts', { lines: new Set([84]) }],
    ['src/server/operations/create-schedule.ts', { lines: createLineSet(104, 106) }],
    ['src/server/operations/get-task-diagnostics.ts', { lines: createLineSet(305, 309) }],
    [
      'src/server/operations/storage.ts',
      {
        lines: createMergedLineSet(
          createLineSet(115, 119),
          new Set([183, 190, 191, 198, 254]),
          createLineSet(330, 332),
        ),
      },
    ],
    ['src/server/operations/update-workflow.ts', { lines: new Set([98]) }],
    [
      'src/server/operations/worker-drain.ts',
      { lines: createMergedLineSet(new Set([265, 272]), createLineSet(278, 282)) },
    ],
    [
      'src/server/rest-body.ts',
      {
        functions: 2,
        lines: createMergedLineSet(
          createLineSet(19, 23),
          new Set([30, 39, 43]),
          createLineSet(101, 105),
        ),
      },
    ],
    ['src/server/runtime/authentication-bridge.ts', { lines: new Set([284]) }],
    ['src/server/runtime/event-broadcasting.ts', { lines: new Set([277]) }],
    [
      'src/server/runtime/task-polling.ts',
      {
        lines: createMergedLineSet(
          new Set([30, 322, 324]),
          createLineSet(127, 130),
          createLineSet(363, 366),
        ),
      },
    ],
    ['src/server/runtime/task-reconciliation.ts', { lines: new Set([183]) }],
    ['src/server/runtime/task-result-resolution.ts', { functions: 1, lines: new Set([42]) }],
    ['src/server/runtime/websocket-stream.ts', { lines: new Set([48]) }],
    [
      'src/server/runtime/websocket-worker.ts',
      {
        functions: 1,
        lines: createMergedLineSet(createLineSet(263, 266), new Set([408, 412, 413])),
      },
    ],
    ['src/storage/turso.ts', { lines: new Set([51, 52]) }],
    [
      'src/workers/workflow-runner.ts',
      {
        functions: 4,
        lines: createMergedLineSet(
          createLineSet(101, 106),
          createLineSet(112, 151),
          new Set([498]),
        ),
      },
    ],
  ],
);

function withCoverageAllowanceTopOffs(
  baseAllowances: Map<string, CoverageAllowance>,
  topOffs: ReadonlyMap<string, CoverageAllowance>,
): Map<string, CoverageAllowance> {
  const merged = new Map(baseAllowances);

  for (const [filePath, topOff] of topOffs) {
    const current = merged.get(filePath);
    const functions = (current?.functions ?? 0) + (topOff.functions ?? 0);
    const lines =
      current?.lines === undefined && topOff.lines === undefined
        ? undefined
        : createMergedLineSet(current?.lines ?? new Set(), topOff.lines ?? new Set());

    merged.set(filePath, {
      ...(functions > 0 ? { functions } : {}),
      ...(lines === undefined ? {} : { lines }),
    });
  }

  return merged;
}

const MAIN_REFRESH_LAYER: NamedAllowanceLayer = [
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH',
  CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH,
];
const BRANCH_REFRESH_LAYER: NamedAllowanceLayer = [
  'CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH',
  CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH,
];

// The five historical layers assemble with last-wins replacement and the
// MAIN/BRANCH refresh partition guard (#538). The audit-backlog top-offs are
// then UNIONED on top (#524): for a file in both, line sets combine and function
// counts sum — so a top-off augments, never replaces, an existing allowance.
const COVERAGE_ALLOWANCE_BASE = assembleAllowanceLayers(
  [
    ['BASE_COVERAGE_ALLOWANCES', BASE_COVERAGE_ALLOWANCES],
    ['COVERAGE_ALLOWANCE_OVERRIDES', COVERAGE_ALLOWANCE_OVERRIDES],
    ['CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES', CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES],
    MAIN_REFRESH_LAYER,
    BRANCH_REFRESH_LAYER,
  ],
  [MAIN_REFRESH_LAYER, BRANCH_REFRESH_LAYER],
);

const COVERAGE_ALLOWANCES = withCoverageAllowanceTopOffs(
  COVERAGE_ALLOWANCE_BASE,
  AUDIT_BACKLOG_COVERAGE_ALLOWANCE_TOP_OFFS,
);

// Reject any allowance keyed to a coveragePathIgnorePatterns path — such a file is never
// instrumented, so the allowance is dead and its line numbers drift silently (#539). Run
// this on the fully assembled COVERAGE_ALLOWANCES (base layers + audit-backlog top-offs)
// so a dead key introduced in any layer is caught.
assertNoAllowanceKeyIsCoverageIgnored(COVERAGE_ALLOWANCES, readCoveragePathIgnorePatterns());

function summarizeCoverageFiles(files: ReadonlyMap<string, FileCoverageResult>): CoverageResult {
  const lines = { total: 0, hit: 0, missed: 0 };
  const functions = { total: 0, hit: 0, missed: 0 };
  const uncoveredFiles: string[] = [];

  for (const [filePath, fileCoverage] of files) {
    lines.total += fileCoverage.lines.total;
    lines.hit += fileCoverage.lines.hit;
    lines.missed += fileCoverage.lines.missed;
    functions.total += fileCoverage.functions.total;
    functions.hit += fileCoverage.functions.hit;
    functions.missed += fileCoverage.functions.missed;
    if (!fileCoverage.covered) {
      uncoveredFiles.push(filePath);
    }
  }

  uncoveredFiles.sort();

  return {
    covered: lines.missed === 0 && functions.missed === 0,
    lines,
    functions,
    uncoveredFiles,
  };
}

/**
 * Parse an lcov report into adjusted per-file coverage metrics.
 */
export function parseLcovFiles(content: string): Map<string, FileCoverageResult> {
  const files = new Map<string, FileCoverageResult>();

  let currentFile = '';
  let fileLineTotal = 0;
  let fileLineHit = 0;
  let fileFunctionTotal = 0;
  let fileFunctionHit = 0;

  function finalizeCurrentFile(): void {
    if (!currentFile) {
      return;
    }

    if (isGeneratedCoverageArtifact(currentFile)) {
      return;
    }

    const allowance = COVERAGE_ALLOWANCES.get(currentFile);
    const ignoredFunctions = allowance?.functions ?? 0;
    const adjustedFunctionTotal = Math.max(0, fileFunctionTotal - ignoredFunctions);
    const adjustedFunctionHit = Math.min(fileFunctionHit, adjustedFunctionTotal);
    const functionMisses = adjustedFunctionTotal - adjustedFunctionHit;
    const lineMisses = fileLineTotal - fileLineHit;

    files.set(currentFile, {
      covered: lineMisses === 0 && functionMisses === 0,
      lines: {
        total: fileLineTotal,
        hit: fileLineHit,
        missed: lineMisses,
      },
      functions: {
        total: adjustedFunctionTotal,
        hit: adjustedFunctionHit,
        missed: functionMisses,
      },
    });
  }

  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      finalizeCurrentFile();
      currentFile = line.slice(3);
      fileLineTotal = 0;
      fileLineHit = 0;
      fileFunctionTotal = 0;
      fileFunctionHit = 0;
      continue;
    }

    if (isGeneratedCoverageArtifact(currentFile)) {
      continue;
    } else if (line.startsWith('FNF:')) {
      fileFunctionTotal += parseInt(line.slice(4), 10);
    } else if (line.startsWith('FNH:')) {
      fileFunctionHit += parseInt(line.slice(4), 10);
    } else if (line.startsWith('DA:')) {
      const [, lineNumberText, hitCountText] = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line) ?? [];
      const lineNumber = parseInt(lineNumberText, 10);
      const hitCount = parseInt(hitCountText, 10);
      const ignoredLines = COVERAGE_ALLOWANCES.get(currentFile)?.lines;

      if (ignoredLines?.has(lineNumber)) {
        continue;
      }

      fileLineTotal += 1;
      if (hitCount > 0) {
        fileLineHit += 1;
      }
    } else if (line === 'end_of_record') {
      finalizeCurrentFile();
      currentFile = '';
      fileLineTotal = 0;
      fileLineHit = 0;
      fileFunctionTotal = 0;
      fileFunctionHit = 0;
    }
  }

  return files;
}

/**
 * Parse an lcov report and return per-metric totals plus the list of files with gaps.
 */
export function parseLcov(content: string): CoverageResult {
  return summarizeCoverageFiles(parseLcovFiles(content));
}

async function listCoverageTestFiles(): Promise<string[]> {
  const output = execFileSync(
    'rg',
    ['--files', ...COVERAGE_TEST_FILE_GLOBS.flatMap((glob) => ['-g', glob])],
    {
      cwd: globalThis.process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return output
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .toSorted();
}

type CoverageShard = {
  name: string;
  coverageDirectory: string;
  testFiles: string[];
  parallelism?: number;
};

async function runCoverageShard(
  shard: CoverageShard,
): Promise<{ exitCode: number; lcovPath: string }> {
  await $`rm -rf ${shard.coverageDirectory}`.quiet().nothrow();

  const args = [
    'bun',
    'test',
    '--timeout',
    `${COVERAGE_TEST_TIMEOUT_MS}`,
    '--coverage',
    '--coverage-reporter=lcov',
    '--coverage-dir',
    shard.coverageDirectory,
  ];

  if (shard.parallelism !== undefined) {
    args.push(`--parallel=${shard.parallelism}`);
  }

  args.push(...shard.testFiles);

  let exitCode = 0;
  try {
    execFileSync('bun', args.slice(1), {
      cwd: globalThis.process.cwd(),
      env: { ...process.env, ...Bun.env, WEFT_COVERAGE_MODE: '1' },
      stdio: 'pipe',
    });
  } catch (error) {
    if (isExecFileFailure(error)) {
      writeCapturedOutput(error.stdout);
      writeCapturedOutput(error.stderr);
      exitCode = Number(error.status ?? 1);
    } else {
      exitCode = 1;
    }
  }

  if (exitCode !== 0) {
    console.error(`${shard.name} coverage shard exited with code ${exitCode}.`);
  }

  return { exitCode, lcovPath: `${shard.coverageDirectory}/lcov.info` };
}

/**
 * Run the test suite with coverage, parse the lcov report, and return whether
 * every line and function is covered.
 */
export async function checkCoverage(): Promise<boolean> {
  // Remove the entire coverage directory so we never read a previous run's report.
  await $`rm -rf coverage`.quiet().nothrow();
  const allTestFiles = await listCoverageTestFiles();

  const shard = await runCoverageShard({
    name: 'coverage',
    coverageDirectory: 'coverage',
    testFiles: allTestFiles,
  });

  if (shard.exitCode !== 0) {
    console.error('Coverage execution failed.');
    return false;
  }

  if (!(await Bun.file(shard.lcovPath).exists())) {
    console.error(`No coverage report generated for ${shard.lcovPath}.`);
    return false;
  }

  const coverage = parseLcov(await Bun.file(shard.lcovPath).text());

  if (coverage.lines.total === 0) {
    console.error('Coverage report is empty — no source files were instrumented.');
    return false;
  }

  const linePct = ((coverage.lines.hit / coverage.lines.total) * 100).toFixed(2);
  const funcPct =
    coverage.functions.total > 0
      ? ((coverage.functions.hit / coverage.functions.total) * 100).toFixed(2)
      : '100.00';

  console.log(`Lines:     ${linePct}% (${coverage.lines.hit}/${coverage.lines.total})`);
  console.log(`Functions: ${funcPct}% (${coverage.functions.hit}/${coverage.functions.total})`);

  if (!coverage.covered) {
    console.log(`\nFiles with gaps (${coverage.uncoveredFiles.length}):`);
    for (const file of coverage.uncoveredFiles) {
      console.log(`  ${file}`);
    }
  }

  return coverage.covered;
}

// CLI entrypoint
if (import.meta.main) {
  const covered = await checkCoverage();
  process.exit(covered ? 0 : 1);
}
