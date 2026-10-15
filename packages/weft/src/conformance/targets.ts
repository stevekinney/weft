/**
 * Operator-registered conformance targets for the `weft.conformance.*`
 * server operations.
 *
 * A remote caller selects a target by name and nothing else. The command a
 * target spawns, and its timeout, come only from the runner the host builds
 * with `createConformanceTargets` (in `testing/conformance-targets.ts`) and
 * passes to `serve({ conformanceTargets })` — configuration the host process
 * owns — never from a request. Accepting a
 * command over the wire would turn the operation into remote code execution
 * on the server host; naming a pre-registered command keeps the set of
 * processes a request can start fixed at boot.
 *
 * Every run goes through {@link runConformanceReport}, the same check
 * sequence `weft conformance` runs, inside that function's own sandbox
 * server. Concurrent requests for one target share a single in-flight run, so
 * repeated calls cannot fan out into an unbounded number of worker processes:
 * at most one run per configured target exists at a time.
 *
 * @module conformance/targets
 */

import {
  type ConformanceReport,
  type ConformanceServe,
  runConformanceReport,
} from './run-conformance.ts';

/** Default per-wait timeout for a target that does not set its own; matches `weft conformance --timeout`. */
export const DEFAULT_CONFORMANCE_TARGET_TIMEOUT_MS = 15_000;

const TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** One worker command the server may run conformance checks against. */
export type ConformanceTarget = {
  /** Worker command and arguments, spawned directly (no shell). */
  command: readonly string[];
  /** Per-wait timeout in milliseconds. Defaults to {@link DEFAULT_CONFORMANCE_TARGET_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/** Conformance targets keyed by the name requests select them with. */
export type ConformanceTargets = Readonly<Record<string, ConformanceTarget>>;

/** What a caller may learn about a configured target. The command is withheld. */
export type ConformanceTargetSummary = {
  name: string;
  timeoutMs: number;
};

/** A {@link ConformanceReport} for one named target, stamped with when the run started and finished. */
export type ConformanceTargetReport = ConformanceReport & {
  target: string;
  startedAt: number;
  completedAt: number;
};

/** Lists configured targets and runs one by name. */
export type ConformanceTargetRunner = {
  list(): ConformanceTargetSummary[];
  /** Run (or join the in-flight run of) the named target; `undefined` when no such target is configured. */
  run(name: string): Promise<ConformanceTargetReport> | undefined;
};

type ResolvedTarget = { command: readonly string[]; timeoutMs: number };

function resolveTarget(name: string, target: ConformanceTarget): ResolvedTarget {
  if (!TARGET_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `conformanceTargets: target name ${JSON.stringify(name)} must be 1-128 characters of letters, digits, '.', '_', or '-', starting with a letter or digit`,
    );
  }
  const { command } = target;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === 'string' && part.length > 0)
  ) {
    throw new TypeError(
      `conformanceTargets.${name}.command must be a non-empty array of non-empty strings`,
    );
  }
  const timeoutMs = target.timeoutMs ?? DEFAULT_CONFORMANCE_TARGET_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `conformanceTargets.${name}.timeoutMs must be a positive integer number of milliseconds`,
    );
  }
  return { command: Object.freeze([...command]), timeoutMs };
}

/**
 * Validate `targets` and build the runner the conformance operations call.
 * Throws a `TypeError` for an invalid name, command, or timeout, so a bad
 * target fails before `serve()` binds a port rather than on the first request.
 *
 * The targets are copied: mutating the object passed in after this returns
 * does not change what a request can run.
 */
export function createConformanceTargetRunner(
  targets: ConformanceTargets,
  serve: ConformanceServe,
  clock: () => number = Date.now,
): ConformanceTargetRunner {
  const resolved = new Map<string, ResolvedTarget>();
  for (const [name, target] of Object.entries(targets)) {
    resolved.set(name, resolveTarget(name, target));
  }
  const inFlight = new Map<string, Promise<ConformanceTargetReport>>();

  async function execute(name: string, target: ResolvedTarget): Promise<ConformanceTargetReport> {
    const startedAt = clock();
    const report = await runConformanceReport({
      command: target.command,
      timeoutMs: target.timeoutMs,
      serve,
    });
    return { target: name, startedAt, completedAt: clock(), ...report };
  }

  return {
    list: () => [...resolved].map(([name, target]) => ({ name, timeoutMs: target.timeoutMs })),
    run: (name) => {
      const target = resolved.get(name);
      if (target === undefined) return undefined;
      const existing = inFlight.get(name);
      if (existing !== undefined) return existing;
      const run = execute(name, target).finally(() => inFlight.delete(name));
      inFlight.set(name, run);
      return run;
    },
  };
}
