import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS } from "../../test-support/embedded/testing/src/hang-guard.ts";
import { outcomeOf, rethrow } from "../../test-support/embedded/testing/src/module-scope-scenario.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  createReadyWatcher,
  killAndReboot,
  spawnServerSubprocess,
  withSubprocessServer,
  type SubprocessServerHandle,
} from './subprocess-engine.ts';
import type { RunningSubprocess } from './subprocess-lifecycle.ts';

const createdFixtures: string[] = [];
let handles: SubprocessServerHandle[] = [];

async function stopHandlesAndRemoveFixtures(): Promise<void> {
  await Promise.all(handles.map((handle) => handle.stop()));
  handles = [];
  for (const fixture of createdFixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
}

afterEach(stopHandlesAndRemoveFixtures);

/** `outcomeOf` that stops a hung scenario's servers and removes its fixtures when its guard fires. */
function serverScenario(scenario: () => Promise<void>): Promise<unknown> {
  return outcomeOf(scenario, HANG_GUARD_MILLISECONDS, stopHandlesAndRemoveFixtures);
}

function createFixtureDirectory(name: string): string {
  const directory = join(tmpdir(), `weft-subprocess-options-${name}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  createdFixtures.push(directory);
  return directory;
}

async function writeEntrypoint(name: string, source: string): Promise<string> {
  const path = join(createFixtureDirectory(name), 'entrypoint.ts');
  await Bun.write(path, source);
  return path;
}

/** Prints the readiness line for the requested port, then reports its working directory. */
const READY_ENTRYPOINT = `
const index = Bun.argv.indexOf('--port');
const port = Number(index === -1 ? '0' : (Bun.argv[index + 1] ?? '0'));
console.log('WEFT_SUBPROCESS_READY http://127.0.0.1:' + port);
console.log('cwd=' + process.cwd());
setInterval(() => {}, 1000);
`;

// Each scenario below boots a real subprocess, which takes seconds on a loaded host, so it runs
// here at module scope, off Bun's five-second per-test clock.

const optionsScenario = await serverScenario(async () => {
  const entrypoint = await writeEntrypoint('options', READY_ENTRYPOINT);
  const workingDirectory = createFixtureDirectory('working-directory');
  const databasePath = join(createFixtureDirectory('options-db'), 'weft.db');

  await using handle = await spawnServerSubprocess({
    entrypoint,
    databasePath,
    hostname: '127.0.0.1',
    cwd: workingDirectory,
  });
  handles.push(handle);

  const hostnameIndex = handle.command.indexOf('--hostname');
  expect(handle.command[hostnameIndex + 1]).toBe('127.0.0.1');
  expect(handle.stdout).toContain(`cwd=${realpathSync(workingDirectory)}`);

  expect(handle.process.exitCode).toBeNull();
  expect(handle.process.signalCode).toBeNull();
  handle.process.kill('SIGTERM');
  await handle.process.exited;
  expect(handle.process.signalCode).toBe('SIGTERM');
});

const withServerScenario = await serverScenario(async () => {
  const entrypoint = await writeEntrypoint('with-server', READY_ENTRYPOINT);
  const databasePath = join(createFixtureDirectory('with-server-db'), 'weft.db');
  let captured: SubprocessServerHandle | undefined;

  const result = await withSubprocessServer({ entrypoint, databasePath }, async (handle) => {
    captured = handle;
    expect(handle.process.exitCode).toBeNull();
    return 'callback result';
  });

  expect(result).toBe('callback result');
  expect(captured).toBeDefined();
  await captured!.process.exited;
  expect(captured!.process.exitCode !== null || captured!.process.signalCode !== null).toBe(true);
});

const startupTimeoutScenario = await serverScenario(async () => {
  const entrypoint = await writeEntrypoint('never-ready', 'setInterval(() => {}, 1000);');
  const databasePath = join(createFixtureDirectory('never-ready-db'), 'weft.db');

  expect(
    await throwingRejectionOf(
      spawnServerSubprocess({ entrypoint, databasePath, startupTimeoutMs: 300 }),
    ),
  ).toThrow(/Timed out after 300ms waiting for subprocess readiness/);
});

const foreignHandleScenario = await serverScenario(async () => {
  const foreign = {} as SubprocessServerHandle;

  expect(await throwingRejectionOf(killAndReboot(foreign))).toThrow(
    'killAndReboot requires a handle returned by spawnServerSubprocess',
  );
});

describe('subprocess server options', () => {
  it('passes hostname and working directory to the subprocess and exposes its process state', () =>
    rethrow(optionsScenario));

  it('stops the server when a withSubprocessServer callback returns', () =>
    rethrow(withServerScenario));

  it('rejects a server that never prints its readiness line within the startup timeout', () =>
    rethrow(startupTimeoutScenario));

  it('rejects killAndReboot for a handle that spawnServerSubprocess did not return', () =>
    rethrow(foreignHandleScenario));
});

describe('createReadyWatcher with a stand-in process', () => {
  function standInProcess(streams: {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  }): RunningSubprocess {
    return {
      ...streams,
      exited: new Promise<number>(() => undefined),
    } as unknown as RunningSubprocess;
  }

  function erroredStream(message: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(message));
      },
    });
  }

  function silentStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({ start() {} });
  }

  it('rejects with the failure of the stdout pipe', async () => {
    const process = standInProcess({
      stdout: erroredStream('stdout failed'),
      stderr: silentStream(),
    });

    expect(
      await throwingRejectionOf(
        createReadyWatcher(process, { stdout: '', stderr: '' }, /READY (\S+)/, 5_000),
      ),
    ).toThrow('stdout failed');
  });

  it('rejects with the failure of the stderr pipe', async () => {
    const process = standInProcess({
      stdout: silentStream(),
      stderr: erroredStream('stderr failed'),
    });

    expect(
      await throwingRejectionOf(
        createReadyWatcher(process, { stdout: '', stderr: '' }, /READY (\S+)/, 5_000),
      ),
    ).toThrow('stderr failed');
  });

  it('wraps a pipe failure that is not an Error', async () => {
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error('plain string failure');
      },
    });
    const process = standInProcess({ stdout, stderr: silentStream() });

    expect(
      await throwingRejectionOf(
        createReadyWatcher(process, { stdout: '', stderr: '' }, /READY (\S+)/, 5_000),
      ),
    ).toThrow('plain string failure');
  });

  it('rejects with the captured output when the readiness line never arrives in time', async () => {
    const process = standInProcess({ stdout: silentStream(), stderr: silentStream() });

    expect(
      await throwingRejectionOf(
        createReadyWatcher(process, { stdout: '', stderr: '' }, /READY (\S+)/, 20),
      ),
    ).toThrow(/Timed out after 20ms waiting for subprocess readiness\.\nstdout:\n<empty>/);
  });
});
