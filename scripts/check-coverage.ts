import { $, Glob } from 'bun';

// Bun parses `bunfig.toml` natively when imported, so `coveragePathIgnorePatterns`
// stays a single source of truth (no hand-rolled TOML parse that could drift). The
// path resolves relative to THIS file, so it holds regardless of the invocation cwd.
import bunfig from '../bunfig.toml';

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
  requireUncoveredLines?: boolean;
};

type DocumentedCoverageAllowance = CoverageAllowance & { reason: string };

type CoverageAllowanceEntry = readonly [path: string, allowance: DocumentedCoverageAllowance];

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
const COVERAGE_FAILURE_OUTPUT_TAIL_BYTES = 16 * 1024 * 1024;
const COVERAGE_TEST_FILE_GLOBS = ['*test.ts', '*spec.ts'] as const;

function isGeneratedCoverageArtifact(filePath: string): boolean {
  // Bun records generated fixture paths relative to the coverage-run CWD, so worktree
  // depth changes the number of `../` segments and the temp root may be `var/folders/`,
  // `private/tmp/`, or `tmp/` (#503). The second matcher still gates this to known
  // fixture names, so a non-fixture temp file is not caught.
  if (
    /(?:\.\.\/)+(?:private\/)?(?:var\/folders\/|tmp\/)/.test(filePath) &&
    /(?:\/weft-(?:schedule(?:-lmdb)?-(?:workflows|input)|cli-edge-workflows)-[^/]+(?:\.ts|\/module\.ts)$|\/weft-validate-[^/]+\/[^/]+\.ts$|\/weft-validate-(?:json-invalid|mixed-(?:clean|invalid)|multi-[ab])-[^/]+\.ts$)/.test(
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
  [
    'scripts/generate-operation-client.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      functions: 1,
      lines: new Set([160, 161, 162, 163, 164, 165, 305]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/run-gates.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      functions: 1,
      lines: new Set([88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 189]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/check-implementation-file-sizes.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      functions: 1,
      lines: new Set([383, 384]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/verify-no-test-sleeps.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      lines: new Set([205]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/benchmarks/benchmark-subprocess.ts',
    {
      reason:
        'Malformed child-process benchmark payloads are defensive failures; exercising them would require replacing the real benchmark subprocess protocol.',
      lines: new Set([49, 50, 59, 64]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/engine/broadcast.ts',
    {
      reason:
        'The remaining listener-disposal branch is timing-dependent cleanup after a broadcast subscriber has already detached.',
      lines: new Set([46]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/schedule/cron-formatter.ts',
    {
      reason:
        'Bun reports an aggregate formatter function miss even though valid cron fields and every invalid-field diagnostic are covered.',
      functions: 1,
      lines: new Set([185, 187]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/scheduler/duration.ts',
    {
      reason:
        'The remaining duration branches reject values outside JavaScript safe-integer bounds that the public scheduler schema already excludes.',
      lines: new Set([38, 39, 40, 91]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/inline-execution-strategy.ts',
    {
      reason:
        'Bun reports one unnamed aggregate function miss in this class module despite complete line coverage and direct strategy tests.',
      functions: 1,
    },
  ],
]);

const COVERAGE_ALLOWANCE_OVERRIDES = buildAllowanceLayer('COVERAGE_ALLOWANCE_OVERRIDES', [
  [
    'src/core/engine/callback-creators.ts',
    {
      reason:
        'Bun reports an unnamed callback-closure miss after the callback factory paths are exercised through engine integration tests.',
      functions: 1,
    },
  ],
  [
    'src/core/engine/queries.ts',
    {
      reason:
        'The remaining query-registry line is a defensive missing-handler branch after registration and teardown behavior is covered.',
      lines: new Set([17]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/interceptor/index.ts',
    {
      reason:
        'The uncovered interceptor fallback rejects a malformed chain result that correctly typed interceptors cannot produce.',
      functions: 1,
      lines: new Set([25, 26, 27]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/authorization.ts',
    {
      reason:
        'The residual authorization branch handles an operation catalog entry without a declared access policy, which catalog validation forbids.',
      lines: new Set([159]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/json-rpc-websocket.ts',
    {
      reason:
        'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
      functions: 4,
      lines: new Set([107]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/stdio-session.ts',
    {
      reason:
        'Bun maps framing-loop exits and one aggregate adapter function as uncovered although oversize, resynchronization, partial-frame, and writer-close behavior is tested.',
      functions: 1,
      lines: new Set([354, 393]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/service-worker/setup.ts',
    {
      reason:
        'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
      functions: 1,
    },
  ],
  [
    'src/storage/auto.ts',
    {
      reason:
        'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
      lines: new Set([112, 114]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/storage/resolve.ts',
    {
      reason:
        'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
      functions: 6,
      lines: new Set([
        70, 71, 72, 73, 74, 79, 80, 81, 82, 83, 87, 96, 98, 99, 100, 101, 102, 103, 105, 113, 115,
        116, 117, 118, 119, 120, 122, 123, 124, 125, 126, 135, 136, 137, 140, 141, 142, 143, 144,
        145, 183, 191, 216, 237, 244, 245, 246, 247, 273, 274, 275, 276, 277, 278,
      ]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/storage/web-extension.ts',
    {
      reason:
        'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
      functions: 3,
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
      'src/client/http-handle.ts',
      {
        reason:
          'Bun reports one generated handle callback as missed although HTTP handle result and metadata paths are covered through transport-contract tests.',
        functions: 1,
      },
    ],
    [
      'src/client/http-schedule-handle.ts',
      {
        reason:
          'Bun reports one generated schedule-handle callback as missed although schedule operations are covered through transport-contract tests.',
        functions: 1,
      },
    ],
    [
      'src/core/context/durable-activity.ts',
      {
        reason:
          'The AsyncLocalStorage-unavailable fallback runs in portability subprocesses, whose hits Bun does not merge into the parent LCOV report.',
        functions: 3,
        lines: new Set([
          124, 147, 148, 149, 150, 160, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176,
          177, 178, 179, 180, 184, 185, 186, 187, 191, 192, 193, 194, 195, 196, 262, 263, 264, 266,
          267,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/parallel-operations.ts',
      {
        reason:
          'The remaining coordinator branches reject impossible nested-settlement states after race, all, and speculative paths are behaviorally covered.',
        lines: new Set([19, 20, 21, 31, 37, 38, 39]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/run-operation.ts',
      {
        reason:
          'Bun leaves the generator loop closing line cold after the final retry and catch paths settle, despite direct retry-state coverage.',
        lines: new Set([451]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/review-list-entries.ts',
      {
        reason:
          'The remaining review-list branch protects against a persisted review status excluded by the decoded state schema.',
        lines: new Set([120]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/types/definition-schema-to-json.ts',
      {
        reason:
          'The optional Valibot converter resolution failure is exercised without the dependency in a child process whose hits are not merged into parent Bun LCOV.',
        lines: new Set([172, 173, 174, 177, 178]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/worker-checkpoint-resume-state.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/core/worker-execution-strategy.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
      },
    ],
    [
      'src/mcp/resources.ts',
      {
        reason:
          'Bun maps the workflow-resource parser closing brace as uncovered after the direct state-URI parsing assertion executes its return path.',
        lines: new Set([188]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/mcp/stdio.ts',
      {
        reason:
          'The remaining stdio lines are process stream-error, close, and malformed-frame exits that cannot be deterministically attributed in the parent LCOV process.',
        functions: 3,
        lines: new Set([
          103, 104, 105, 106, 107, 126, 127, 205, 206, 207, 208, 209, 210, 211, 212, 241, 242, 279,
          280, 281, 282, 341, 342, 361, 362, 363, 364, 365, 366, 367, 368,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/api-catalog.ts',
      {
        reason:
          'The remaining catalog lines reject inconsistent operation metadata that the statically declared catalog does not contain.',
        lines: new Set([161, 162, 166, 167, 169, 170, 171, 172, 174, 176]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/json-rpc-dispatch.ts',
      {
        reason:
          'The remaining dispatch lines guard a catalog operation without a JSON-RPC binding, which registration validation excludes.',
        lines: new Set([188, 189]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/fake-timers.test-support.ts',
      {
        reason:
          'The remaining fake-timer line is the defensive error for a timer identifier not created by this test harness.',
        lines: new Set([232]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/storage-backends.test-support.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        lines: new Set([71, 72, 73]),
        requireUncoveredLines: true,
      },
    ],
  ],
);

const CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH = buildAllowanceLayer(
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH',
  [
    [
      'examples/order-processing/src/client.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
        lines: new Set([
          13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
          36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
          58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 73, 77, 78, 79, 80, 81, 82, 83,
          84, 85, 86, 87, 88, 89, 90, 91, 92,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'scripts/check-lint-disables.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
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
        requireUncoveredLines: true,
      },
    ],
    [
      'src/benchmarks/workflow-starts-runner.ts',
      {
        reason:
          'The throughput benchmark runs in a fresh Bun subprocess, and Bun does not propagate that child execution into parent-process LCOV.',
        functions: 1,
        lines: new Set([
          25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
          47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68,
          69, 70, 71, 72, 73, 79, 80, 81, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 95, 96,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/utilities.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([127]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/speculative-child.ts',
      {
        reason:
          'The remaining speculative-child branch guards a settlement state that the speculation coordinator prevents.',
        lines: new Set([25]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/callback-creators-core.ts',
      {
        reason:
          'Bun reports callback-wrapper function misses although the core callback bundles are exercised through engine lifecycle tests.',
        functions: 2,
      },
    ],
    [
      'src/core/engine/callback-creators-router-registry.ts',
      {
        reason:
          'The remaining router-registry lines reject a callback route omitted from the complete internal route table.',
        lines: new Set([26, 27, 29]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/termination/finalizer-claim.ts',
      {
        reason:
          'Bun reports the lease-loss closure as missed although finalizer claim success, contention, and deposition are behaviorally tested.',
        functions: 1,
      },
    ],
    [
      'src/core/schedule/cron-occurrence.ts',
      {
        reason:
          'The residual cron-occurrence line handles an invalid calendar rollover excluded by validated cron fields.',
        lines: new Set([217]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/worker-execution-ownership.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/core/worker-listener-registry.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/core/worker-protocol.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
      },
    ],
    [
      'src/server/operations/get-workflow-result.ts',
      {
        reason:
          'Bun reports the terminal-result callback as missed although successful, failed, and missing workflow results are covered through operation tests.',
        functions: 1,
      },
    ],
    [
      'src/server/workflow-event-feed.ts',
      {
        reason:
          'Bun maps the live-drain generator loop closing lines as uncovered because every tested exit returns from inside the intentional loop.',
        lines: new Set([384, 387]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/durability/adapter-spec.test-support.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 5,
        lines: new Set([
          35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191,
          192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 220, 221, 222, 223, 224,
          305,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/indexeddb-fault-harness.test-support.ts',
      {
        reason:
          'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
        functions: 2,
      },
    ],
    [
      'src/storage/indexeddb.ts',
      {
        reason:
          'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
        functions: 1,
      },
    ],
    [
      'src/worker/registry/fair-share.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/testing/scheduler-contract.test-support.ts',
      {
        reason:
          'Bun reports a callback in the shared scheduler contract harness as missed although each adapter executes the contract assertions.',
        functions: 7,
      },
    ],
    [
      'src/server/json-rpc-websocket-client.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
        lines: new Set([96, 97, 111, 115, 126, 134, 139, 144, 149]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/subprocess-engine.ts',
      {
        reason:
          'Subprocess-engine startup and failure paths run in child Bun processes whose hits are not merged into the parent LCOV report.',
        functions: 8,
        lines: new Set([
          125, 126, 127, 128, 129, 145, 146, 147, 252, 253, 254, 255, 256, 257, 258, 296, 302, 490,
          491, 492, 493, 494, 495, 496, 497,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/worker-fault-injection-frames.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
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
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/worker-fault-injection.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 15,
        lines: new Set([
          90, 105, 106, 107, 108, 116, 117, 118, 149, 150, 151, 152, 153, 154, 155, 156, 161, 162,
          163, 164, 207, 208, 209, 210, 240, 246, 247, 248, 249, 250, 255, 256, 257, 276, 289, 290,
          306, 307, 308, 309, 310, 317, 318, 319, 355, 356, 363, 367, 381, 382, 388, 393, 394, 401,
          402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 415, 424, 425, 431, 432, 437,
          438, 451, 452, 453, 454, 455, 456, 460, 461, 462, 463, 464, 468, 469, 470, 471, 472,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/worker/registry/summary.ts',
      // Was lines 134-139; shifted to 129-134 when WFT-27 dropped `gitSha`
      // from the deployment-identity tuple, removing 5 lines above this
      // function. Same unexercised `compareDeploymentSummaries` comparator.
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
        lines: new Set([129, 130, 131, 132, 133, 134]),
        requireUncoveredLines: true,
      },
    ],
  ],
);

const CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH = buildAllowanceLayer(
  'CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH',
  [
    [
      'examples/hello-world/src/index.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([68, 69, 71, 72]),
        requireUncoveredLines: true,
      },
    ],
    [
      'examples/order-processing/src/server.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
        lines: new Set([12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28, 30, 32]),
        requireUncoveredLines: true,
      },
    ],
    [
      'scripts/husky/pre-commit.ts',
      {
        reason:
          'Stash and interruption behavior runs in real Git child processes, whose signal-handler and executable-hook hits are not merged into parent Bun LCOV.',
        functions: 8,
        lines: createMergedLineSet(
          new Set([
            54, 55, 84, 85, 86, 99, 100, 101, 112, 123, 124, 125, 131, 132, 133, 151, 152, 153, 160,
            161, 162, 165, 167, 168, 169, 172, 200, 201, 202, 203, 204, 205, 206, 207,
          ]),
          createLineSet(229, 451),
        ),
        requireUncoveredLines: true,
      },
    ],
    [
      'scripts/husky/run-tests.ts',
      {
        reason:
          'Signal forwarding and descendant termination run in child processes outside parent LCOV; Windows and process-group fallbacks are platform-specific.',
        functions: 9,
        lines: new Set([478, 483, 484, 485, 538, 539, 540, 542, 543, 547, 556, 585, 586, 587, 624]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/api-arguments.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([55]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/codegen.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
        lines: new Set([94, 95, 184, 185, 234, 279, 280, 410, 441, 442, 443, 445, 446, 447, 448]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/json-input.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
      },
    ],
    [
      'src/cli/noun-verb-arguments.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([172]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/output.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 5,
      },
    ],
    [
      'src/cli/serve-registrations.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([42, 43, 44, 45]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/server-client.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([65, 66, 76]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/server-commands.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([80, 81, 82, 83, 84, 168, 169]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/tail.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 3,
        lines: new Set([101]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/client/client-contract.test-support.ts',
      {
        reason:
          'Bun reports unnamed callbacks in this shared contract harness despite direct coverage of query, update, signal, async-activity, and event-wait paths.',
        functions: 3,
      },
    ],
    [
      'src/client/event-stream-transport.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        lines: new Set([153]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/client/event-stream.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/client/event-stream.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/client/local-event-tail.ts',
      {
        reason:
          'The remaining local-tail lines are listener teardown after terminal settlement, covered behaviorally but not mapped by Bun to the closing callback.',
        functions: 2,
        lines: new Set([157, 158]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/connection.ts',
      {
        reason:
          'The residual connection line is the already-closed cleanup branch reached only by a transport close race.',
        lines: new Set([220]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/anonymous-signal-sequence.ts',
      {
        reason:
          'Bun reports sequence-update closures as missed although initialization, increment, overflow, and persistence behavior is covered.',
        functions: 2,
      },
    ],
    [
      'src/mcp/dispatcher.ts',
      {
        reason:
          'Bun reports three unnamed aggregate functions despite direct response assertions executing resource-template, prompt, unsubscribe, and response-error handlers.',
        functions: 3,
      },
    ],
    [
      'src/server/dashboard-assets.ts',
      {
        reason:
          'Segment validation rejects empty, parent, and absolute paths before resolution, making the final asset-containment guard defensive.',
        lines: new Set([188]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/operation-catalog/workflow-adapter.ts',
      {
        reason:
          'The remaining adapter branches translate impossible catalog result variants excluded by each operation definition.',
        lines: new Set([172, 173, 174, 175, 176, 180, 181, 184, 185, 186, 187, 188, 192, 193]),
        requireUncoveredLines: true,
      },
    ],
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
    [
      'scripts/lib/workflow-visibility-backfill.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([
          67, 136, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/conformance.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
        lines: new Set([55, 106, 128, 141, 151, 152, 168, 169, 222, 294, 332]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/parse-schedule-arguments.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([196, 197, 198, 199, 200, 201]),
        requireUncoveredLines: true,
      },
    ],
    [
      'scripts/husky/verify-hooks-installed.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/child-workflow-pipe.ts',
      {
        reason:
          'The remaining pipe branches handle simultaneous child settlement and parent cancellation races covered at the coordinator boundary.',
        lines: new Set([46, 48, 49, 66, 67, 105, 119, 120, 126, 128, 129, 130, 131, 133, 134]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/version-patching.ts',
      {
        reason:
          'The residual version-patching lines reject inconsistent patch records that valid checkpoint construction cannot emit.',
        lines: new Set([30, 31, 32, 51, 56, 62, 78, 79, 80]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/lazy-postgres-pool.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
      },
    ],
    [
      'src/storage/http.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
        lines: new Set([238]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/neon.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
        lines: new Set([39]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/postgres.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
        lines: new Set([42, 43, 44, 45, 46, 47]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/attributes-tags.ts',
      {
        reason:
          'The remaining attribute-tag branches reject decoded value shapes excluded by search-attribute boundary validation.',
        functions: 1,
        lines: new Set([341, 342, 344]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/callback-creators-bundles.ts',
      {
        reason:
          'Bun reports one callback-bundle closure as missed although each bundle is exercised through engine lifecycle integration tests.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/checkpoint-replay.ts',
      {
        reason:
          'The remaining replay line guards a checkpoint operation kind excluded by the decoded effect-log union.',
        lines: new Set([134]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/index.ts',
      {
        reason:
          'Bun reports aggregate re-export and factory closures as missed although the engine entrypoint has complete line coverage.',
        functions: 4,
      },
    ],
    [
      'src/core/engine/lease-deposition.ts',
      {
        reason:
          'Bun reports the deposition callback as missed although successful deposition and lease-loss behavior are covered through fenced-write tests.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/lifecycle/resume.ts',
      {
        reason:
          'The remaining resume line is a defensive missing-workflow-definition branch after recovery registration validation.',
        functions: 1,
        lines: new Set([91]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/lifecycle/start-commit.ts',
      {
        reason:
          'Bun reports one start-commit closure as missed although idempotent, conflicting, and successful commits are covered.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/lifecycle/transition.ts',
      {
        reason:
          'Bun reports one transition closure as missed although terminal, cancellation, and failure transitions are covered.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/listing.ts',
      {
        reason:
          'The remaining line is the equality tiebreaker after both strict id-order branches have been exercised; distinct workflow ids cannot reach it.',
        lines: new Set([237]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/pending-updates.ts',
      {
        reason:
          'Bun reports pending-update callbacks as missed although enqueue, replace, apply, and teardown behavior is covered.',
        functions: 2,
      },
    ],
    [
      'src/core/engine/storage-io.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/stream-chunk-loading.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        lines: new Set([47, 51]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/workflow-concurrency.ts',
      {
        reason:
          'The remaining concurrency branches cover lease-loss and simultaneous-settlement interleavings whose public outcomes are tested without deterministic line attribution.',
        functions: 1,
        lines: new Set([
          57, 58, 59, 60, 61, 62, 63, 64, 65, 67, 68, 69, 70, 110, 111, 112, 131, 138, 139, 206,
          207,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/scheduler/timer-sources.ts',
      {
        reason:
          'The residual timer-source line guards an unknown persisted timer kind excluded by timer decoding.',
        lines: new Set([51]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/mcp/http.ts',
      {
        reason:
          'The remaining HTTP lines are socket-close, stream-cancel, and response-write failure exits exercised through transport teardown without stable line attribution.',
        lines: new Set([115, 116, 117, 118, 119, 120, 121, 122, 204, 205, 230, 379, 423]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/authentication/index.ts',
      {
        reason:
          'The residual authentication line guards an authentication provider result outside the declared provider contract.',
        lines: new Set([158]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/authentication/rotating-api-key-store.ts',
      {
        reason:
          'The remaining key-store branches handle rotation races and malformed stored key metadata excluded by validated writes.',
        lines: new Set([163, 165, 166, 167]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/fault-to-json-rpc.ts',
      {
        reason:
          'Bun reports the default fault-mapping closure as missed although every public Weft fault code and generic fallback are asserted.',
        functions: 1,
      },
    ],
    [
      'src/server/operations/bulk-retry-failed-workflows.ts',
      {
        reason:
          'The residual bulk-retry line handles a workflow disappearing between preview and fenced commit.',
        lines: new Set([81]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/rest-body.ts',
      {
        reason:
          'The remaining body-reader branches are stream abort and reader failure exits that depend on host transport faults.',
        functions: 1,
        lines: new Set([19, 20, 21, 22, 23, 30, 39, 43]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/runtime/task-result-resolution.ts',
      {
        reason:
          'A direct unit test calls taskResultPayloadSizeError with an oversized completion and asserts the returned PayloadSizeExceededError, but Bun LCOV still reports the catch-block closing brace and one aggregate function as missed.',
        functions: 1,
        lines: new Set([42]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/runtime/websocket-stream.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/server/runtime/websocket-worker.ts',
      // The closed WorkerToServerMessage union makes this default branch
      // unreachable at runtime; it exists solely as a compile-time
      // exhaustiveness guard: `case 'heartbeat': {` / its closing `}` (272,
      // 275), `default: {` (276), and the two dead statements inside it,
      // `const _exhaustive` / `return _exhaustive` (279, 280). Only 279 and
      // 280 are deterministically 0 across every run; the four case-label
      // and brace lines around them (271, 272, 275, 276) flip between hit
      // and unhit run to run with byte-identical source — a switch-statement
      // coverage-attribution artifact, not a real reachability signal — so
      // `requireUncoveredLines` is intentionally omitted here rather than
      // chasing whichever subset happens to be 0 in a given run.
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        lines: new Set([271, 272, 275, 276, 279, 280]),
      },
    ],
    [
      'src/storage/turso.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
        lines: new Set([50, 51, 52]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/workers/workflow-runner.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
        lines: new Set([500]),
        requireUncoveredLines: true,
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
    const requireUncoveredLines =
      current?.requireUncoveredLines === true || topOff.requireUncoveredLines === true;

    merged.set(filePath, {
      ...(functions > 0 ? { functions } : {}),
      ...(lines === undefined ? {} : { lines }),
      ...(requireUncoveredLines ? { requireUncoveredLines: true } : {}),
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
  const coveredLineAllowances: string[] = [];

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

  function resetCurrentFile(): void {
    currentFile = '';
    fileLineTotal = 0;
    fileLineHit = 0;
    fileFunctionTotal = 0;
    fileFunctionHit = 0;
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
      const allowance = COVERAGE_ALLOWANCES.get(currentFile);
      const ignoredLines = allowance?.lines;

      if (ignoredLines?.has(lineNumber)) {
        if (hitCount > 0 && allowance.requireUncoveredLines === true) {
          coveredLineAllowances.push(`${currentFile}:${String(lineNumber)}`);
        } else {
          continue;
        }
      }

      fileLineTotal += 1;
      if (hitCount > 0) {
        fileLineHit += 1;
      }
    } else if (line === 'end_of_record') {
      finalizeCurrentFile();
      resetCurrentFile();
    }
  }

  finalizeCurrentFile();
  if (coveredLineAllowances.length > 0) {
    throw new Error(
      `Coverage allowance for ${coveredLineAllowances.join(', ')} points at a covered line. ` +
        'Realign or remove the stale allowance instead of subtracting unrelated coverage.',
    );
  }
  return files;
}

/**
 * Parse an lcov report and return per-metric totals plus the list of files with gaps.
 */
export function parseLcov(content: string): CoverageResult {
  return summarizeCoverageFiles(parseLcovFiles(content));
}

export async function listCoverageTestFiles(): Promise<string[]> {
  // Git supplies the repository ownership boundary that `rg --files` previously
  // provided: tracked files plus untracked, non-ignored files. A root Bun.Glob scan
  // does not honor `.gitignore` and therefore discovers dependency-owned tests under
  // node_modules after `bun install`.
  const repositoryFileOutput = await $`git ls-files --cached --others --exclude-standard`.text();
  const repositoryFiles = repositoryFileOutput.split('\n').filter(Boolean);
  const testFileGlobs = COVERAGE_TEST_FILE_GLOBS.map((pattern) => new Glob(pattern));

  return repositoryFiles
    .filter((file) => {
      const basename = file.slice(file.lastIndexOf('/') + 1);
      return testFileGlobs.some((glob) => glob.match(basename));
    })
    .toSorted();
}

type CoverageShard = {
  name: string;
  coverageDirectory: string;
  testFiles: string[];
  parallelism?: number;
};

type CoverageProcess = {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
};

type SpawnCoverageProcess = (
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stderr: 'pipe';
    stdout: 'pipe';
  },
) => CoverageProcess;

type RunCoverageShardDependencies = {
  spawnCoverageProcess?: SpawnCoverageProcess;
};

type CheckCoverageDependencies = {
  listCoverageTestFiles?: () => Promise<string[]>;
  runCoverageShard?: (shard: CoverageShard) => Promise<{ exitCode: number; lcovPath: string }>;
};

type CapturedOutputTail = {
  bytes: Uint8Array;
  truncatedBytes: number;
};

async function captureOutputTail(
  stream: ReadableStream<Uint8Array> | null,
): Promise<CapturedOutputTail> {
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let discardedBytes = 0;

  if (stream === null) return { bytes: new Uint8Array(), truncatedBytes: 0 };

  for await (const chunk of stream) {
    let retainedChunk = chunk;
    if (retainedChunk.byteLength > COVERAGE_FAILURE_OUTPUT_TAIL_BYTES) {
      discardedBytes += retainedChunk.byteLength - COVERAGE_FAILURE_OUTPUT_TAIL_BYTES;
      retainedChunk = retainedChunk.slice(
        retainedChunk.byteLength - COVERAGE_FAILURE_OUTPUT_TAIL_BYTES,
      );
    }

    chunks.push(retainedChunk);
    retainedBytes += retainedChunk.byteLength;

    while (retainedBytes > COVERAGE_FAILURE_OUTPUT_TAIL_BYTES) {
      const overflowBytes = retainedBytes - COVERAGE_FAILURE_OUTPUT_TAIL_BYTES;
      const firstChunk = chunks[0];
      if (firstChunk.byteLength <= overflowBytes) {
        discardedBytes += firstChunk.byteLength;
        retainedBytes -= firstChunk.byteLength;
        chunks.shift();
        continue;
      }

      discardedBytes += overflowBytes;
      chunks[0] = firstChunk.slice(overflowBytes);
      retainedBytes -= overflowBytes;
    }
  }

  const output = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: output, truncatedBytes: discardedBytes };
}

function writeFailureOutput(label: string, output: CapturedOutputTail): void {
  if (output.bytes.byteLength === 0 && output.truncatedBytes === 0) return;

  if (output.truncatedBytes > 0) {
    process.stderr.write(
      `[${label}] omitted ${output.truncatedBytes.toLocaleString()} earlier output bytes; ` +
        `showing the final ${output.bytes.byteLength.toLocaleString()} bytes.\n`,
    );
  }

  process.stderr.write(output.bytes);
}

export async function runCoverageShard(
  shard: CoverageShard,
  dependencies: RunCoverageShardDependencies = {},
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

  const spawnCoverageProcess =
    dependencies.spawnCoverageProcess ?? ((spawnArgs, options) => Bun.spawn(spawnArgs, options));
  const coverageProcess = spawnCoverageProcess(args, {
    cwd: globalThis.process.cwd(),
    env: { ...process.env, ...Bun.env, WEFT_COVERAGE_MODE: '1' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    captureOutputTail(coverageProcess.stdout),
    captureOutputTail(coverageProcess.stderr),
    coverageProcess.exited,
  ]);

  if (exitCode !== 0) {
    writeFailureOutput(`${shard.name} stdout`, stdout);
    writeFailureOutput(`${shard.name} stderr`, stderr);
    console.error(`${shard.name} coverage shard exited with code ${exitCode}.`);
  }

  return { exitCode, lcovPath: `${shard.coverageDirectory}/lcov.info` };
}

/**
 * Run the test suite with coverage, parse the lcov report, and return whether
 * every line and function is covered.
 */
export async function checkCoverage(
  dependencies: CheckCoverageDependencies = {},
): Promise<boolean> {
  // Remove the entire coverage directory so we never read a previous run's report.
  await $`rm -rf coverage`.quiet().nothrow();
  const allTestFiles = await (dependencies.listCoverageTestFiles ?? listCoverageTestFiles)();

  const shard = await (dependencies.runCoverageShard ?? runCoverageShard)({
    name: 'coverage',
    coverageDirectory: 'coverage',
    // Let Bun use its default coverage workers. Forcing this repository into one
    // instrumented process can crash Bun before it writes LCOV on large suites.
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
