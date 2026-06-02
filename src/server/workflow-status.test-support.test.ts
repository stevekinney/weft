import { describe, expect, it } from 'bun:test';

import type { Engine } from '../core/engine.ts';

import { waitForStatus } from './workflow-status.test-support.ts';

describe('waitForStatus test helper', () => {
  it('throws when the target status is not reached before the timeout', async () => {
    const engine = {
      get: async () => ({ status: 'running' }),
    } as unknown as Engine;

    await expect(waitForStatus(engine, 'wf-timeout', 'completed', 1)).rejects.toThrow(
      'Workflow wf-timeout did not reach completed within 1ms',
    );
  });
});
