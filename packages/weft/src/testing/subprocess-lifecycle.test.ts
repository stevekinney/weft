/**
 * COR-1283: `stopProcess`'s SIGKILL-escalation path, specifically the case
 * where even the escalated `process.exited` rejects rather than resolving.
 * Every real caller (`subprocess-engine.ts`'s durability harness) uses a
 * genuine `Bun.Subprocess`, whose `exited` promise resolves with an exit
 * code once the OS reaps the process — it does not reject in ordinary
 * operation, so no existing test ever exercised this defensive branch. This
 * test supplies a structurally-shaped fake `RunningSubprocess` (duck-typed;
 * `stopProcess` only reads `exitCode`/`signalCode`/`exited` and calls
 * `kill()`) whose `exited` promise rejects, to prove `stopProcess` still
 * resolves rather than propagating that rejection.
 */
import { describe, expect, it } from 'bun:test';

import {
  appendCapturedOutput,
  isExpectedSignalExit,
  stopProcess,
  type RunningSubprocess,
} from './subprocess-lifecycle.ts';

function fakeUnresponsiveProcess(): { process: RunningSubprocess; killCalls: string[] } {
  const killCalls: string[] = [];
  const process = {
    exitCode: null,
    signalCode: null,
    // Rejects immediately — both `waitForExit`'s first race (racing the
    // timeout) and `stopProcess`'s own escalated `.catch(() => undefined)`
    // read the SAME rejected promise.
    exited: Promise.reject(new Error('process.exited rejected')),
    kill(signal?: string) {
      killCalls.push(signal ?? 'default');
    },
  } as unknown as RunningSubprocess;
  return { process, killCalls };
}

describe('stopProcess — escalated SIGKILL whose exited promise also rejects', () => {
  it('still resolves instead of propagating the rejection, after escalating to SIGKILL', async () => {
    const { process, killCalls } = fakeUnresponsiveProcess();

    expect(await stopProcess(process, 'SIGTERM', 5)).toBeUndefined();

    // The initial signal, then the SIGKILL escalation once the (rejecting)
    // wait for exit failed and the process still hadn't terminated.
    expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('appendCapturedOutput', () => {
  it('appends while the buffer is within its bound', () => {
    expect(appendCapturedOutput('abc', 'def')).toBe('abcdef');
  });

  it('keeps only the newest output once the buffer would exceed its bound', () => {
    const bound = 32_768;
    const next = appendCapturedOutput('a'.repeat(bound), 'tail');

    expect(next).toHaveLength(bound);
    expect(next.endsWith('aaatail')).toBe(true);
    expect(next.startsWith('a')).toBe(true);
  });
});

describe('isExpectedSignalExit', () => {
  const exitedWithoutSignal = { signalCode: null } as unknown as RunningSubprocess;

  it.each([
    ['SIGKILL', 137],
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)('accepts the shell exit code a %s death reports', (signal, exitCode) => {
    expect(isExpectedSignalExit(exitedWithoutSignal, signal, exitCode)).toBe(true);
    expect(isExpectedSignalExit(exitedWithoutSignal, signal, exitCode + 1)).toBe(false);
  });

  it('trusts the reported signal over the exit code when the process died from one', () => {
    const killed = { signalCode: 'SIGKILL' } as unknown as RunningSubprocess;

    expect(isExpectedSignalExit(killed, 'SIGKILL', 0)).toBe(true);
    expect(isExpectedSignalExit(killed, 'SIGTERM', 143)).toBe(false);
  });
});
