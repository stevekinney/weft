import { describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { assembleAllowanceLayers, buildAllowanceLayer, parseLcov } from './check-coverage.ts';

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

  it('returns false immediately when a coverage shard exits non-zero', async () => {
    mock.module('bun', () => ({
      $: () => ({
        quiet: () => ({
          nothrow: async () => undefined,
        }),
      }),
    }));
    mock.module('node:child_process', () => ({
      execFileSync(command: string) {
        if (command === 'rg') {
          return 'src/example.test.ts\n';
        }
        if (command === 'bun') {
          const error = new Error('coverage shard failed') as Error & { status: number };
          error.status = 1;
          throw error;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    }));

    const errorSpy = mock((_message?: unknown, ..._args: unknown[]) => {});

    try {
      using consoleErrorSpy = spyOn(console, 'error').mockImplementation(errorSpy);
      const { checkCoverage } = await import(`./check-coverage.ts?failure=${randomUUID()}`);

      await expect(checkCoverage()).resolves.toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Coverage execution failed.');
    } finally {
      mock.restore();
    }
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
    ).toThrow(/Duplicate coverage-allowance key "src\/repeated\.ts" within DUPLICATED_LAYER/);
  });

  it('accepts an empty layer', () => {
    expect(buildAllowanceLayer('EMPTY_LAYER', []).size).toBe(0);
  });
});

describe('assembleAllowanceLayers', () => {
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
      // No mutually-exclusive layers declared: base/override shadowing is allowed.
      [],
    );

    expect(assembled.size).toBe(3);
    expect(assembled.get('src/shared.ts')).toEqual({ lines: new Set([99]) });
    expect(assembled.get('src/base-only.ts')).toEqual({ lines: new Set([2]) });
    expect(assembled.get('src/override-only.ts')).toEqual({ lines: new Set([3]) });
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
        ['MAIN_REFRESH', 'BRANCH_REFRESH'],
      ),
    ).toThrow(
      /Coverage-allowance key "src\/twin\.ts" appears in both MAIN_REFRESH and BRANCH_REFRESH/,
    );
  });

  it('allows a key shared between a non-exclusive layer and a refresh layer', () => {
    // Only the two refresh layers are mutually exclusive. A base/override layer
    // may still legitimately shadow a refresh layer's key.
    const base = buildAllowanceLayer('BASE', [['src/shared.ts', { lines: new Set([1]) }]]);
    const branchRefresh = buildAllowanceLayer('BRANCH_REFRESH', [
      ['src/shared.ts', { lines: new Set([2]) }],
    ]);

    const assembled = assembleAllowanceLayers(
      [
        ['BASE', base],
        ['BRANCH_REFRESH', branchRefresh],
      ],
      ['MAIN_REFRESH', 'BRANCH_REFRESH'],
    );

    // BRANCH_REFRESH is the terminal layer, so its value wins.
    expect(assembled.get('src/shared.ts')).toEqual({ lines: new Set([2]) });
  });
});
