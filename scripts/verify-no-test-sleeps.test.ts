import { describe, expect, it } from 'bun:test';

import { findTestSleepViolations } from './verify-no-test-sleeps.ts';

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
