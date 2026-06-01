import { describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { parseLcov } from './check-coverage.ts';

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

  it('ignores generated dashboard Svelte harness artifacts', () => {
    const generatedFiles = [
      'src/dashboard/components/.date-range-picker-harness.example.compiled/.date-range-picker-harness.example.svelte.js',
      'src/dashboard/fragments/.workflow-execution-timeline.example.compiled/workflow-execution-timeline.js',
      'src/dashboard/fragments/.schedule-list.example.compiled.mjs',
      'src/dashboard/views/.workflow-list-harness.example.compiled/.workflow-list-harness.example.js',
    ];

    for (const generatedFile of generatedFiles) {
      const coverage = parseLcov(
        [
          `SF:${generatedFile}`,
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
          return 'src/example.test.ts\nsrc/dashboard/example.test.ts\n';
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
      expect(consoleErrorSpy).toHaveBeenCalledWith('Coverage shard execution failed.');
    } finally {
      mock.restore();
    }
  });
});
