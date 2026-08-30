import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { Engine } from '../../engine.ts';
import { PayloadSizeExceededError } from '../../payload-size.ts';
import { type WorkflowContext, workflow } from '../../types.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

describe('payload-size cap — workflow input', () => {
  it('rejects oversize input before persisting any workflow state', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(echoWorkflow);

    const oversize = 'x'.repeat(1024);
    let thrown: unknown;
    try {
      await engine.start('echo', oversize, { id: 'wf-oversize' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PayloadSizeExceededError);
    expect((thrown as PayloadSizeExceededError).payloadKind).toBe('workflow input');

    // Nothing was written: the workflow record does not exist.
    expect(await storage.get(KEYS.workflow('wf-oversize'))).toBeNull();
    expect(await engine.get('wf-oversize')).toBeNull();

    engine[Symbol.dispose]();
  });

  it('admits input at or below the limit', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 1024 } });
    engine.register(echoWorkflow);

    const handle = await engine.start('echo', 'small', { id: 'wf-small' });
    expect(handle.id).toBe('wf-small');
    expect(await storage.get(KEYS.workflow('wf-small'))).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('admits arbitrarily large input when the cap is disabled', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register(echoWorkflow);

    const big = 'x'.repeat(100_000);
    const handle = await engine.start('echo', big, { id: 'wf-big' });
    expect(handle.id).toBe('wf-big');
    expect(await storage.get(KEYS.workflow('wf-big'))).not.toBeNull();

    engine[Symbol.dispose]();
  });
});
