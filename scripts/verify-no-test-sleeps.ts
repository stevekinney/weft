/**
 * Fails when test files use wall-clock sleeps that make assertions flaky:
 *
 * 1. Direct `Bun.sleep(...)` calls — tests should use src/testing/fake-timers.ts
 *    helpers so time is controlled by Bun fake timers instead of wall-clock.
 * 2. A fixed-duration `waitForRealTimersForTesting(<number>)` used as a
 *    synchronization barrier immediately before an `expect(...)`. Under CPU
 *    contention the fixed delay over/undershoots and the assertion fires against
 *    state the production code has not yet reached (or has already moved past),
 *    causing load-sensitive flakes. Wait for the observable condition instead —
 *    use the file's `waitFor(...)` helper or `waitForCondition(...)` from
 *    src/testing/fake-timers.test-support.ts.
 *
 * Legitimate fixed delays remain for the cases that genuinely cannot await an
 * event — a NEGATIVE assertion (proving something did NOT happen within a
 * window), a pre-dispatch settle with no observable "ready" signal, or a hang
 * guard on a real subprocess/integration step. Mark those with a structured
 * `// fixed delay: <negative assertion|pre-dispatch settle|hang guard> ...`
 * comment on the sleep line or the line directly above it; the check treats a
 * recognized category as an explicit, reviewed exemption and rejects an
 * unstructured `// fixed delay:` so the exemption cannot become a silent dodge.
 *
 * Scope: this is a LITERAL-numeric-delay check, by design. It targets the real
 * flake pattern — a hard-coded millisecond guess used as a barrier. A computed
 * duration (`waitForRealTimersForTesting(intervalMs)`) is almost always a
 * deliberate interval, not a guessed wait, so it is intentionally not flagged.
 * It is a lint-grade heuristic, not an AST analysis.
 */

export const TEST_FILE_GLOBS = ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'] as const;

const bunSleepPattern = /\bBun\.sleep\s*\(/;
// A literal numeric delay: optional sign/whitespace then a digit, allowing
// numeric separators (1_000). Computed durations (identifiers/expressions) are
// out of scope — see the module comment.
const fixedRealTimerSleepPattern = /\bwaitForRealTimersForTesting\s*\(\s*[+]?\s*\d[\d_]*/;
const exemptionPattern = /\/\/\s*fixed delay:/;
// A recognized exemption must name why no event can be awaited. Anything else
// (a bare `// fixed delay:` or an unrecognized reason) is rejected.
const recognizedExemptionPattern =
  /\/\/\s*fixed delay:\s*(negative assertion|pre-dispatch settle|hang guard)\b/;
const expectPattern = /\bexpect\s*\(/;
// How many non-blank lines after the sleep to scan for an assertion before
// concluding the sleep does not gate an expect (teardown drains have none).
export const ASSERTION_LOOKAHEAD = 4;

export type SleepViolationKind = 'bun-sleep' | 'fixed-sleep-before-assert';

export interface SleepViolation {
  line: number;
  kind: SleepViolationKind;
  message: string;
}

function gatesAnAssertion(lines: string[], sleepLineIndex: number): boolean {
  let seen = 0;
  for (let i = sleepLineIndex + 1; i < lines.length && seen < ASSERTION_LOOKAHEAD; i++) {
    const candidate = lines[i] ?? '';
    if (candidate.trim() === '') continue;
    seen++;
    if (expectPattern.test(candidate)) return true;
  }
  return false;
}

/** A `// fixed delay:` exemption appears on the sleep line or directly above it. */
function hasExemptionComment(lines: string[], sleepLineIndex: number): boolean {
  return (
    exemptionPattern.test(lines[sleepLineIndex] ?? '') ||
    exemptionPattern.test(lines[sleepLineIndex - 1] ?? '')
  );
}

/** The exemption names a recognized category (not a bare/unstructured comment). */
function hasRecognizedExemption(lines: string[], sleepLineIndex: number): boolean {
  return (
    recognizedExemptionPattern.test(lines[sleepLineIndex] ?? '') ||
    recognizedExemptionPattern.test(lines[sleepLineIndex - 1] ?? '')
  );
}

/**
 * Scan a single test file's source text and return every load-sensitive sleep
 * violation. Pure and line-based so it is unit-testable without touching disk.
 */
export function findTestSleepViolations(text: string): SleepViolation[] {
  const lines = text.split('\n');
  const violations: SleepViolation[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';

    if (bunSleepPattern.test(line)) {
      violations.push({
        line: lineIndex + 1,
        kind: 'bun-sleep',
        message: 'direct Bun.sleep call in test file',
      });
      continue;
    }

    if (!fixedRealTimerSleepPattern.test(line) || !gatesAnAssertion(lines, lineIndex)) {
      continue;
    }

    // A recognized exemption clears it; a bare/unstructured `// fixed delay:`
    // does not — it is flagged so the exemption cannot become a silent dodge.
    if (hasRecognizedExemption(lines, lineIndex)) {
      continue;
    }

    if (hasExemptionComment(lines, lineIndex)) {
      violations.push({
        line: lineIndex + 1,
        kind: 'fixed-sleep-before-assert',
        message:
          'unstructured "// fixed delay:" exemption — name the category: ' +
          '"fixed delay: negative assertion", "fixed delay: pre-dispatch settle", or "fixed delay: hang guard"',
      });
      continue;
    }

    violations.push({
      line: lineIndex + 1,
      kind: 'fixed-sleep-before-assert',
      message:
        'fixed waitForRealTimersForTesting(<number>) immediately before expect() — ' +
        'wait for the observable condition (waitFor/waitForCondition) instead, ' +
        'or add a "// fixed delay: <negative assertion|pre-dispatch settle|hang guard> ..." comment',
    });
  }

  return violations;
}

// This script's own test file deliberately contains literal `Bun.sleep(...)` and
// `waitForRealTimersForTesting(...)` strings as fixtures for the detector; it must
// not scan itself.
const SELF_TEST_PATH = 'scripts/verify-no-test-sleeps.test.ts';

async function main(): Promise<void> {
  let failures = 0;

  for (const glob of TEST_FILE_GLOBS) {
    for await (const filePath of new Bun.Glob(glob).scan({ absolute: false, onlyFiles: true })) {
      if (filePath === SELF_TEST_PATH) continue;
      const text = await Bun.file(filePath).text();
      for (const violation of findTestSleepViolations(text)) {
        failures++;
        console.error(`${filePath}:${violation.line}: ${violation.message}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\nFound ${failures} load-sensitive test sleep(s). See the guidance above.`);
    process.exit(1);
  }

  console.log(
    'No direct Bun.sleep calls or fixed-sleep-before-assert patterns found in test files.',
  );
}

if (import.meta.main) {
  await main();
}
