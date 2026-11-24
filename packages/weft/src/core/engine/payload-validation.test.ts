import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import type { DefinitionSchema, WorkflowContext } from '../types.ts';
import { query, signal, update } from '../types/message-handles.ts';
import { StandardSchemaValidationError } from '../types/standard-schema-validate.ts';
import { workflow } from '../types/workflow-function.ts';
import { UndeclaredWorkflowMessageError } from './declared-messages.ts';
import { ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING, Engine } from './index.ts';

const engines: Engine[] = [];
function track(engine: Engine): Engine {
  engines.push(engine);
  return engine;
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine[Symbol.dispose]();
});

const order = z.object({ id: z.string() });
const approval = signal('approve', { inputSchema: z.object({ approved: z.boolean() }) });
const rename = update('rename', { inputSchema: z.object({ name: z.string() }) });
const lookup = query('lookup', { inputSchema: z.object({ key: z.string() }) });

/** Waits for `approve`, answering `rename` and `lookup` meanwhile; returns the start input and the signal. */
const checkout = workflow({ name: 'checkout', inputSchema: order })
  .signals({ approve: approval })
  .updates({ rename })
  .queries({ lookup })
  .execute(async function* (ctx: WorkflowContext, input: unknown) {
    ctx.onUpdate('rename', (payload) => `renamed:${(payload as { name: string }).name}`);
    ctx.onQuery('lookup', (payload) => `found:${(payload as { key: string }).key}`);
    const decision = yield* ctx.waitForSignal('approve');
    return { input, decision };
  });

function validatingEngine(storage = new MemoryStorage()): Engine {
  const engine = track(new Engine({ storage, payloadValidation: 'inbound' }));
  engine.register(checkout);
  return engine;
}

async function schemaRejection(promise: Promise<unknown>): Promise<StandardSchemaValidationError> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(StandardSchemaValidationError);
  return error as StandardSchemaValidationError;
}

