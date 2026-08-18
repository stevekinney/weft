/**
 * Sequential gate runner for multi-step verification pipelines (`prepack`,
 * `validate`).
 *
 * The package's release-critical scripts were long `&&` chains: a failure dumped
 * an unstructured wall of output with no indication of which gate ran, which one
 * failed, or how long each took. This runner executes a named list of gates in
 * order, printing a labeled header before each and a pass/fail line with elapsed
 * time after, then a final summary. It fails fast — the first non-zero gate
 * stops the run and the resolved exit code is non-zero — so callers like the
 * release workflow (`bun run prepack`) still gate correctly on the exit code.
 *
 * Gates run as child processes inheriting stdio, so each gate's own output still
 * streams through unchanged; this runner only frames it.
 *
 * `runPipeline` takes the gate runner as a defaulted parameter so its
 * decision/framing/summary logic is unit-testable without spawning real
 * processes; everything else (the clock, console output) runs for real in tests
 * and is captured with `spyOn`.
 *
 * Usage:
 *   bun run scripts/run-gates.ts <pipeline>
 * where <pipeline> is a key of {@link PIPELINES}.
 */
import { spawn } from 'node:child_process';

import chalk from 'chalk';
import { capitalCase } from 'change-case';

/** A single gate: a label plus the package.json `bun run` script to execute. */
export type Gate = {
  /** Human-readable name shown in the header and summary. */
  readonly name: string;
  /** The package.json script the gate runs as `bun run <script>`. */
  readonly script: string;
};

/** Outcome of one gate, retained for the summary. */
type GateResult = {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
};

/** Runs one gate and resolves to its exit code (`0` on success). */
type GateRunner = (gate: Gate) => Promise<number>;

/**
 * Named pipelines. Each mirrors the previous `&&` chain in `package.json` so the
 * gate sequence stays a single source of truth here.
 */
export const PIPELINES: Record<string, readonly Gate[]> = {
  validate: [
    { name: 'lint', script: 'lint' },
    { name: 'typecheck', script: 'typecheck' },
    { name: 'typecheck tests', script: 'typecheck:tests' },
    { name: 'verify documentation', script: 'verify:documentation' },
    { name: 'verify no test sleeps', script: 'verify:no-test-sleeps' },
    { name: 'verify public API jsdoc', script: 'verify:public-api-jsdoc' },
    { name: 'test', script: 'test' },
  ],
  prepack: [
    { name: 'build', script: 'build' },
    { name: 'verify exports', script: 'verify:exports' },
    { name: 'verify portability', script: 'verify:portability' },
    { name: 'verify markdown doctests', script: 'verify:markdown-doctests' },
    { name: 'verify jsdoc', script: 'verify:jsdoc' },
    { name: 'verify jsdoc doctests', script: 'verify:jsdoc:doctests' },
    { name: 'verify jsdoc declarations', script: 'verify:jsdoc:declarations' },
    { name: 'check package contents', script: 'check:package-contents' },
    { name: 'validate package consumers', script: 'validate:package-consumers' },
  ],
};

/** Format a millisecond duration as a compact `1.2s` / `840ms` string. */
export function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${Math.round(durationMs)}ms`;
}

/**
 * Run one gate as `bun run <script>` in a child process inheriting stdio.
 * Resolves to its exit code; a failure to spawn resolves to a non-zero code
 * rather than rejecting so the runner can report it like any other gate failure.
 */
export function spawnGate(gate: Gate): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', gate.script], { stdio: 'inherit' });
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on('error', (spawnError) => {
      console.error(chalk.red(`  failed to spawn: ${spawnError.message}`));
      settle(1);
    });
    child.on('close', (code) => settle(code ?? 1));
  });
}

/** Build the closing summary lines for every gate that ran. */
function summaryLines(pipelineName: string, results: readonly GateResult[]): string[] {
  const lines = ['\n' + chalk.bgBlue.black(` ${capitalCase(pipelineName)} Summary `)];
  for (const result of results) {
    const mark = result.ok ? chalk.green('✓') : chalk.red('✗');
    const timing = chalk.dim(formatDuration(result.durationMs).padStart(7));
    lines.push(`  ${mark} ${timing}  ${result.name}`);
  }
  return lines;
}

/**
 * Run a named pipeline, failing fast. Returns the exit code: `0` when every gate
 * passed, otherwise the failing gate's non-zero exit code. `runGate` defaults to
 * real process spawning; tests pass a stub to drive ordering and fail-fast without
 * spawning.
 */
export async function runPipeline(
  pipelineName: string,
  runGate: GateRunner = spawnGate,
): Promise<number> {
  const gates = PIPELINES[pipelineName];
  if (!gates) {
    const known = Object.keys(PIPELINES).join(', ');
    console.error(chalk.red(`Unknown pipeline "${pipelineName}". Known pipelines: ${known}.`));
    return 1;
  }

  const results: GateResult[] = [];
  const overallStart = performance.now();

  for (const [index, gate] of gates.entries()) {
    console.log(
      '\n' +
        chalk.bgBlue.black(` ${capitalCase(pipelineName)} `) +
        chalk.dim(` ${index + 1}/${gates.length} `) +
        chalk.bold(gate.name),
    );

    const start = performance.now();
    const code = await runGate(gate);
    const durationMs = performance.now() - start;
    const ok = code === 0;
    results.push({ name: gate.name, ok, durationMs });

    if (ok) {
      console.log(chalk.green(`  ✓ ${gate.name}`) + chalk.dim(` (${formatDuration(durationMs)})`));
    } else {
      console.log(
        chalk.red(`  ✗ ${gate.name} failed (exit ${code}, ${formatDuration(durationMs)})`),
      );
      for (const line of summaryLines(pipelineName, results)) console.log(line);
      console.error(chalk.red(`\n${capitalCase(pipelineName)} failed at gate "${gate.name}".`));
      return code;
    }
  }

  for (const line of summaryLines(pipelineName, results)) console.log(line);
  console.log(
    chalk.green(`\n${capitalCase(pipelineName)} passed`) +
      chalk.dim(` — ${gates.length} gates in ${formatDuration(performance.now() - overallStart)}.`),
  );
  return 0;
}

/**
 * CLI entrypoint: resolve the pipeline name from argv and run it. Returns the
 * exit code rather than calling `process.exit`, so buffered stdout (the framing
 * and summary) drains before the process ends — `process.exit` can truncate the
 * final lines when stdout is a pipe (CI logs).
 */
export async function main(
  argv: readonly string[],
  runGate: GateRunner = spawnGate,
): Promise<number> {
  const pipelineName = argv[0];
  if (!pipelineName) {
    console.error(chalk.red('Usage: bun run scripts/run-gates.ts <pipeline>'));
    return 1;
  }
  return runPipeline(pipelineName, runGate);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

/** Deliberately uncovered function used only to prove the CI coverage gate rejects it. */
export function deliberatelyUncoveredCoverageProof(): string {
  return 'coverage gate must fail';
}
