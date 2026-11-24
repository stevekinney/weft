/**
 * Closed message sets: a workflow that declares signals, updates, or queries
 * rejects any other name of that kind before buffering or dispatching it, and
 * a workflow that declares none of a kind keeps accepting any name.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { workflowSource } from '../source/index.ts';
import {
  query,
  signal,
  update,
  workflow,
  type AnyWorkflowDefinition,
  type WorkflowContext,
} from '../types.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import { UndeclaredWorkflowMessageError } from './declared-messages.ts';
import { deriveWorkflowDefinitionRevision } from './definition-revision.ts';
import { ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING, Engine } from './index.ts';
import { activateRegisteredSourceRevision } from './source-activation.ts';

const approve = signal<string>('approve');
const rename = update<string, string>('rename');
const progress = query<void, string>('progress');

const declaredWorkflow = workflow({ name: 'declared-messages' })
  .signals({ approve })
  .updates({ rename })
  .queries({ progress })
  .execute(async function* (ctx: WorkflowContext) {
    let label = 'start';
    ctx.onUpdate('rename', (next) => {
      label = String(next);
      return label;
    });
    ctx.onQuery('progress', () => label);
    const approver = yield* ctx.waitForSignal<string>('approve');
    return `${label}:${approver}`;
  });

/** Declares only signals, so updates and queries stay open. */
const signalsOnlyWorkflow = workflow({ name: 'signals-only' })
  .signals({ approve })
  .execute(async function* (ctx: WorkflowContext) {
    ctx.onQuery('anything', () => 'open');
    return yield* ctx.waitForSignal<string>('approve');
  });

const undeclaredWorkflow = workflow({ name: 'undeclared-messages' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('whatever');
});

let engine: Engine | undefined;

afterEach(async () => {
  await engine?.[Symbol.asyncDispose]();
  engine = undefined;
});

async function startParked(definition: AnyWorkflowDefinition, type: string) {
  const storage = new MemoryStorage();
  engine = new Engine({ storage });
  engine.register(definition as never);
  const handle = await engine.start(type, null);
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](handle.id);
  return { engine, storage, handle };
}

async function undeclaredOf(promise: Promise<unknown>): Promise<UndeclaredWorkflowMessageError> {
  const error = await rejectionOf(promise);
  if (!(error instanceof UndeclaredWorkflowMessageError)) {
    throw new Error(`Expected UndeclaredWorkflowMessageError, got ${String(error)}`, {
      cause: error,
    });
  }
  return error;
}

/** Every stored key that records a signal (buffered payload, sequence, or accepted response). */
async function signalKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('sig')) keys.push(key);
  return keys;
}

