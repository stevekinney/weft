const DEFAULT_READY_PATTERN = /(?:WEFT_SUBPROCESS_READY|Weft running on)\s+(\S+)/;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_OUTPUT_LENGTH = 32_768;

type RunningSubprocess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/**
 * Signals supported by the subprocess durability harness.
 *
 * @example
 * ```ts
 * import type { SubprocessSignal } from '@lostgradient/weft/testing';
 * const signal: SubprocessSignal = 'SIGKILL';
 * ```
 */
export type SubprocessSignal = 'SIGINT' | 'SIGKILL' | 'SIGTERM';
/**
 * Configuration for starting a Weft server in a child Bun process.
 *
 * @example
 * ```ts
 * import type { SubprocessServerOptions } from '@lostgradient/weft/testing';
 * const options: SubprocessServerOptions = { entrypoint: './tmp/entrypoint.ts', databasePath: './tmp/weft.db' };
 * ```
 */
export interface SubprocessServerOptions {
  entrypoint: string;
  databasePath: string;
  port?: number;
  hostname?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  args?: readonly string[];
  readyPattern?: RegExp;
  startupTimeoutMs?: number;
  exitTimeoutMs?: number;
}

interface NormalizedSubprocessServerOptions {
  entrypoint: string;
  databasePath: string;
  port: number;
  hostname?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  args: readonly string[];
  readyPattern: RegExp;
  startupTimeoutMs: number;
  exitTimeoutMs: number;
}

const subprocessServerHandleBrand: unique symbol = Symbol('SubprocessServerHandle');

/** Minimal public view of the child process managed by a {@link SubprocessServerHandle}.
 * @example
 * ```ts
 * import type { SubprocessServerProcess } from '@lostgradient/weft/testing';
 * declare const server: { process: SubprocessServerProcess };
 * const process: SubprocessServerProcess = server.process;
 * ```
 */
export interface SubprocessServerProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: SubprocessSignal | null;
  kill(signal?: SubprocessSignal): void;
}
/**
 * Handle for a running Weft server subprocess started by
 * {@link spawnServerSubprocess}.
 *
 * @example
 * ```ts
 * import { spawnServerSubprocess, type SubprocessServerHandle } from '@lostgradient/weft/testing';
 * const server: SubprocessServerHandle = await spawnServerSubprocess({ entrypoint: './tmp/entrypoint.ts', databasePath: './tmp/weft.db' });
 * await server.stop();
 * ```
 */
export interface SubprocessServerHandle extends AsyncDisposable {
  readonly [subprocessServerHandleBrand]: true;
  readonly process: SubprocessServerProcess;
  readonly url: string;
  readonly port: number;
  readonly databasePath: string;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  stop(signal?: SubprocessSignal): Promise<void>;
}

class SubprocessServerHandleImpl implements SubprocessServerHandle {
  readonly [subprocessServerHandleBrand] = true as const;
  readonly #process: RunningSubprocess;
  readonly url: string;
  readonly port: number;
  readonly databasePath: string;
  readonly command: readonly string[];
  readonly #options: NormalizedSubprocessServerOptions;
  readonly #output: CapturedOutput;

  constructor(
    process: RunningSubprocess,
    url: string,
    command: readonly string[],
    options: NormalizedSubprocessServerOptions,
    output: CapturedOutput,
  ) {
    this.#process = process;
    this.url = url;
    const parsedUrl = new URL(url);
    if (parsedUrl.port === '') {
      throw new Error(`Subprocess readiness URL must include an explicit port: ${url}`);
    }
    this.port = Number(parsedUrl.port);
    this.databasePath = options.databasePath;
    this.command = command;
    this.#options = { ...options, port: this.port };
    this.#output = output;
  }

  get process(): SubprocessServerProcess {
    const process = this.#process;
    return {
      exited: process.exited,
      get exitCode() {
        return process.exitCode;
      },
      get signalCode() {
        return normalizeSignalCode(process.signalCode);
      },
      kill: (signal?: SubprocessSignal) => {
        process.kill(signal);
      },
    };
  }

  get stdout(): string {
    return this.#output.stdout;
  }
  get stderr(): string {
    return this.#output.stderr;
  }
  async stop(signal: SubprocessSignal = 'SIGTERM'): Promise<void> {
    await stopProcess(this.#process, signal, this.#options.exitTimeoutMs);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
  get internalProcess(): RunningSubprocess {
    return this.#process;
  }
  get internalRestartOptions(): NormalizedSubprocessServerOptions {
    return this.#options;
  }
}

function normalizeSignalCode(value: string | null): SubprocessSignal | null {
  if (value === 'SIGINT' || value === 'SIGKILL' || value === 'SIGTERM') return value;
  return null;
}

type CapturedOutput = {
  stdout: string;
  stderr: string;
};

function appendCapturedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_CAPTURED_OUTPUT_LENGTH) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_LENGTH);
}

