import { describe, expect, it, spyOn } from 'bun:test';

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findTestSleepViolations,
  normalizeScannedTestFilePath,
  runVerifyNoTestSleepsCli,
  verifyNoTestSleeps,
} from './verify-no-test-sleeps.ts';

describe('findTestSleepViolations', () => {
  it('flags a direct Bun.sleep call', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await Bun.sleep(50);
        expect(value).toBe(1);
      });
    `);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('bun-sleep');
    expect(violations[0]?.line).toBe(3);
  });

  it('flags a fixed waitForRealTimersForTesting immediately before an expect', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(50);
        expect(received.length).toBe(1);
      });
    `);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('fixed-sleep-before-assert');
  });

  it('flags a fixed sleep with blank lines before the expect (within lookahead)', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(200);

        const items = received.filter((m) => m.type === 'task');

        expect(items.length).toBe(2);
      });
    `);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('fixed-sleep-before-assert');
  });

  it('does NOT flag a teardown drain (no expect follows in the block)', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        expect(value).toBe(1);
        ws.close();
        await waitForRealTimersForTesting(50);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag a sleep whose expect is beyond the lookahead window', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(50);
        const a = 1;
        const b = 2;
        const c = 3;
        const d = 4;
        expect(a + b + c + d).toBe(10);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('respects a recognized exemption comment on the same line', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(200); // fixed delay: negative assertion (no event to await)
        expect(items.length).toBe(0);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('respects a recognized exemption comment on the line directly above', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        // fixed delay: pre-dispatch settle (no observable ready signal)
        await waitForRealTimersForTesting(50);
        expect(items.length).toBe(1);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('accepts the "hang guard" exemption category', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        // fixed delay: hang guard on a real subprocess
        await waitForRealTimersForTesting(300);
        expect(result.exitCode).toBe(1);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('flags a bare/unstructured "// fixed delay:" exemption', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(200); // fixed delay: because reasons
        expect(items.length).toBe(0);
      });
    `);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('unstructured');
  });

  it('catches a literal delay with a numeric separator', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(1_000);
        expect(value).toBe(1);
      });
    `);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('fixed-sleep-before-assert');
  });

  it('does NOT exempt a Bun.sleep even with a fixed-delay comment', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        // fixed delay: whatever
        await Bun.sleep(50);
        expect(value).toBe(1);
      });
    `);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('bun-sleep');
  });

  it('does NOT flag a non-literal waitForRealTimersForTesting (computed duration)', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitForRealTimersForTesting(intervalMs);
        expect(value).toBe(1);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('returns no violations for a clean condition-based test', () => {
    const violations = findTestSleepViolations(`
      it('x', async () => {
        await waitFor(() => received.length === 1, { label: 'task delivered' });
        expect(received.length).toBe(1);
      });
    `);
    expect(violations).toHaveLength(0);
  });

  it('flags multiple violations in one file', () => {
    const violations = findTestSleepViolations(`
      await Bun.sleep(10);
      expect(a).toBe(1);
      await waitForRealTimersForTesting(50);
      expect(b).toBe(2);
    `);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.kind)).toEqual(['bun-sleep', 'fixed-sleep-before-assert']);
  });
});

