import { describe, expect, it, mock, spyOn } from 'bun:test';

import {
  assembleAllowanceLayers,
  assertNoAllowanceKeyIsCoverageIgnored,
  buildAllowanceLayer,
  checkCoverage,
  listCoverageTestFiles,
  parseLcov,
  readCoveragePathIgnorePatterns,
  runCoverageShard,
} from './check-coverage.ts';

describe('listCoverageTestFiles', () => {
  it('discovers only repository-owned test files without depending on ripgrep', async () => {
    const files = await listCoverageTestFiles();

    expect(files).toContain('scripts/check-coverage.test.ts');
    expect(files).toContain('scripts/ci-workflows.test.ts');
    expect(files).not.toContain('scripts/check-coverage.ts');
    expect(files.some((file) => file.includes('node_modules/'))).toBe(false);
    expect(files.some((file) => file.startsWith('coverage/'))).toBe(false);
    expect(files).toEqual(files.toSorted());
  });
});

describe('parseLcov', () => {
  it('accepts DA lines with the optional checksum field', () => {
    const coverage = parseLcov(
      [
        'SF:src/example.ts',
        'FNF:0',
        'FNH:0',
        'DA:10,1,abc123',
        'DA:11,0,def456',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.lines.total).toBe(2);
    expect(coverage.lines.hit).toBe(1);
    expect(coverage.lines.missed).toBe(1);
    expect(coverage.covered).toBe(false);
    expect(coverage.uncoveredFiles).toEqual(['src/example.ts']);
  });

  it('rejects a line allowance that points at covered code', () => {
    expect(() =>
      parseLcov(
        [
          'SF:src/core/context/parallel-operations.ts',
          'FNF:0',
          'FNH:0',
          'DA:19,1',
          'end_of_record',
        ].join('\n'),
      ),
    ).toThrow(
      'Coverage allowance for src/core/context/parallel-operations.ts:19 points at a covered line',
    );
  });

  it('applies the strict parallel-operation allowance only to its current uncovered lines', () => {
    const coverage = parseLcov(
      [
        'SF:src/core/context/parallel-operations.ts',
        'FNF:1',
        'FNH:0',
        'DA:19,0',
        'DA:20,0',
        'DA:21,0',
        'DA:22,1',
        'DA:31,0',
        'DA:37,0',
        'DA:38,0',
        'DA:39,0',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(true);
    expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
  });

  it('ignores generated temporary workflow artifacts', () => {
    const generatedFiles = [
      'weft-schedule-workflows-example.ts',
      'weft-schedule-input-example.ts',
      'weft-schedule-lmdb-workflows-example.ts',
      'weft-schedule-lmdb-input-example.ts',
      'weft-cli-edge-workflows-example.ts',
      'weft-validate-TA9zHl/conflict.ts',
    ];
    const generatedPrefixes = [
      '../../../../../../var/folders/x_/tmp',
      '../../../../../private/var/folders/x_/T',
      '../../../../../var/folders/x_/T',
      // Deep git-worktree forms (#503): a worktree nested under .claude/worktrees/<name>
      // records temp-fixture paths with more `../` segments and a `private/tmp/` or
      // bare `tmp/` root instead of `var/folders/`. These must be filtered too.
      '../../../../../../../private/tmp/claude-501',
      '../../../../../../../tmp/claude-501',
    ];

    for (const generatedPrefix of generatedPrefixes) {
      for (const generatedFile of generatedFiles) {
        const coverage = parseLcov(
          [
            `SF:${generatedPrefix}/${generatedFile}`,
            'FNF:1',
            'FNH:0',
            'DA:1,0',
            'end_of_record',
            'SF:src/example.ts',
            'FNF:1',
            'FNH:1',
            'DA:1,1',
            'end_of_record',
          ].join('\n'),
        );

        expect(coverage.covered).toBe(true);
        expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
        expect(coverage.functions).toEqual({ total: 1, hit: 1, missed: 0 });
        expect(coverage.uncoveredFiles).toEqual([]);
      }
    }
  });

  it('does not ignore nearby non-generated temporary files', () => {
    const coverage = parseLcov(
      [
        'SF:../../../../../../private/var/folders/x_/tmp/weft-schedule-output-example.ts',
        'FNF:1',
        'FNH:0',
        'DA:1,0',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(false);
    expect(coverage.lines).toEqual({ total: 1, hit: 0, missed: 1 });
    expect(coverage.functions).toEqual({ total: 1, hit: 0, missed: 1 });
    expect(coverage.uncoveredFiles).toEqual([
      '../../../../../../private/var/folders/x_/tmp/weft-schedule-output-example.ts',
    ]);
  });

  // The widened temp-root prefix now also matches `private/tmp/` and bare `tmp/` at
  // any `../` depth (#503). Prove that widening alone does NOT suppress coverage: a
  // non-fixture-named source file under those newly-accepted roots and deep worktree
  // depth must still count as uncovered, because the fixture-NAME matcher gates it.
  it('does not ignore non-generated temporary files under the widened tmp roots', () => {
    const nonFixturePaths = [
      '../../../../../../../private/tmp/claude-501/weft-schedule-output-example.ts',
      '../../../../../../../tmp/claude-501/weft-schedule-output-example.ts',
    ];

    for (const nonFixturePath of nonFixturePaths) {
      const coverage = parseLcov(
        [`SF:${nonFixturePath}`, 'FNF:1', 'FNH:0', 'DA:1,0', 'end_of_record'].join('\n'),
      );

      expect(coverage.covered).toBe(false);
      expect(coverage.lines).toEqual({ total: 1, hit: 0, missed: 1 });
      expect(coverage.functions).toEqual({ total: 1, hit: 0, missed: 1 });
      expect(coverage.uncoveredFiles).toEqual([nonFixturePath]);
    }
  });

  it('unions audit-backlog top-off allowances with the assembled base allowances', () => {
    const coverage = parseLcov(
      [
        'SF:src/workers/workflow-runner.ts',
        'FNF:4',
        'FNH:0',
        'DA:101,0',
        'DA:500,0',
        'DA:999,1',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(true);
    expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
    expect(coverage.functions).toEqual({ total: 0, hit: 0, missed: 0 });
    expect(coverage.uncoveredFiles).toEqual([]);
  });

  it('preserves strict uncovered-line checks when a top-off is assembled', () => {
    expect(() =>
      parseLcov(
        [
          'SF:src/server/runtime/websocket-worker.ts',
          'FNF:0',
          'FNH:0',
          'DA:430,1',
          'end_of_record',
        ].join('\n'),
      ),
    ).toThrow(
      'Coverage allowance for src/server/runtime/websocket-worker.ts:430 points at a covered line',
    );
  });

  it('returns false immediately when a coverage shard exits non-zero', async () => {
    const listCoverageTestFilesStub = mock(async () => ['src/example.test.ts']);
    const runCoverageShardStub = mock(async () => ({
      exitCode: 1,
      lcovPath: 'coverage/lcov.info',
    }));
    const errorSpy = mock((_message?: unknown, ..._args: unknown[]) => {});

    using consoleErrorSpy = spyOn(console, 'error').mockImplementation(errorSpy);

    await expect(
      checkCoverage({
        listCoverageTestFiles: listCoverageTestFilesStub,
        runCoverageShard: runCoverageShardStub,
      }),
    ).resolves.toBe(false);
    expect(listCoverageTestFilesStub).toHaveBeenCalledTimes(1);
    expect(runCoverageShardStub).toHaveBeenCalledTimes(1);
    expect(runCoverageShardStub).toHaveBeenCalledWith({
      name: 'coverage',
      coverageDirectory: 'coverage',
      testFiles: ['src/example.test.ts'],
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Coverage execution failed.');
  });

  it('propagates a non-zero child exit through the real coverage shard runner', async () => {
    const spawnCoverageProcess = mock(() => ({
      exited: Promise.resolve(7),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    }));
    using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runCoverageShard(
        {
          name: 'synthetic',
          coverageDirectory: 'coverage/synthetic',
          testFiles: ['src/example.test.ts'],
        },
        { spawnCoverageProcess },
      ),
    ).resolves.toEqual({
      exitCode: 7,
      lcovPath: 'coverage/synthetic/lcov.info',
    });
    expect(spawnCoverageProcess).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('synthetic coverage shard exited with code 7.');
  });
});

describe('buildAllowanceLayer', () => {
  it('builds a map from unique entries, preserving each allowance value', () => {
    const layer = buildAllowanceLayer('SYNTHETIC_LAYER', [
      ['src/alpha.ts', { lines: new Set([1, 2, 3]) }],
      ['src/beta.ts', { functions: 2 }],
    ]);

    expect(layer.size).toBe(2);
    expect(layer.get('src/alpha.ts')).toEqual({ lines: new Set([1, 2, 3]) });
    expect(layer.get('src/beta.ts')).toEqual({ functions: 2 });
  });

  it('throws on a duplicate key within a single layer, naming the layer and key', () => {
    // A `new Map([...])` would silently keep only the last entry for a repeated
    // key, dropping the first allowance with no signal. The builder must turn
    // that copy-paste mistake into a build-time error.
    expect(() =>
      buildAllowanceLayer('DUPLICATED_LAYER', [
        ['src/repeated.ts', { lines: new Set([10]) }],
        ['src/other.ts', { lines: new Set([20]) }],
        ['src/repeated.ts', { lines: new Set([30]) }],
      ]),
    ).toThrow(/^Duplicate coverage-allowance key "src\/repeated\.ts" within DUPLICATED_LAYER\./);
  });

  it('accepts an empty layer', () => {
    expect(buildAllowanceLayer('EMPTY_LAYER', []).size).toBe(0);
  });
});

describe('assembleAllowanceLayers', () => {
  // An empty pair of refresh layers, used when a test exercises only the
  // ordered-merge behavior and not the refresh-layer exclusivity check.
  const noRefreshCollision = [
    ['MAIN_REFRESH', buildAllowanceLayer('MAIN_REFRESH', [])],
    ['BRANCH_REFRESH', buildAllowanceLayer('BRANCH_REFRESH', [])],
  ] as const;

  it('lets a later layer override an earlier layer for a shadowed key', () => {
    // Base/override layering is the legitimate mechanic: the override layer wins
    // for a shared key. Only refresh-layer-vs-refresh-layer collisions are barred.
    const base = buildAllowanceLayer('BASE', [
      ['src/shared.ts', { lines: new Set([1]) }],
      ['src/base-only.ts', { lines: new Set([2]) }],
    ]);
    const override = buildAllowanceLayer('OVERRIDE', [
      ['src/shared.ts', { lines: new Set([99]) }],
      ['src/override-only.ts', { lines: new Set([3]) }],
    ]);

    const assembled = assembleAllowanceLayers(
      [
        ['BASE', base],
        ['OVERRIDE', override],
      ],
      noRefreshCollision,
    );

    expect(assembled.size).toBe(3);
    expect(assembled.get('src/shared.ts')).toEqual({ lines: new Set([99]) });
    expect(assembled.get('src/base-only.ts')).toEqual({ lines: new Set([2]) });
    expect(assembled.get('src/override-only.ts')).toEqual({ lines: new Set([3]) });
  });

  it('applies last-layer-wins across three or more layers, identical to a Map spread', () => {
    // Pin the behavior-preservation contract: the helper must collapse N ordered
    // layers exactly as `new Map([...layerA, ...layerB, ...layerC])` would, so the
    // refactor away from the old spread assembly cannot silently change ordering.
    const layerA = buildAllowanceLayer('A', [
      ['src/shared.ts', { lines: new Set([1]) }],
      ['src/a-only.ts', { lines: new Set([10]) }],
    ]);
    const layerB = buildAllowanceLayer('B', [
      ['src/shared.ts', { lines: new Set([2]) }],
      ['src/b-only.ts', { lines: new Set([20]) }],
    ]);
    const layerC = buildAllowanceLayer('C', [['src/shared.ts', { lines: new Set([3]) }]]);

    const assembled = assembleAllowanceLayers(
      [
        ['A', layerA],
        ['B', layerB],
        ['C', layerC],
      ],
      noRefreshCollision,
    );
    const spread = new Map([...layerA, ...layerB, ...layerC]);

    // The last layer (C) wins for the thrice-shared key.
    expect(assembled.get('src/shared.ts')).toEqual({ lines: new Set([3]) });
    expect(assembled).toEqual(spread);
  });

  it('throws when a key appears in both mutually-exclusive refresh layers', () => {
    // The two refresh layers must partition their keys: a twin in both means
    // removing one row silently reactivates the other (often stale) allowance.
    const mainRefresh = buildAllowanceLayer('MAIN_REFRESH', [
      ['src/twin.ts', { lines: new Set([1]) }],
    ]);
    const branchRefresh = buildAllowanceLayer('BRANCH_REFRESH', [
      ['src/twin.ts', { lines: new Set([2]) }],
    ]);

    expect(() =>
      assembleAllowanceLayers(
        [
          ['MAIN_REFRESH', mainRefresh],
          ['BRANCH_REFRESH', branchRefresh],
        ],
        [
          ['MAIN_REFRESH', mainRefresh],
          ['BRANCH_REFRESH', branchRefresh],
        ],
      ),
    ).toThrow(
      /^Coverage-allowance key "src\/twin\.ts" appears in both MAIN_REFRESH and BRANCH_REFRESH\./,
    );
  });

  it('allows a key shared between a non-exclusive layer and a refresh layer', () => {
    // Only the two refresh layers are mutually exclusive. A base/override layer
    // may still legitimately shadow a refresh layer's key.
    const base = buildAllowanceLayer('BASE', [['src/shared.ts', { lines: new Set([1]) }]]);
    const branchRefresh = buildAllowanceLayer('BRANCH_REFRESH', [
      ['src/shared.ts', { lines: new Set([2]) }],
    ]);
    const mainRefresh = buildAllowanceLayer('MAIN_REFRESH', []);

    const assembled = assembleAllowanceLayers(
      [
        ['BASE', base],
        ['MAIN_REFRESH', mainRefresh],
        ['BRANCH_REFRESH', branchRefresh],
      ],
      [
        ['MAIN_REFRESH', mainRefresh],
        ['BRANCH_REFRESH', branchRefresh],
      ],
    );

    // BRANCH_REFRESH is the terminal layer, so its value wins over BASE.
    expect(assembled.get('src/shared.ts')).toEqual({ lines: new Set([2]) });
  });
});

describe('readCoveragePathIgnorePatterns', () => {
  it('returns exactly the coveragePathIgnorePatterns array parsed from bunfig.toml', async () => {
    // Single source of truth: the patterns come from bunfig.toml, not a hardcoded list.
    // Assert against the file's actual contents (parsed independently here) rather than a
    // pinned member, so the test does not break when the ignore list legitimately changes
    // — it only fails if the function stops reflecting bunfig.toml.
    const bunfigText = await Bun.file(new URL('../bunfig.toml', import.meta.url)).text();
    const parsed = Bun.TOML.parse(bunfigText) as {
      test?: { coveragePathIgnorePatterns?: unknown };
    };
    // The function normalizes an absent `[test].coveragePathIgnorePatterns` to `[]`, so
    // mirror that here: a bunfig that drops the field entirely must still match (the
    // function is still correct), not fail because raw parse yields `undefined`.
    const expected = parsed.test?.coveragePathIgnorePatterns ?? [];

    expect(readCoveragePathIgnorePatterns()).toEqual(expected);
  });
});

describe('assertNoAllowanceKeyIsCoverageIgnored', () => {
  it('throws when an allowance key matches a coveragePathIgnorePatterns entry, naming both', () => {
    // A file in coveragePathIgnorePatterns is never instrumented, so an allowance for
    // it is dead — it ignores nothing and its line numbers drift silently (#539). This
    // is exactly the dead self-allowance that lingered on scripts/check-coverage.ts.
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(
        new Map([['scripts/check-coverage.ts', { functions: 1 }]]),
        ['scripts/check-coverage.ts'],
      ),
    ).toThrow(
      /^Coverage-allowance key "scripts\/check-coverage\.ts" matches coveragePathIgnorePatterns entry "scripts\/check-coverage\.ts"/,
    );
  });

  it('matches a glob pattern against an allowance key', () => {
    // coveragePathIgnorePatterns supports globs; a `**`/`*` pattern must be matched
    // structurally, not just by substring, so a glob-ignored path is also caught.
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/generated/client.ts', {}]]), [
        'src/generated/**',
      ]),
    ).toThrow(/matches coveragePathIgnorePatterns entry "src\/generated\/\*\*"/);
  });

  it('matches `?` and `[…]` glob metacharacters, not just `*`', () => {
    // Bun matches coveragePathIgnorePatterns as globs, so `?` and character classes are
    // metacharacters too — a `*`-only matcher would miss these (a false negative).
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/question.ts', {}]]), [
        'src/qu?stion.ts',
      ]),
    ).toThrow(/matches coveragePathIgnorePatterns entry/);
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/bracket-x.ts', {}]]), [
        'src/bracket-[xy].ts',
      ]),
    ).toThrow(/matches coveragePathIgnorePatterns entry/);
  });

  it('does NOT treat a bare pattern as a substring (Bun uses glob, not substring, matching)', () => {
    // The crux: Bun does NOT substring-match. A bare `nested` does not exclude
    // `sub/nested-file.ts` (verified empirically — see the characterization test below),
    // so a substring matcher would WRONGLY reject a live allowance here.
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/sub/nested-file.ts', {}]]), ['nested']),
    ).not.toThrow();
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/exact-match.ts', {}]]), ['match']),
    ).not.toThrow();
  });

  it('does not throw when no allowance key matches an ignore pattern', () => {
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(
        new Map([
          ['src/core/engine/index.ts', { functions: 2 }],
          ['src/workers/workflow-runner.ts', { lines: new Set([500]) }],
        ]),
        ['scripts/check-coverage.ts', 'src/generated/**'],
      ),
    ).not.toThrow();
  });

  it('is a no-op when there are no ignore patterns', () => {
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['scripts/check-coverage.ts', {}]]), []),
    ).not.toThrow();
  });

  it('the live module loads — its load-time guard accepts the real allowance set', async () => {
    // The guard runs at module load against the REAL assembled COVERAGE_ALLOWANCES. A
    // fresh dynamic import re-executes that top-level guard; a future dead allowance
    // (a real allowance key matching a real ignore pattern) makes this import throw, so
    // the regression is caught here, not only when `check-coverage.ts` is run directly.
    await expect(import('./check-coverage.ts?live-guard')).resolves.toBeDefined();
  });
});

