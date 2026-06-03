/**
 * Tests for the gate runner. The real gate-spawning path (`spawnGate`) shells
 * out to child processes and is exercised end-to-end by `bun run validate` /
 * `bun run prepack`; here we inject a fake gate runner and clock to drive the
 * decision, framing, and summary logic deterministically.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import type { Gate, PipelineDependencies } from './run-gates.ts';
import { formatDuration, gateArgv, main, PIPELINES, runPipeline, spawnGate } from './run-gates.ts';

/** Build injectable deps with a scripted per-gate exit-code map and a fake clock. */
function harness(exitCodes: Record<string, number> = {}) {
  const ran: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  const dependencies: PipelineDependencies = {
    runGate: (gate: Gate) => {
      ran.push(gate.name);
      clock += 10; // each gate "takes" 10ms on the fake clock
      return Promise.resolve(exitCodes[gate.name] ?? 0);
    },
    now: () => clock,
    log: (message) => lines.push(message),
    logError: (message) => errors.push(message),
  };
  return { dependencies, ran, lines, errors };
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

describe('gateArgv', () => {
  it('defaults a script gate to `bun run <script>`', () => {
    expect(gateArgv({ name: 'lint', script: 'lint' })).toEqual(['bun', 'run', 'lint']);
  });

  it('uses explicit argv when provided', () => {
    expect(gateArgv({ name: 'raw', argv: ['echo', 'hi'] })).toEqual(['echo', 'hi']);
  });

  it('throws when a gate has neither script nor argv', () => {
    expect(() => gateArgv({ name: 'empty' })).toThrow('neither script nor argv');
  });
});

describe('runPipeline', () => {
  it('returns a non-zero exit code for an unknown pipeline and lists the known ones', async () => {
    const { dependencies, errors } = harness();
    const code = await runPipeline('does-not-exist', dependencies);
    expect(code).toBe(1);
    const message = errors.join('\n');
    expect(message).toContain('Unknown pipeline "does-not-exist"');
    expect(message).toContain('validate');
    expect(message).toContain('prepack');
  });

  it('runs every gate in order and returns 0 when all pass', async () => {
    const { dependencies, ran, lines } = harness();
    const code = await runPipeline('validate', dependencies);
    expect(code).toBe(0);
    expect(ran).toEqual(PIPELINES.validate.map((gate) => gate.name));
    const output = lines.join('\n');
    expect(output).toContain('Validate passed');
    expect(output).toContain('Validate Summary');
  });

  it('fails fast: stops at the first failing gate and returns 1', async () => {
    const { dependencies, ran, lines, errors } = harness({ typecheck: 2 });
    const code = await runPipeline('validate', dependencies);
    expect(code).toBe(1);
    // 'lint' and 'typecheck' ran; nothing after 'typecheck' did.
    expect(ran).toEqual(['lint', 'typecheck']);
    expect(lines.join('\n')).toContain('typecheck failed (exit 2');
    expect(errors.join('\n')).toContain('failed at gate "typecheck"');
  });

  it('uses the real console/clock defaults when only runGate is injected', async () => {
    // Inject only the gate runner so the default clock and console sinks
    // actually execute (and are captured here to keep test output quiet).
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const passCode = await runPipeline('prepack', { runGate: () => Promise.resolve(0) });
      expect(passCode).toBe(0);
      const failCode = await runPipeline('unknown-pipeline', { runGate: () => Promise.resolve(0) });
      expect(failCode).toBe(1);
      expect(logSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('main', () => {
  it('returns 1 and prints usage when no pipeline name is given', async () => {
    const { dependencies, errors } = harness();
    const code = await main([], dependencies);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Usage: bun run scripts/run-gates.ts');
  });

  it('delegates to runPipeline for the named pipeline', async () => {
    const { dependencies, ran } = harness();
    const code = await main(['validate'], dependencies);
    expect(code).toBe(0);
    expect(ran).toEqual(PIPELINES.validate.map((gate) => gate.name));
  });
});

describe('spawnGate', () => {
  it('resolves to a non-zero code when the command cannot be spawned', async () => {
    const code = await spawnGate({ name: 'missing', argv: ['definitely-not-a-real-binary-xyz'] });
    expect(code).not.toBe(0);
  });

  it('resolves to 0 for a command that exits cleanly', async () => {
    const code = await spawnGate({ name: 'true', argv: ['true'] });
    expect(code).toBe(0);
  });
});
