/**
 * Tests for the gate runner. The real gate-spawning path (`spawnGate`) shells
 * out to child processes and is exercised end-to-end by `bun run validate` /
 * `bun run prepack`; here we pass a stub gate runner to drive the decision,
 * framing, and summary logic deterministically, capturing console output with
 * `spyOn`.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import type { Gate } from './run-gates.ts';
import { formatDuration, main, PIPELINES, runPipeline } from './run-gates.ts';

/** Capture console.log/console.error and return the recorded lines plus a restore fn. */
function captureConsole() {
  const log: string[] = [];
  const error: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((message?: unknown) => {
    log.push(String(message));
  });
  const errorSpy = spyOn(console, 'error').mockImplementation((message?: unknown) => {
    error.push(String(message));
  });
  return {
    log,
    error,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

/** A stub gate runner returning the exit code mapped per gate name (default 0), recording order. */
function stubRunner(exitCodes: Record<string, number> = {}) {
  const ran: string[] = [];
  const runGate = (gate: Gate): Promise<number> => {
    ran.push(gate.name);
    return Promise.resolve(exitCodes[gate.name] ?? 0);
  };
  return { runGate, ran };
}

describe('formatDuration', () => {
  it('renders sub-second durations in milliseconds', () => {
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(0)).toBe('0ms');
  });

  it('renders second-and-up durations with one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(62870)).toBe('62.9s');
  });
});

describe('PIPELINES', () => {
  it('references only package.json scripts that exist', async () => {
    // Guard against a gate's `script` drifting from package.json (e.g. a script
    // renamed without updating the pipeline). Turns a cryptic `bun run` runtime
    // failure into a fast, clear local test failure.
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const scripts: Record<string, string> = packageJson.scripts;
    for (const gates of Object.values(PIPELINES)) {
      for (const gate of gates) {
        expect(scripts[gate.script]).toBeDefined();
      }
    }
  });
});

describe('runPipeline', () => {
  it('returns a non-zero exit code for an unknown pipeline and lists the known ones', async () => {
    const capturedConsole = captureConsole();
    try {
      const code = await runPipeline('does-not-exist', () => Promise.resolve(0));
      expect(code).toBe(1);
      const message = capturedConsole.error.join('\n');
      expect(message).toContain('Unknown pipeline "does-not-exist"');
      expect(message).toContain('validate');
      expect(message).toContain('prepack');
    } finally {
      capturedConsole.restore();
    }
  });

  it('runs every gate in order and returns 0 when all pass', async () => {
    const capturedConsole = captureConsole();
    const { runGate, ran } = stubRunner();
    try {
      const code = await runPipeline('validate', runGate);
      expect(code).toBe(0);
      expect(ran).toEqual(PIPELINES.validate.map((gate) => gate.name));
      const output = capturedConsole.log.join('\n');
      expect(output).toContain('Validate passed');
      expect(output).toContain('Validate Summary');
    } finally {
      capturedConsole.restore();
    }
  });

  it('fails fast: stops at the first failing gate and returns its exit code', async () => {
    const capturedConsole = captureConsole();
    const { runGate, ran } = stubRunner({ typecheck: 2 });
    try {
      const code = await runPipeline('validate', runGate);
      expect(code).toBe(2);
      // 'lint' and 'typecheck' ran; nothing after 'typecheck' did.
      expect(ran).toEqual(['lint', 'typecheck']);
      expect(capturedConsole.log.join('\n')).toContain('typecheck failed (exit 2');
      expect(capturedConsole.error.join('\n')).toContain('failed at gate "typecheck"');
    } finally {
      capturedConsole.restore();
    }
  });
});

describe('main', () => {
  it('returns 1 and prints usage when no pipeline name is given', async () => {
    const capturedConsole = captureConsole();
    try {
      const code = await main([], () => Promise.resolve(0));
      expect(code).toBe(1);
      expect(capturedConsole.error.join('\n')).toContain('Usage: bun run scripts/run-gates.ts');
    } finally {
      capturedConsole.restore();
    }
  });

  it('delegates to runPipeline for the named pipeline', async () => {
    const capturedConsole = captureConsole();
    const { runGate, ran } = stubRunner();
    try {
      const code = await main(['validate'], runGate);
      expect(code).toBe(0);
      expect(ran).toEqual(PIPELINES.validate.map((gate) => gate.name));
    } finally {
      capturedConsole.restore();
    }
  });
});

// `spawnGate` and the `import.meta.main` entrypoint shell out to real `bun run`
// processes; spawning gates in a unit test would be slow and order-fragile, so
// they are exercised end-to-end by `bun run validate` / `bun run prepack` and
// carry a coverage allowance in scripts/check-coverage.ts.
