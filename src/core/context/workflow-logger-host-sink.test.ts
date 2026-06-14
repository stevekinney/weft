import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { captureWorkflowLogConsole } from '../../testing/workflow-log-capture.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types/workflow-function.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';

/**
 * Engine-level tests for the `EngineOptions.onLog` host sink (#491 Part 1). These
 * run real workflows through a genuine engine so they prove the sink is plumbed
 * end-to-end (construction → inline strategy → context → `ctx.log`), routes
 * records away from the console, and inherits the replay-suppression contract.
 */

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

describe('EngineOptions.onLog host sink', () => {
  let captured: ReturnType<typeof captureWorkflowLogConsole>;
  beforeEach(() => {
    captured = captureWorkflowLogConsole();
  });
  afterEach(() => {
    captured.restore();
  });

  it('routes inline ctx.log records to the host sink instead of the console', async () => {
    const sunk: WorkflowLogRecord[] = [];
    await using engine = new Engine({ onLog: (record) => sunk.push(record) });
    engine.register(
      workflow({ name: 'sink-wf' }).execute(async function* (ctx) {
        ctx.log?.info('marker:hello', { tenant: 'acme' });
        return 'ok';
      }),
    );

    const handle = await engine.start('sink-wf', null, { id: 'sink-1' });
    await expect(handle.result()).resolves.toBe('ok');
    await flush();

    const marker = sunk.find((r) => r.message === 'marker:hello');
    expect(marker).toBeDefined();
    expect(marker).toMatchObject({
      level: 'info',
      workflowId: 'sink-1',
      workflowType: 'sink-wf',
      attributes: { tenant: 'acme' },
    });
    // The sink took over: the marker record never reached the console.
    expect(captured.records.some((r) => r.message === 'marker:hello')).toBe(false);
  });

  it('falls back to the console when no onLog sink is configured', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'console-wf' }).execute(async function* (ctx) {
        ctx.log?.info('marker:console');
        return 'ok';
      }),
    );

    const handle = await engine.start('console-wf', null, { id: 'console-1' });
    await expect(handle.result()).resolves.toBe('ok');
    await flush();

    expect(captured.records.some((r) => r.message === 'marker:console')).toBe(true);
  });
});
