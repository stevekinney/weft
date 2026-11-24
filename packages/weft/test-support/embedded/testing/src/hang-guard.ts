/**
 * Hang guards that count only time the test process was awake to observe.
 *
 * A hang guard turns a child process or scenario that never finishes into a failure instead of a
 * run that never ends. Bun's timers, and the `timeout` option of `Bun.spawn`, keep counting while
 * the host sleeps or the process is stopped, so a guard armed before a laptop's lid closes fires
 * the moment it wakes, against work that was frozen rather than hung (COR-1541). A clamshell
 * sleep with brief dark wakes did exactly that to a `test:self` run: a scenario that takes three
 * seconds was reported "hung" after its 120-second guard, and the victim changed from run to run.
 *
 * `afterAwakeTime` measures the budget in ticks instead. It wakes at most once a second and
 * credits each tick no more than the interval it waited for, so a gap the process did not live
 * through, however long, counts as one interval. A hung scenario leaves the event loop idle, its
 * ticks arrive on schedule, and the guard still fires when the budget is spent. A busy loop only
 * delays ticks, so the guard can fire late but never early. No clock needs to exclude sleep.
 *
 * Bun's fake timers freeze every clock and turn any timer armed while they are active into a
 * fake one, so ticks cannot measure anything then. A caller whose scenario may install fake timers
 * passes `fakeTimersActive` (`jest.isFakeTimers` from `bun:test`); ticks stop while it reports
 * true, and a real one-shot backstop, armed before the scenario runs and therefore still real,
 * fires the guard at the full budget as a plain timer would. In real mode the backstop only
 * re-arms. The detector is injected rather than imported because this module is also loaded
 * outside the Bun test runner, where `bun:test` does not exist.
 *
 * Root scripts import this file by its path rather than by package name: the root package may
 * depend on no workspace, because turbo folds every workspace the root depends on into the global
 * hash. It therefore imports nothing but Bun and Node built-ins.
 */

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { Readable } from 'node:stream';

import type { SpawnOptions, Subprocess } from 'bun';

/**
 * The uniform hang guard for a test's child process or module-scope scenario: far above any
 * healthy run on a loaded host, and never a performance bound. A larger budget is passed
 * explicitly where one is needed.
 */
export const HANG_GUARD_MILLISECONDS = 120_000;

const TICK_MILLISECONDS = 1_000;

/**
 * The host's timer functions as this module found them. Leak checks (`trackTimers`, Ventriloquist's
 * conformance cells) wrap `globalThis.setTimeout` while the code under test runs and count what is
 * still pending, and a guard re-arms its tick once a second, so a guard that called the global
 * would be counted as the code's leak. The guard's own timers are never the code under test.
 */
const { setTimeout: hostSetTimeout, clearTimeout: hostClearTimeout } = globalThis;

/** Options for measuring awake time without relying on wall-clock deadlines. */
export interface AwakeTimeOptions {
  /** Whether fake timers are installed, so real time cannot be measured. Defaults to never. */
  fakeTimersActive?: () => boolean;
  /** The clock ticks read. Injected by tests; defaults to `performance.now`. */
  now?: () => number;
  /** The longest wait between ticks, and so the most one tick can credit. Defaults to a second. */
  tickMilliseconds?: number;
}

/**
 * Call `onElapsed` once `milliseconds` of awake time have passed, measured by the ticks described
 * above. Returns a function that cancels the deadline; cancelling after it fired does nothing.
 */
export function afterAwakeTime(
  milliseconds: number,
  onElapsed: () => void,
  options: AwakeTimeOptions = {},
): () => void {
  const {
    fakeTimersActive = () => false,
    now = () => performance.now(),
    tickMilliseconds = TICK_MILLISECONDS,
  } = options;
  let credited = 0;
  let last = now();
  let tick: ReturnType<typeof setTimeout> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const cancel = (): void => {
    settled = true;
    hostClearTimeout(tick);
    hostClearTimeout(backstop);
  };
  const elapse = (): void => {
    if (settled) return;
    cancel();
    onElapsed();
  };
  const scheduleTick = (): void => {
    const interval = Math.max(1, Math.min(tickMilliseconds, milliseconds - credited));
    tick = hostSetTimeout(() => {
      tick = undefined;
      if (settled) return;
      // A timer armed now would be fake, and the clock is frozen: leave it to the backstop.
      if (fakeTimersActive()) return;
      const current = now();
      credited += Math.min(Math.max(0, current - last), interval);
      last = current;
      if (credited >= milliseconds) elapse();
      else scheduleTick();
    }, interval);
  };
  const armBackstop = (delay: number): void => {
    backstop = hostSetTimeout(() => {
      if (settled) return;
      if (fakeTimersActive()) {
        elapse();
        return;
      }
      if (tick === undefined) {
        // Fake timers stopped the ticks earlier; resume them without crediting the gap.
        last = now();
        scheduleTick();
      }
      armBackstop(milliseconds - credited + tickMilliseconds);
    }, delay);
  };

  armBackstop(milliseconds);
  scheduleTick();
  return cancel;
}