describe('closed message sets', () => {
  it('rejects an undeclared signal without buffering it, then accepts a declared one', async () => {
    const { storage, handle } = await startParked(declaredWorkflow, 'declared-messages');
    const before = await signalKeys(storage);

    const error = await undeclaredOf(handle.signal('reject', 'nope'));
    expect(error).toMatchObject({
      workflowId: handle.id,
      workflowType: 'declared-messages',
      messageKind: 'signal',
      messageName: 'reject',
      declaredNames: ['approve'],
    });
    expect(await signalKeys(storage)).toEqual(before);

    await handle.signal(approve, 'ada');
    expect(await handle.result()).toBe('start:ada');
  });

  it('rejects an undeclared update and dispatches a declared one', async () => {
    const { engine: running, handle } = await startParked(declaredWorkflow, 'declared-messages');

    const error = await undeclaredOf(running.update(handle.id, 'retitle', 'x'));
    expect(error.messageKind).toBe('update');
    expect(error.declaredNames).toEqual(['rename']);

    expect(await running.update(handle.id, rename, 'renamed')).toBe('renamed');
    await handle.signal(approve, 'ada');
    expect(await handle.result()).toBe('renamed:ada');
  });

  it('rejects an undeclared coordinated update before persisting a request', async () => {
    const {
      engine: running,
      storage,
      handle,
    } = await startParked(declaredWorkflow, 'declared-messages');

    await undeclaredOf(running.submitCoordinatedUpdate(handle.id, 'retitle', 'x'));
    const requests: string[] = [];
    for await (const [key] of storage.scan(KEYS.updatePrefix(handle.id))) requests.push(key);
    expect(requests).toEqual([]);
  });

  it('rejects an undeclared query and answers a declared one and the built-in activityProgress', async () => {
    const { engine: running, handle } = await startParked(declaredWorkflow, 'declared-messages');

    const error = await undeclaredOf(running.query(handle.id, 'status'));
    expect(error.messageKind).toBe('query');

    expect(await running.query(handle.id, progress)).toBe('start');
    expect(await running.query(handle.id, 'activityProgress')).toBeUndefined();
  });

  it('closes each kind independently: declaring signals leaves queries open', async () => {
    const { engine: running, handle } = await startParked(signalsOnlyWorkflow, 'signals-only');

    expect(await running.query(handle.id, 'anything')).toBe('open');
    await undeclaredOf(handle.signal('reject'));
  });

  it('keeps accepting any name of a kind the workflow declares none of', async () => {
    const { handle } = await startParked(undeclaredWorkflow, 'undeclared-messages');

    await handle.signal('whatever', 'any');
    expect(await handle.result()).toBe('any');
  });

  it('rejects an undeclared startOrSignal signal without creating a run', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    engine.register(declaredWorkflow);

    const error = await undeclaredOf(
      engine.startOrSignal(
        'declared-messages',
        null,
        { name: 'reject', signalId: 'reject-1' },
        { id: 'sos-1' },
      ),
    );
    expect(error.messageName).toBe('reject');
    expect(await storage.get(KEYS.workflow('sos-1'))).toBeNull();
  });

  it('checks startOrSignal against the existing target, not the requested type', async () => {
    const { engine: running, handle } = await startParked(
      undeclaredWorkflow,
      'undeclared-messages',
    );
    running.register(declaredWorkflow);

    const result = await running.startOrSignal(
      'declared-messages',
      null,
      { name: 'whatever', payload: 'kept', signalId: 'whatever-1' },
      { id: handle.id },
    );
    expect(result.outcome).toBe('signalled');
    expect(await handle.result()).toBe('kept');
  });

  it('rejects an undeclared startOrSignal signal for a dynamic source without creating a run', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await deriveWorkflowDefinitionRevision(declaredWorkflow);
    engine.registerSource(
      workflowSource(
        { name: 'declared-messages', location: './declared.ts', exportName: 'w', revision },
        async () => ({ w: declaredWorkflow }),
      ),
    );
    await activateRegisteredSourceRevision(engine, 'declared-messages', revision);

    await undeclaredOf(
      engine.startOrSignal(
        'declared-messages',
        null,
        { name: 'reject', signalId: 'reject-1' },
        { id: 'sos-source' },
      ),
    );
    expect(await storage.get(KEYS.workflow('sos-source'))).toBeNull();
  });

  it('rejects an undeclared update before running its validator', async () => {
    const validated: unknown[] = [];
    const strayValidator = workflow({ name: 'stray-validator' })
      .updates({ rename })
      .execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate('retitle', (next) => next, {
          validator: (value) => {
            validated.push(value);
          },
        });
        return yield* ctx.waitForSignal<string>('done');
      });
    const { engine: running, handle } = await startParked(strayValidator, 'stray-validator');

    await undeclaredOf(running.update(handle.id, 'retitle', 'x'));
    await undeclaredOf(running.submitCoordinatedUpdate(handle.id, 'retitle', 'x'));
    expect(validated).toEqual([]);
  });

  it('admits both the builder alias and the wire name of an aliased declaration', async () => {
    const aliased = workflow({ name: 'aliased-signal' })
      .signals({ localAlias: signal<string>('wireName') })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal('localAlias');
      });
    const { handle } = await startParked(aliased, 'aliased-signal');

    const error = await undeclaredOf(handle.signal('other'));
    expect(error.declaredNames).toEqual(['localAlias', 'wireName']);
    await handle.signal('wireName', 'ignored');
    await handle.signal('localAlias', 'delivered');
    expect(await handle.result()).toBe('delivered');
  });

  it('leaves a run pinned to an older revision unchecked by a newer registered declaration', async () => {
    const storage = new MemoryStorage();
    const revisionA = workflow({ name: 'rolling' })
      .signals({ approve })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal<string>('approve');
      });
    const revisionB = workflow({ name: 'rolling' })
      .signals({ confirm: signal<string>('confirm') })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal<string>('confirm');
      });

    await using original = new Engine({ storage });
    original.register(revisionA);
    const handle = await original.start('rolling', null);
    await original[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](handle.id);

    await using rolledOut = new Engine({ storage });
    rolledOut.register(revisionB);
    await ensureWorkflowCatalogReady(rolledOut);

    // `approve` is declared by revision A, which the run is pinned to.
    await rolledOut.signal(handle.id, 'approve', 'from-new-engine');
    // A run started under revision B is still checked against B.
    const fresh = await rolledOut.start('rolling', null);
    await undeclaredOf(rolledOut.signal(fresh.id, 'approve', 'nope'));
  });
});
