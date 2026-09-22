/**
 * COR-1283: `createEngine`'s registered `echo` workflow is never actually
 * driven to completion by any consumer of this test-support module — every
 * consumer writes raw task-ledger fixtures directly instead.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { createEngine } from './get-task-diagnostics.test-support.ts';

describe('get-task-diagnostics.test-support createEngine', () => {
  it("registers an 'echo' workflow that returns its input unchanged", async () => {
    const engine = createEngine(new MemoryStorage());
    const handle = await engine.start('echo', { value: 42 });
    expect(await handle.result()).toEqual({ value: 42 });
    engine[Symbol.dispose]();
  });
});
