import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
import { getInternals } from './internals.ts';
import { resolveWorkflowTypeTarget, type RegistrationCallbacks } from './registration.ts';

const callbacks: RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => undefined,
};

describe('resolveWorkflowTypeTarget', () => {
  it('returns string workflow targets directly', () => {
    const engine = new Engine();

    expect(resolveWorkflowTypeTarget(getInternals(engine), 'registered-workflow', callbacks)).toBe(
      'registered-workflow',
    );

    engine[Symbol.dispose]();
  });

  it('resolves a registered workflow function back to its workflow type', () => {
    const engine = new Engine();
    const registeredWorkflow = workflow({ name: 'registered-workflow' }).execute(
      async function* registeredWorkflowHandler() {
        return 'done';
      },
    );
    engine.register(registeredWorkflow);

    expect(
      resolveWorkflowTypeTarget(getInternals(engine), registeredWorkflow.handler, callbacks),
    ).toBe('registered-workflow');

    engine[Symbol.dispose]();
  });

  it('rejects non-workflow registration inputs with a clear error', () => {
    const engine = new Engine();

    expect(() => engine.register(undefined as never)).toThrow(
      'engine.register() expects a WorkflowDefinition',
    );

    engine[Symbol.dispose]();
  });
});