describe('verifyNoTestSleeps', () => {
  async function withTemporaryTestDirectory(
    run: (rootDirectory: string) => Promise<void>,
  ): Promise<void> {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'weft-test-sleeps-'));
    try {
      await mkdir(join(rootDirectory, 'scripts'), { recursive: true });
      await mkdir(join(rootDirectory, 'src'), { recursive: true });
      await run(rootDirectory);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  }

  it('reports violations from scanned files and skips this script’s fixture file', async () => {
    await withTemporaryTestDirectory(async (rootDirectory) => {
      await Bun.write(
        join(rootDirectory, 'scripts/verify-no-test-sleeps.test.ts'),
        `
        it('fixture', async () => {
          await Bun.sleep(10);
          expect(true).toBe(true);
        });
        `,
      );
      await Bun.write(
        join(rootDirectory, 'src/flaky.test.ts'),
        `
        it('flaky', async () => {
          await waitForRealTimersForTesting(25);
          expect(items.length).toBe(1);
        });
        `,
      );
      const errors: string[] = [];
      const logs: string[] = [];

      const failures = await verifyNoTestSleeps(
        {
          error(message) {
            errors.push(message);
          },
          log(message) {
            logs.push(message);
          },
        },
        rootDirectory,
      );

      expect(failures).toBe(1);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('src/flaky.test.ts:3');
      expect(errors[1]).toContain('Found 1 load-sensitive test sleep(s).');
      expect(logs).toHaveLength(0);
    });
  });

  it('logs success when the scanned files are clean', async () => {
    await withTemporaryTestDirectory(async (rootDirectory) => {
      await Bun.write(
        join(rootDirectory, 'src/clean.test.ts'),
        `
        it('clean', async () => {
          await waitFor(() => received.length === 1, { label: 'task delivered' });
          expect(received.length).toBe(1);
        });
        `,
      );
      const errors: string[] = [];
      const logs: string[] = [];

      const failures = await verifyNoTestSleeps(
        {
          error(message) {
            errors.push(message);
          },
          log(message) {
            logs.push(message);
          },
        },
        rootDirectory,
      );

      expect(failures).toBe(0);
      expect(errors).toHaveLength(0);
      expect(logs).toEqual([
        'No direct Bun.sleep calls or fixed-sleep-before-assert patterns found in test files.',
      ]);
    });
  });

  it('uses the default reporter to write failures to console.error', async () => {
    await withTemporaryTestDirectory(async (rootDirectory) => {
      await Bun.write(
        join(rootDirectory, 'src/flaky.test.ts'),
        `
        it('flaky', async () => {
          await waitForRealTimersForTesting(25);
          expect(items.length).toBe(1);
        });
        `,
      );
      using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const failures = await verifyNoTestSleeps(undefined, rootDirectory);

      expect(failures).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  it('uses the default reporter to write clean results to console.log', async () => {
    await withTemporaryTestDirectory(async (rootDirectory) => {
      await Bun.write(
        join(rootDirectory, 'src/clean.test.ts'),
        `
        it('clean', async () => {
          await waitFor(() => received.length === 1, { label: 'task delivered' });
          expect(received.length).toBe(1);
        });
        `,
      );
      using consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});

      const failures = await verifyNoTestSleeps(undefined, rootDirectory);

      expect(failures).toBe(0);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'No direct Bun.sleep calls or fixed-sleep-before-assert patterns found in test files.',
      );
    });
  });
});

describe('runVerifyNoTestSleepsCli', () => {
  it('does not exit when verification succeeds', async () => {
    let exitCode: number | null = null;

    await runVerifyNoTestSleepsCli(
      async () => 0,
      (code) => {
        exitCode = code;
      },
    );

    expect(exitCode).toBeNull();
  });

  it('exits with status 1 when verification fails', async () => {
    let exitCode: number | null = null;

    await runVerifyNoTestSleepsCli(
      async () => 2,
      (code) => {
        exitCode = code;
      },
    );

    expect(exitCode).toBe(1);
  });

  it('uses the default exit wrapper when verification fails', async () => {
    using processExitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runVerifyNoTestSleepsCli(async () => 2);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe('normalizeScannedTestFilePath', () => {
  it('strips a leading ./ prefix', () => {
    expect(normalizeScannedTestFilePath('./scripts/verify-no-test-sleeps.test.ts')).toBe(
      'scripts/verify-no-test-sleeps.test.ts',
    );
  });

  it('converts Windows separators to forward slashes', () => {
    expect(normalizeScannedTestFilePath('scripts\\verify-no-test-sleeps.test.ts')).toBe(
      'scripts/verify-no-test-sleeps.test.ts',
    );
  });
});
