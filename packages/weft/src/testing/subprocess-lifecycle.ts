/**
 * The child process half of the subprocess server harness: the signals it
 * accepts, the bounded stdout/stderr buffer its failures are reported with,
 * and the wait-then-escalate shutdown `SubprocessServerHandle#stop` performs.
 *
 * These are deliberately independent of how a server is configured or spawned,
 * so `subprocess-engine.ts` imports them and nothing here imports back.
 */

/**
 * Signals supported by the subprocess durability harness.
 *
 * @example
 * ```ts
 * import type { SubprocessSignal } from '@lostgradient/weft';
 * const signal: SubprocessSignal = 'SIGKILL';
 * ```
 */
export type SubprocessSignal = 'SIGINT' | 'SIGKILL' | 'SIGTERM';

const MAX_CAPTURED_OUTPUT_LENGTH = 32_768;

export type RunningSubprocess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

export function normalizeSignalCode(value: string | null): SubprocessSignal | null {
  if (value === 'SIGINT' || value === 'SIGKILL' || value === 'SIGTERM') return value;
  return null;
}

export type CapturedOutput = {
  stdout: string;
  stderr: string;
};

export function appendCapturedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_CAPTURED_OUTPUT_LENGTH) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_LENGTH);
}

export async function drainStream(
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

export function formatOutput(output: CapturedOutput): string {
  return [`stdout:\n${output.stdout || '<empty>'}`, `stderr:\n${output.stderr || '<empty>'}`].join(
    '\n',
  );
}

export async function waitForExit(
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

export function hasProcessTerminated(process: RunningSubprocess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

export async function stopProcess(
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

export function isExpectedSignalExit(
  process: RunningSubprocess,
  signal: SubprocessSignal,
  exitCode: number,
): boolean {
  const signalCode = normalizeSignalCode(process.signalCode);
  if (signalCode !== null) return signalCode === signal;
  return exitCode === expectedExitCodeForSignal(signal);
}