describe('allowanceKeyMatchesIgnorePattern agrees with Bun coverage-ignore semantics', () => {
  // Characterization test: the guard's correctness depends ENTIRELY on matching how Bun
  // actually applies coveragePathIgnorePatterns. Rather than trust a hand-modeled matcher,
  // run real `bun test --coverage` against temp fixtures with representative patterns,
  // observe which files Bun excludes from LCOV, and assert assertNoAllowanceKeyIsCoverageIgnored
  // throws for exactly the excluded files (and not the kept ones).
  it('matches Bun for exact, *, ?, [], **, and bare-substring patterns', async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const root = await mkdtemp(join(tmpdir(), 'weft-cov-char-'));
    try {
      await mkdir(join(root, 'sub'), { recursive: true });
      const files = [
        'exact-match.ts',
        'sub/nested-file.ts',
        'question.ts',
        'bracket-x.ts',
        'plain-substr.ts',
      ];
      for (const [index, file] of files.entries()) {
        await writeFile(
          join(root, file),
          `export const v${String(index)} = () => ${String(index)};\n`,
        );
      }
      const imports = files
        .map((file, index) => `import { v${String(index)} } from './${file}';`)
        .join('\n');
      await writeFile(
        join(root, 'all.test.ts'),
        `import { test, expect } from 'bun:test';\n${imports}\n` +
          `test('t', () => { expect([${files.map((_f, i) => `v${String(i)}`).join(',')}].length).toBe(${String(files.length)}); });\n`,
      );

      // Representative patterns spanning every matcher class Bun supports.
      const patterns = [
        'exact-match.ts',
        '*.ts',
        'qu?stion.ts',
        'bracket-[xy].ts',
        'sub/**',
        'nested', // bare substring — Bun does NOT exclude on this
      ];

      for (const pattern of patterns) {
        await writeFile(
          join(root, 'bunfig.toml'),
          `[test]\ncoveragePathIgnorePatterns = ["${pattern}"]\n`,
        );
        await rm(join(root, 'coverage'), { recursive: true, force: true });
        const coverageRun =
          await Bun.$`bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage`
            .cwd(root)
            .quiet()
            .nothrow();
        // Assert the coverage run itself succeeded. A non-zero exit can still leave a
        // partial or empty lcov, which would silently skew the exclusion set below — so
        // fail here, at the real cause, rather than later on an opaque file read.
        expect(
          coverageRun.exitCode,
          `bun test --coverage failed for pattern "${pattern}": ${coverageRun.stderr.toString()}`,
        ).toBe(0);
        const lcov = await Bun.file(join(root, 'coverage', 'lcov.info')).text();
        const bunExcluded = new Set(
          files.filter((file) => !lcov.split('\n').some((line) => line === `SF:${file}`)),
        );

        // The guard must throw for exactly the files Bun excluded, and not for the kept.
        for (const file of files) {
          const run = () => assertNoAllowanceKeyIsCoverageIgnored(new Map([[file, {}]]), [pattern]);
          if (bunExcluded.has(file)) {
            expect(run, `guard should flag "${file}" excluded by Bun for "${pattern}"`).toThrow();
          } else {
            expect(
              run,
              `guard should NOT flag "${file}" kept by Bun for "${pattern}"`,
            ).not.toThrow();
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
