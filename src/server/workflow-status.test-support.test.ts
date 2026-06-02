import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { waitForStatus } from './workflow-status.test-support.ts';

describe('waitForStatus test helper', () => {
  it('throws when the workflow never reaches the requested status', async () => {
    await using engine = new Engine();

    await expect(waitForStatus(engine, 'never-completes', 'completed', 1)).rejects.toThrow(
      'Workflow never-completes did not reach completed within 1ms',
    );
  });
});