describe('payloadValidation engine option', () => {
  it('runs no schema by default', async () => {
    const engine = track(new Engine());
    engine.register(checkout);
    const handle = await engine.start('checkout', { id: 42 });
    await engine.signal(handle.id, 'approve', 'not an object');
    expect(await handle.result()).toEqual({ input: { id: 42 }, decision: 'not an object' });
  });

  it('rejects a value other than "none" or "inbound"', () => {
    expect(() => new Engine({ payloadValidation: 'all' as never })).toThrow(
      'options.payloadValidation must be "none" or "inbound" when provided',
    );
  });

  it('rejects an inbound schema with no runtime validator at registration', () => {
    const describeOnly = {
      '~standard': {
        version: 1,
        vendor: 'test',
        jsonSchema: { input: () => ({}), output: () => ({}) },
      },
    } as unknown as DefinitionSchema;
    const definition = workflow({ name: 'described', inputSchema: describeOnly })
      .signals({ go: signal('go', { inputSchema: describeOnly }) })
      .execute(async function* () {
        return 'ok';
      });
    const engine = track(new Engine({ payloadValidation: 'inbound' }));
    expect(() => engine.register(definition)).toThrow(
      'declares schemas with no runtime validator: inputSchema, signals.go.inputSchema',
    );
    track(new Engine()).register(definition);
  });

  it('rejects an invalid start input before writing anything, and accepts a valid one', async () => {
    const storage = new MemoryStorage();
    const engine = validatingEngine(storage);
    const error = await schemaRejection(engine.start('checkout', { id: 42 }, { id: 'bad-start' }));
    expect(error.fieldName).toBe('input');
    expect(error.operation).toBe('weft.workflows.start');
    expect(error.issues[0]?.path).toBe('/id');
    expect(await storage.get(KEYS.workflow('bad-start'))).toBeNull();

    const handle = await engine.start('checkout', { id: 'o-1' });
    await engine.signal(handle.id, 'approve', { approved: true });
    expect(await handle.result()).toEqual({ input: { id: 'o-1' }, decision: { approved: true } });
  });

  it('validates the prepared start path too', async () => {
    const engine = validatingEngine();
    const error = await schemaRejection(engine.prepare('checkout', { id: 1 }));
    expect(error.operation).toBe('weft.workflows.start');
  });

  it('stores the caller value, not the schema output', async () => {
    const engine = track(new Engine({ payloadValidation: 'inbound' }));
    engine.register(
      workflow({ name: 'coerce', inputSchema: z.object({ count: z.coerce.number() }) }).execute(
        async function* (_ctx: WorkflowContext, input: unknown) {
          return input;
        },
      ),
    );
    const handle = await engine.start('coerce', { count: '5' });
    expect(await handle.result()).toEqual({ count: '5' });
  });

  it('rejects an invalid declared signal, and an undeclared one by the closed signal set', async () => {
    const engine = validatingEngine();
    const handle = await engine.start('checkout', { id: 'o-2' });
    const error = await schemaRejection(engine.signal(handle.id, 'approve', { approved: 'yes' }));
    expect(error.fieldName).toBe('payload');
    expect(error.operation).toBe('weft.workflows.signal');
    // `checkout` declares its signals, so an undeclared name never reaches payload validation.
    expect(await rejectionOf(engine.signal(handle.id, 'undeclared', 'anything'))).toBeInstanceOf(
      UndeclaredWorkflowMessageError,
    );
    await engine.signal(handle.id, 'approve', { approved: false });
    expect(await handle.result()).toEqual({ input: { id: 'o-2' }, decision: { approved: false } });
  });

  it('validates a signal after a signalReceived interceptor rewrites it', async () => {
    const engine = validatingEngine();
    engine.addInterceptor({
      signalReceived(interception, next) {
        next({ ...interception, payload: { approved: 'rewritten' } });
      },
    });
    const handle = await engine.start('checkout', { id: 'o-3' });
    await schemaRejection(engine.signal(handle.id, 'approve', { approved: true }));
  });

  it('validates both halves of startOrSignal on create', async () => {
    const storage = new MemoryStorage();
    const engine = validatingEngine(storage);
    const signalError = await schemaRejection(
      engine.startOrSignal(
        'checkout',
        { id: 'o-4' },
        { name: 'approve', payload: { approved: 1 }, signalId: 'sig-1' },
        { id: 'sos' },
      ),
    );
    expect(signalError.operation).toBe('weft.workflows.signal');
    expect(await storage.get(KEYS.workflow('sos'))).toBeNull();

    const inputError = await schemaRejection(
      engine.startOrSignal(
        'checkout',
        { id: 4 },
        { name: 'approve', payload: { approved: true }, signalId: 'sig-1' },
      ),
    );
    expect(inputError.operation).toBe('weft.workflows.start');

    const { handle } = await engine.startOrSignal(
      'checkout',
      { id: 'o-4' },
      { name: 'approve', payload: { approved: true }, signalId: 'sig-1' },
      { id: 'sos' },
    );
    expect(await handle.result()).toEqual({ input: { id: 'o-4' }, decision: { approved: true } });
  });

  it('validates the signal startOrSignal sends to an existing run', async () => {
    const engine = validatingEngine();
    const handle = await engine.start('checkout', { id: 'o-7' }, { id: 'existing' });
    const error = await schemaRejection(
      engine.startOrSignal(
        'checkout',
        { id: 'o-7' },
        { name: 'approve', payload: { approved: 'no' }, signalId: 'sig-2' },
        { id: 'existing' },
      ),
    );
    expect(error.operation).toBe('weft.workflows.signal');
    await engine.signal(handle.id, 'approve', { approved: true });
    await handle.result();
  });

  it('rejects an invalid update and query input, and answers valid ones', async () => {
    const engine = validatingEngine();
    const handle = await engine.start('checkout', { id: 'o-5' });

    const updateError = await schemaRejection(engine.update(handle.id, 'rename', { name: 7 }));
    expect(updateError.fieldName).toBe('payload');
    expect(updateError.operation).toBe('weft.workflows.update');
    expect(await engine.update(handle.id, 'rename', { name: 'ok' })).toBe('renamed:ok');

    const queryError = await schemaRejection(engine.query(handle.id, 'lookup', { key: 1 }));
    expect(queryError.fieldName).toBe('input');
    expect(queryError.operation).toBe('weft.workflows.query');
    expect(await engine.query(handle.id, 'lookup', { key: 'k' })).toBe('found:k');

    await engine.signal(handle.id, 'approve', { approved: true });
    await handle.result();
  });

  it('reads the stored workflow type when this engine no longer runs it', async () => {
    const engine = validatingEngine();
    const handle = await engine.start('checkout', { id: 'o-6' });
    await engine.signal(handle.id, 'approve', { approved: true });
    await handle.result();

    await schemaRejection(engine.update(handle.id, 'rename', { name: 7 }));
    expect(await engine.query('missing-workflow', 'lookup', { key: 1 })).toBeUndefined();
  });

  it('validates a message sent under a builder alias against its declared schema', async () => {
    const aliased = workflow({ name: 'aliased' })
      .signals({ approveAlias: approval })
      .updates({ renameAlias: rename })
      .queries({ lookupAlias: lookup })
      .execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate('renameAlias', () => 'renamed');
        ctx.onQuery('lookupAlias', () => 'found');
        return yield* ctx.waitForSignal('approveAlias');
      });
    const engine = track(
      new Engine({ storage: new MemoryStorage(), payloadValidation: 'inbound' }),
    );
    engine.register(aliased);
    const handle = await engine.start('aliased', null);
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](handle.id);

    await schemaRejection(engine.signal(handle.id, 'approveAlias', { approved: 'yes' }));
    await schemaRejection(engine.update(handle.id, 'renameAlias', { name: 1 }));
    await schemaRejection(engine.query(handle.id, 'lookupAlias', { key: 1 }));

    expect(await engine.query(handle.id, 'lookupAlias', { key: 'k' })).toBe('found');
    await engine.signal(handle.id, 'approveAlias', { approved: true });
    expect(await handle.result()).toEqual({ approved: true });
  });

  it('finds no declared schema for a name that is neither declared nor aliased, such as constructor', async () => {
    const aliased = workflow({ name: 'aliased-inherited' })
      .updates({ renameAlias: rename })
      .execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate('renameAlias', () => 'renamed');
        return yield* ctx.waitForSignal('release');
      });
    const engine = track(
      new Engine({ storage: new MemoryStorage(), payloadValidation: 'inbound' }),
    );
    engine.register(aliased);
    const handle = await engine.start('aliased-inherited', null);
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](handle.id);

    expect(await rejectionOf(engine.update(handle.id, 'constructor', { name: 1 }))).toBeInstanceOf(
      UndeclaredWorkflowMessageError,
    );
  });
});
