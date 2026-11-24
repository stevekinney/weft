/**
 * Ends a long-lived helper server when the process that started it is gone.
 *
 * A server a test run or a capture starts (Playwright's `webServer`, a fixture host) is stopped by
 * its starter. A starter killed with SIGKILL stops nothing: on 2026-11-12 ten end-to-end servers
 * and five fixture preview servers had run for one to five days, reparented to pid 1, about 350 MB
 * each. So such a server calls {@link exitWhenOrphaned} when it starts.
 *
 * It notes its ancestors once, from one `ps` snapshot, up to but not including pid 1, and looks
 * every second whether each is still alive. The whole chain, not the parent alone: Playwright
 * starts its server through `sh -c`, and that shell outlives a killed Playwright, so the server's
 * own parent never changes. Once an ancestor is gone, the server sends itself SIGTERM, which runs
 * whatever shutdown it registered for a signal; if it is still running after the hang guard's
 * awake time, it kills itself. A closed standard input would be a quicker sign, but it cannot tell
 * a starter that is gone from one that never opened it (`/dev/null`, an empty pipe), so it is not
 * read.
 *
 * A server started by hand keeps working: its ancestors are the shell and the terminal, and it
 * ends with them as it would on the hangup they send. A server started with no living ancestor
 * (its parent is already pid 1, a daemon) is never watched.
 *
 * Like `hang-guard.ts`, this file imports nothing but Bun and Node built-ins.
 */

import { spawnSync } from 'node:child_process';

import { afterAwakeTime, HANG_GUARD_MILLISECONDS } from './hang-guard.ts';

/** The ancestors of `pid`, nearest first, up to but not including pid 1, which never exits. */
export function ancestorChain(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const ancestors: number[] = [];
  const seen = new Set([pid]);
  for (let parent = parents.get(pid); parent !== undefined && parent > 1;) {
    if (seen.has(parent)) break;
    seen.add(parent);
    ancestors.push(parent);
    parent = parents.get(parent);
  }
  return ancestors;
}

/** The parent of every process, from one `ps` snapshot; undefined when `ps` fails. */
export function readProcessParents(): Map<number, number> | undefined {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return undefined;
  const parents = new Map<number, number>();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it still means it exists.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function everyInterval(check: () => void, milliseconds: number): () => void {
  const timer = setInterval(check, milliseconds);
  timer.unref();
  return () => clearInterval(timer);
}

function endThisProcess(gone: number): void {
  // The starter's end may have closed the pipes this process writes to.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  process.stderr.write(
    `exit-when-orphaned: the process that started this server is gone (pid ${gone} exited); shutting down\n`,
  );
  afterAwakeTime(HANG_GUARD_MILLISECONDS, () => process.kill(process.pid, 'SIGKILL'));
  process.kill(process.pid, 'SIGTERM');
}

export interface AncestorWatchOptions {
  /** The processes to watch. */
  ancestors: readonly number[];
  /** Called once, with the ancestor found gone. */
  onOrphaned: (gone: number) => void;
  isAlive?: (pid: number) => boolean;
  /** Calls `check` every `milliseconds` until the returned function is called. */
  every?: (check: () => void, milliseconds: number) => () => void;
  pollIntervalMilliseconds?: number;
}

/**
 * Calls `onOrphaned` once when one of `ancestors` is gone. Returns a function that stops
 * watching. With no ancestor to watch it does nothing.
 */
export function watchAncestors(options: AncestorWatchOptions): () => void {
  if (options.ancestors.length === 0) return () => {};
  const isAlive = options.isAlive ?? isProcessAlive;
  let stop: () => void = () => {};
  stop = (options.every ?? everyInterval)(() => {
    const gone = options.ancestors.find((pid) => !isAlive(pid));
    if (gone === undefined) return;
    stop();
    options.onOrphaned(gone);
  }, options.pollIntervalMilliseconds ?? 1000);
  return () => stop();
}

/**
 * Watches this process's ancestors, read once with `ps`, and sends this process SIGTERM when one
 * of them is gone. Returns a function that stops watching.
 */
export function exitWhenOrphaned(): () => void {
  const parents = readProcessParents();
  return watchAncestors({
    ancestors: parents === undefined ? [] : ancestorChain(process.pid, parents),
    onOrphaned: endThisProcess,
  });
}