function normalizeOptions(options: SubprocessServerOptions): NormalizedSubprocessServerOptions {
  return {
    entrypoint: options.entrypoint,
    databasePath: options.databasePath,
    port: options.port ?? 0,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    args: options.args ?? [],
    readyPattern: options.readyPattern ?? DEFAULT_READY_PATTERN,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    exitTimeoutMs: options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
  };
}

function buildCommand(options: NormalizedSubprocessServerOptions): string[] {
  const command = [
    process.execPath,
    options.entrypoint,
    '--port',
    String(options.port),
    '--database',
    options.databasePath,
  ];
  if (options.hostname !== undefined) {
    command.push('--hostname', options.hostname);
  }
  command.push(...options.args);
  return command;
}

function setEnvironmentIfDefined(
  environment: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) environment[key] = value;
}

function createSubprocessEnvironment(
  explicitEnvironment: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  setEnvironmentIfDefined(environment, 'PATH', Bun.env['PATH']);
  setEnvironmentIfDefined(environment, 'HOME', Bun.env['HOME']);
  setEnvironmentIfDefined(environment, 'TMPDIR', Bun.env['TMPDIR']);
  setEnvironmentIfDefined(environment, 'TEMP', Bun.env['TEMP']);
  setEnvironmentIfDefined(environment, 'TMP', Bun.env['TMP']);
  setEnvironmentIfDefined(environment, 'TZ', Bun.env['TZ']);
  setEnvironmentIfDefined(environment, 'NODE_ENV', Bun.env['NODE_ENV']);

  for (const [key, value] of Object.entries(explicitEnvironment ?? {})) {
    if (value !== undefined) environment[key] = value;
  }

  return environment;
}

function normalizeReadyPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.replaceAll('g', '').replaceAll('y', '');
  return new RegExp(pattern.source, flags);
}

function findReadyUrl(output: string, pattern: RegExp): string | undefined {
  pattern.lastIndex = 0;
  const match = pattern.exec(output);
  return match?.[1];
}

