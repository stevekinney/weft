import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { activity, workflow } from '../types.ts';
import { getInternals } from './internals.ts';
import { resolveWorkflowTypeTarget, type RegistrationCallbacks } from './registration.ts';

const callbacks: RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => undefined,
  dispatchEvent: () => undefined,
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

describe('finalizer registration (#446)', () => {
  const destroySandbox = activity({
    name: 'destroySandbox',
    execute: async () => undefined,
  });

  it('stores the finalizer on the engine-lifetime registry by workflow type', () => {
    const engine = new Engine();
    const provision = workflow({ name: 'provision', finalizer: destroySandbox }).execute(
      async function* () {
        return 'done';
      },
    );

    engine.register(provision);

    const entry = getInternals(engine).registrations.get('provision');
    expect(entry?.finalizer).toBeDefined();
    expect(entry?.finalizer?.name).toBe('destroySandbox');

    engine[Symbol.dispose]();
  });

  it('stores the declared finalizer reference as-is (no Phase 1 dispatch hardening)', () => {
    const engine = new Engine();
    const provision = workflow({ name: 'provision-stored', finalizer: destroySandbox }).execute(
      async function* () {
        return 'done';
      },
    );

    engine.register(provision);

    // Phase 1 only records the finalizer metadata; nothing dispatches it yet, so
    // it is kept as-declared rather than rebuilt. Dispatch hardening is deferred to
    // the phase that actually invokes finalizers.
    expect(getInternals(engine).registrations.get('provision-stored')?.finalizer).toBe(
      destroySandbox,
    );

    engine[Symbol.dispose]();
  });

  it('survives the activities-builder registration path (isBuilderWorkflowDefinition branch)', () => {
    // The `.activities({...})` builder path goes through a different `register`
    // branch than the plain `workflow().execute()` path; both call
    // `commitWorkflowDefinition`, so the finalizer must survive either.
    const engine = new Engine();
    const provision = workflow({ name: 'provision-with-activities', finalizer: destroySandbox })
      .activities({ doWork: async () => 'worked' })
      .execute(async function* () {
        return 'done';
      });

    engine.register(provision);

    expect(
      getInternals(engine).registrations.get('provision-with-activities')?.finalizer?.name,
    ).toBe('destroySandbox');

    engine[Symbol.dispose]();
  });

  it('leaves the finalizer undefined when none is declared', () => {
    const engine = new Engine();
    const plain = workflow({ name: 'plain' }).execute(async function* () {
      return 'done';
    });

    engine.register(plain);

    expect(getInternals(engine).registrations.get('plain')?.finalizer).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('throws when registering a finalizer on a worker-mode engine', () => {
    const engine = new Engine({
      workflowExecutionMode: 'worker',
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        poolSize: 1,
      },
    });

    const workerModeFinalized = workflow({
      name: 'worker-mode-finalized',
      finalizer: destroySandbox,
    }).execute(async function* () {
      return 'done';
    });

    expect(() => engine.register(workerModeFinalized)).toThrow(
      /finalizers are not yet supported in worker execution mode/,
    );

    engine[Symbol.dispose]();
  });
});
