import { describe, expect, it } from 'bun:test';

import type { Engine } from '../core/engine.ts';

import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { waitForStatus } from './workflow-status.test-support.ts';

describe('waitForStatus test helper', () => {
  it('throws when the target status is not reached before the hang guard elapses', async () => {
    const engine = {
      get: async () => ({ status: 'running' }),
    } as unknown as Engine;

    expect(
      await throwingRejectionOf(
        // hang-guard-self-test: the workflow stays running, so no load can make it reach completed
        waitForStatus(engine, 'wf-timeout', 'completed', { hangGuardMilliseconds: 20 }),
      ),
    ).toThrow('Workflow wf-timeout did not reach completed before the hang guard elapsed');
  });
});