function createReadyWatcher(
  process: RunningSubprocess,
  output: CapturedOutput,
  readyPattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const normalizedReadyPattern = normalizeReadyPattern(readyPattern);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for subprocess readiness.\n${formatOutput(output)}`,
        ),
      );
    }, timeoutMs);

    function settleWithUrl(url: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(url);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    void process.exited.then(async (exitCode) => {
      await Bun.sleep(0);
      const url = findReadyUrl(output.stdout, normalizedReadyPattern);
      if (url !== undefined) {
        settleWithUrl(url);
        return;
      }

      fail(
        new Error(
          `Subprocess exited with code ${exitCode} before readiness.\n${formatOutput(output)}`,
        ),
      );
      return undefined;
    });

    void drainStream(process.stdout, (chunk) => {
      output.stdout = appendCapturedOutput(output.stdout, chunk);
      const url = findReadyUrl(output.stdout, normalizedReadyPattern);
      if (url !== undefined) settleWithUrl(url);
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    void drainStream(process.stderr, (chunk) => {
      output.stderr = appendCapturedOutput(output.stderr, chunk);
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function verifyProcessSurvivedReadiness(
  process: RunningSubprocess,
  output: CapturedOutput,
  timeoutMs: number,
): Promise<void> {
  const stabilizationMs = Math.min(50, Math.max(1, timeoutMs));
  const exitCode = await Promise.race([
    process.exited,
    Bun.sleep(stabilizationMs).then(() => undefined),
  ]);
  if (exitCode !== undefined) {
    throw new Error(
      `Subprocess exited with code ${exitCode} after readiness.\n${formatOutput(output)}`,
    );
  }
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function formatOutput(output: CapturedOutput): string {
  return [`stdout:\n${output.stdout || '<empty>'}`, `stderr:\n${output.stderr || '<empty>'}`].join(
    '\n',
  );
}

async function waitForExit(
  process: RunningSubprocess,
  timeoutMs: number,
  label: string,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function hasProcessTerminated(process: RunningSubprocess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

async function stopProcess(
  process: RunningSubprocess,
  signal: SubprocessSignal,
  timeoutMs: number,
): Promise<void> {
  if (hasProcessTerminated(process)) return;
  process.kill(signal);
  try {
    await waitForExit(process, timeoutMs, 'subprocess exit');
  } catch {
    if (!hasProcessTerminated(process)) {
      process.kill('SIGKILL');
      await process.exited.catch(() => undefined);
    }
  }
}

function expectedExitCodeForSignal(signal: SubprocessSignal): number {
  if (signal === 'SIGKILL') return 137;
  if (signal === 'SIGTERM') return 143;
  return 130;
}

function isExpectedSignalExit(
  process: RunningSubprocess,
  signal: SubprocessSignal,
  exitCode: number,
): boolean {
  const signalCode = normalizeSignalCode(process.signalCode);
  if (signalCode !== null) return signalCode === signal;
  return exitCode === expectedExitCodeForSignal(signal);
}

/**
 * Starts a Weft server entrypoint in a real Bun subprocess and waits for the
 * server to print a readiness URL.
 *
 * @example
 * ```ts
 * import { spawnServerSubprocess } from '@lostgradient/weft/testing';
 * const server = await spawnServerSubprocess({ entrypoint: './tmp/entrypoint.ts', databasePath: './tmp/weft.db' });
 * await server.stop();
 * ```
 */
export async function spawnServerSubprocess(
  options: SubprocessServerOptions,
): Promise<SubprocessServerHandle> {
  const normalizedOptions = normalizeOptions(options);
  const command = buildCommand(normalizedOptions);
  const output: CapturedOutput = { stdout: '', stderr: '' };
  const spawnOptions: Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'> & {
    cmd: string[];
  } = {
    cmd: command,
    env: createSubprocessEnvironment(normalizedOptions.env),
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (normalizedOptions.cwd !== undefined) {
    spawnOptions.cwd = normalizedOptions.cwd;
  }
  const process = Bun.spawn(spawnOptions);

  try {
    const url = await createReadyWatcher(
      process,
      output,
      normalizedOptions.readyPattern,
      normalizedOptions.startupTimeoutMs,
    );
    await verifyProcessSurvivedReadiness(process, output, normalizedOptions.startupTimeoutMs);
    return new SubprocessServerHandleImpl(process, url, command, normalizedOptions, output);
  } catch (error) {
    await stopProcess(process, 'SIGKILL', normalizedOptions.exitTimeoutMs);
    throw error;
  }
}

/** Kills a running server subprocess and starts a replacement.
 * @example
 * ```ts
 * import { killAndReboot, spawnServerSubprocess } from '@lostgradient/weft/testing';
 * const server = await spawnServerSubprocess({ entrypoint: './tmp/entrypoint.ts', databasePath: './tmp/weft.db' });
 * const rebooted = await killAndReboot(server);
 * await rebooted.stop();
 * ```
 */
export async function killAndReboot(
  handle: SubprocessServerHandle,
  signal: SubprocessSignal = 'SIGKILL',
): Promise<SubprocessServerHandle> {
  if (!(handle instanceof SubprocessServerHandleImpl)) {
    throw new Error('killAndReboot requires a handle returned by spawnServerSubprocess');
  }
  const process = handle.internalProcess;
  const restartOptions = handle.internalRestartOptions;
  if (hasProcessTerminated(process)) {
    throw new Error(`Cannot reboot: subprocess already exited.\n${formatOutput(handle)}`);
  }

  process.kill(signal);
  const exitCode = await waitForExit(process, restartOptions.exitTimeoutMs, 'kill');
  if (!isExpectedSignalExit(process, signal, exitCode)) {
    throw new Error(
      `Expected subprocess to exit from ${signal}, got code ${exitCode} and signal ${process.signalCode ?? '<none>'}.\n${formatOutput(handle)}`,
    );
  }

  return spawnServerSubprocess({ ...restartOptions, port: 0 });
}

/** Runs a callback with a server subprocess and tears it down afterward.
 * @example
 * ```ts
 * import { withSubprocessServer } from '@lostgradient/weft/testing';
 * declare const options: Parameters<typeof withSubprocessServer>[0];
 * await withSubprocessServer(options, async (server) => fetch(`${server.url}/v1/health`));
 * ```
 */
export async function withSubprocessServer<T>(
  options: SubprocessServerOptions,
  callback: (handle: SubprocessServerHandle) => Promise<T>,
): Promise<T> {
  const handle = await spawnServerSubprocess(options);
  try {
    return await callback(handle);
  } finally {
    await handle.stop();
  }
}