// Bun subcommands that are the package manager's own: `--no-install` is a runtime flag, and in front
// of one of these Bun reads it as a script name.
const PACKAGE_MANAGER_COMMANDS = new Set([
  'a',
  'add',
  'audit',
  'c',
  'create',
  'i',
  'info',
  'init',
  'install',
  'link',
  'outdated',
  'patch',
  'pm',
  'publish',
  'remove',
  'rm',
  'unlink',
  'update',
  'upgrade',
  'why',
  'x',
]);
// Runtime flags in front of the subcommand that take a separate value.
const VALUE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--preload',
  '--cwd',
  '-c',
  '--config',
  '--filter',
]);

/**
 * The argument list a test child should run with: Bun's runtime auto-install turned off.
 *
 * Bun installs a package a script imports but cannot resolve when no `node_modules` sits above the
 * script, and a test that writes modules into the system temp directory and runs them has none. The
 * install goes to the network, so the test passes or fails depending on the registry and on which
 * release is current (a new `svelte` broke the terminal import probe that way). Every child that
 * runs a Bun script, test or build therefore starts with `--no-install`, so it can resolve only
 * from the workspace it runs in, or fails at once with "Cannot find package". Package-manager
 * commands (`bun install`, `bun add`, `bun x`...) and a command that already chose
 * (`--no-install`, `--install`, `-i`) are left as they are. Anything that is not Bun is returned
 * unchanged.
 */
export function withoutAutoInstall(command: readonly string[]): string[] {
  const [executable, ...rest] = command;
  if (
    executable === undefined ||
    // `process.execPath` is Bun only when this module runs under Bun; under Node it is `node`, which
    // rejects `--no-install`.
    !(
      (executable === process.execPath && process.versions.bun !== undefined) ||
      basename(executable) === 'bun'
    ) ||
    rest.some(
      (argument) =>
        argument === '--no-install' ||
        argument === '-i' ||
        argument === '--install' ||
        argument.startsWith('--install='),
    )
  ) {
    return [...command];
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (!argument.startsWith('-')) {
      return PACKAGE_MANAGER_COMMANDS.has(argument)
        ? [...command]
        : [executable, '--no-install', ...rest];
    }
    if (VALUE_FLAGS.has(argument)) index += 1;
  }
  return [executable, '--no-install', ...rest];
}

/**
 * The progress a test reports for a child that lives through a scenario of several steps, such as
 * a server or a supervisor it drives request by request. Passed to {@link spawnWithHangGuard} as
 * `progress`, it makes the child's guard count awake time since the scenario last moved on rather
 * than since the spawn.
 *
 * A guard on the child's whole life is a bound on the sum of its steps: each step finishes well
 * inside the hang guard on a loaded host, yet five of them together do not, and the guard kills a
 * child that was never hung (the supervisor scenarios of `supervisor.slow.test.ts` did exactly
 * that). With progress reported after each step, a child is killed only when one step makes no
 * progress for the whole guard, which is what a hang is.
 */
export class HangGuardProgress {
  readonly #listeners = new Set<() => void>();

  /** Report that the scenario moved on: every guard watching this one counts from now. */
  progressed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Call `listener` on every report until the returned function is called. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/**
 * {@link afterAwakeTime}, counted from the latest report on `progress` instead of from the call:
 * each `progress.progressed()` cancels the running deadline and arms a fresh one of the same
 * length. Returns a function that cancels it; neither cancelling nor reporting after it fired
 * does anything.
 */
export function afterAwakeTimeSinceProgress(
  milliseconds: number,
  onElapsed: () => void,
  progress: HangGuardProgress,
  options: AwakeTimeOptions = {},
): () => void {
  let settled = false;
  const elapse = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    onElapsed();
  };
  let cancelDeadline = afterAwakeTime(milliseconds, elapse, options);
  const unsubscribe = progress.subscribe(() => {
    if (settled) return;
    cancelDeadline();
    cancelDeadline = afterAwakeTime(milliseconds, elapse, options);
  });
  return () => {
    settled = true;
    unsubscribe();
    cancelDeadline();
  };
}

/** Spawn options augmented with an awake-time hang guard. */
export type HangGuardedSpawnOptions<
  In extends SpawnOptions.Writable,
  Out extends SpawnOptions.Readable,
  Err extends SpawnOptions.Readable,
> = Omit<SpawnOptions.SpawnOptions<In, Out, Err>, 'timeout'> & {
  /** Awake time after which the child is killed with `killSignal`. */
  hangGuardMilliseconds?: number;
  /**
   * For a child that lives through several steps of a scenario: the guard counts awake time since
   * the latest report on it ({@link HangGuardProgress}) rather than since the spawn.
   */
  progress?: HangGuardProgress;
};

