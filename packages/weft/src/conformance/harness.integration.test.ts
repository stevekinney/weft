import { spawnWithHangGuard } from "../../test-support/embedded/testing/src/hang-guard.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { describe, expect, it } from 'bun:test';

import { outcomeOf, rethrow } from "../../test-support/embedded/testing/src/module-scope-scenario.ts";
import type { WeftServer } from '../server/index.ts';
import {
  stopWorker,
  waitForCondition,
  waitForWorkerHeartbeat,
  waitForWorkerIdle,
  type RunningWorker,
} from './harness.ts';

type RegisteredWorker = { lastHeartbeat: number; inFlight: number };

/** The only slice of a `WeftServer` the worker waits read: its registry's `getWorker`. */
function serverWithWorker(
  getWorker: (workerId: string) => RegisteredWorker | undefined,
): WeftServer {
  return { registry: { getWorker } } as unknown as WeftServer;
}

// A real child is the behavior here, so it runs at module scope, off Bun's per-test clock.
const realChildScenario = await outcomeOf(async () => {
  const child = spawnWithHangGuard(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  await stopWorker({ process: child });
  expect(child.signalCode).toBe('SIGTERM');
});

describe('waitForCondition', () => {
  it('names the last error the predicate threw when the wait times out', async () => {
    expect(
      await throwingRejectionOf(
        waitForCondition(
          () => {
            throw new Error('registry unavailable');
          },
          40,
          'the registry',
        ),
      ),
    ).toThrow('Timed out after 40ms waiting for the registry: registry unavailable');
  });

  it('omits the cause when the predicate threw something that is not an Error', async () => {
    expect(
      await throwingRejectionOf(
        waitForCondition(
          () => {
            throw 'not an error';
          },
          40,
          'the registry',
        ),
      ),
    ).toThrow(/^Timed out after 40ms waiting for the registry$/);
  });

  it('resolves as soon as the predicate holds, even after it threw once', async () => {
    let calls = 0;
    await waitForCondition(
      () => {
        calls += 1;
        if (calls === 1) throw new Error('not yet');
        return true;
      },
      1_000,
      'a recovered condition',
    );
    expect(calls).toBe(2);
  });
});

describe('waitForWorkerHeartbeat', () => {
  it('times out when the worker never reports a newer heartbeat', async () => {
    const server = serverWithWorker(() => ({ lastHeartbeat: 100, inFlight: 0 }));
    expect(await throwingRejectionOf(waitForWorkerHeartbeat(server, 'worker-1', 40))).toThrow(
      'Timed out after 40ms waiting for worker worker-1 heartbeat',
    );
  });

  it('fails when the worker was never registered', async () => {
    const server = serverWithWorker(() => undefined);
    expect(await throwingRejectionOf(waitForWorkerHeartbeat(server, 'worker-1', 40))).toThrow(
      'Worker worker-1 disconnected before heartbeat was observed',
    );
  });

  it('fails when the worker disconnects while waiting', async () => {
    let reads = 0;
    const server = serverWithWorker(() => {
      reads += 1;
      return reads === 1 ? { lastHeartbeat: 100, inFlight: 0 } : undefined;
    });
    expect(await throwingRejectionOf(waitForWorkerHeartbeat(server, 'worker-1', 1_000))).toThrow(
      'Worker worker-1 disconnected before heartbeat was observed',
    );
  });

  it('returns once the heartbeat advances', async () => {
    let heartbeat = 100;
    const server = serverWithWorker(() => ({ lastHeartbeat: heartbeat++, inFlight: 0 }));
    await waitForWorkerHeartbeat(server, 'worker-1', 1_000);
  });
});

describe('waitForWorkerIdle', () => {
  it('times out while the worker keeps work in flight', async () => {
    const server = serverWithWorker(() => ({ lastHeartbeat: 1, inFlight: 2 }));
    expect(await throwingRejectionOf(waitForWorkerIdle(server, 'worker-1', 40))).toThrow(
      'Timed out after 40ms waiting for worker worker-1 to become idle',
    );
  });

  it('fails when the worker disconnects before it goes idle', async () => {
    const server = serverWithWorker(() => undefined);
    expect(await throwingRejectionOf(waitForWorkerIdle(server, 'worker-1', 40))).toThrow(
      'Worker worker-1 disconnected while waiting to become idle',
    );
  });

  it('returns once nothing is in flight', async () => {
    const server = serverWithWorker(() => ({ lastHeartbeat: 1, inFlight: 0 }));
    await waitForWorkerIdle(server, 'worker-1', 1_000);
  });
});

describe('stopWorker', () => {
  it('does nothing without a worker or for one that already exited', async () => {
    await stopWorker(undefined);
    const signals: string[] = [];
    const exited = {
      process: { exitCode: 0, kill: (signal: string) => signals.push(signal) },
    } as unknown as RunningWorker;
    await stopWorker(exited);
    expect(signals).toEqual([]);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM and its exit promise rejects', async () => {
    const signals: string[] = [];
    const stubborn = {
      process: {
        exitCode: null,
        exited: Promise.reject(new Error('exit observation failed')),
        kill: (signal: string) => signals.push(signal),
      },
    } as unknown as RunningWorker;
    await stopWorker(stubborn);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('terminates a real child with SIGTERM and does not escalate', () =>
    rethrow(realChildScenario));
});