/**
 * `Bun.spawn` with an awake-time hang guard in place of its `timeout` option. A child still
 * running when the guard elapses is killed with `killSignal` (SIGTERM by default), so its
 * `exitCode` and `signalCode` read as they would after `timeout`. Test files start every process
 * through this or `runWithHangGuard`; `scripts/check-test-process-spawns.ts` enforces it, and so it
 * is also the one place a Bun child is kept from auto-installing from the network
 * (`withoutAutoInstall`). With `progress`, the guard counts from the latest progress the test
 * reported instead of from the spawn ({@link HangGuardProgress}).
 */
export function spawnWithHangGuard<
  const In extends SpawnOptions.Writable = 'ignore',
  const Out extends SpawnOptions.Readable = 'pipe',
  const Err extends SpawnOptions.Readable = 'inherit',
>(command: string[], options?: HangGuardedSpawnOptions<In, Out, Err>): Subprocess<In, Out, Err> {
  const {
    hangGuardMilliseconds = HANG_GUARD_MILLISECONDS,
    progress,
    ...spawnOptions
  } = options ?? {};
  const child = Bun.spawn<In, Out, Err>(withoutAutoInstall(command), spawnOptions);
  // `killSignal` is typed as any string, but Bun accepts only signal names and numbers there.
  const killSignal = (spawnOptions.killSignal ?? 'SIGTERM') as NodeJS.Signals | number;
  const kill = (): void => {
    child.kill(killSignal);
  };
  const cancel =
    progress === undefined
      ? afterAwakeTime(hangGuardMilliseconds, kill)
      : afterAwakeTimeSinceProgress(hangGuardMilliseconds, kill, progress);
  void child.exited.finally(cancel);
  return child;
}

/**
 * A child started by {@link spawnPipedWithHangGuard}: the fields of Bun's `Subprocess` a test reads,
 * with both output streams piped.
 */
export interface PipedChildProcess {
  /** The child's standard output, as a web stream. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** The child's standard error, as a web stream. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code once the child exits (`null` when a signal ended it). */
  readonly exited: Promise<number | null>;
  /** The exit code, or `null` while the child runs or when a signal ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the child, or `null`. */
  readonly signalCode: NodeJS.Signals | null;
  /** Send `signal` (SIGTERM by default) to the child. */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * {@link spawnWithHangGuard} for a test that runs under Node as well as Bun: the child is started
 * through `node:child_process`, which both runtimes provide, with stdout and stderr piped. A child
 * still running when the awake-time guard elapses is killed with SIGTERM. A Bun child is kept from
 * auto-installing (`withoutAutoInstall`) as it is there.
 *
 * @param command - the executable and its arguments
 * @param options - `hangGuardMilliseconds`, the awake time after which the child is killed
 */
export function spawnPipedWithHangGuard(
  command: readonly string[],
  options: { hangGuardMilliseconds?: number } = {},
): PipedChildProcess {
  const { hangGuardMilliseconds = HANG_GUARD_MILLISECONDS } = options;
  const [executable, ...argumentsList] = withoutAutoInstall(command);
  if (executable === undefined) throw new Error('spawnPipedWithHangGuard needs a command');
  const child = spawn(executable, argumentsList, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Resolve on exit, as Bun's `exited` does, rather than once the streams close: a reader that
  // never drains a stream must not hold the exit back.
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode));
  });
  const cancel = afterAwakeTime(hangGuardMilliseconds, () => child.kill('SIGTERM'));
  exited.then(cancel, cancel);
  return {
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      child.kill(signal);
    },
  };
}

/** What `runWithHangGuard` resolves to: the fields of Bun's `SyncSubprocess` that tests read. */
export interface CompletedProcess {
  /** Process exit code, when it exited normally. */
  exitCode: number | null;
  /** Process identifier. */
  pid: number;
  /** Signal that terminated the process, when applicable. */
  signalCode: NodeJS.Signals | number | null;
  /** Captured standard error output. */
  stderr: Buffer;
  /** Captured standard output. */
  stdout: Buffer;
  /** Whether the process exited successfully. */
  success: boolean;
}

/**
 * The asynchronous replacement for `Bun.spawnSync`: run `command` under the awake-time hang
 * guard and resolve once it exits, with both streams read in full. A synchronous spawn blocks
 * the thread, so no awake-time guard can tick while it runs; that is why test files may not use
 * one.
 */
export async function runWithHangGuard<const In extends SpawnOptions.Writable = 'ignore'>(
  command: string[],
  options?: Omit<HangGuardedSpawnOptions<In, 'pipe', 'pipe'>, 'stdout' | 'stderr'>,
): Promise<CompletedProcess> {
  const child = spawnWithHangGuard<In, 'pipe', 'pipe'>(command, {
    ...options,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    success: child.exitCode === 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    pid: child.pid,
  };
}
