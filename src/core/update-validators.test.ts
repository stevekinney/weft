import { describe, expect, it } from 'bun:test';

import { waitForever } from '../testing/fake-timers.test-support.ts';
import { flush } from '../testing/storage-backends.test-support.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { update, workflow } from './types.ts';
import { UpdateValidationError } from './updates.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine() {
  return new Engine();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('update validators (pre-acceptance)', () => {
  it('rejects an update when the validator throws — workflow never observes the payload', async () => {
    const approve = update<{ id: string }>('approve');
    const engine = makeEngine();
    const observed: unknown[] = [];

    engine.register(
      workflow({ name: 'guarded' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(
          approve,
          (payload) => {
            observed.push(payload);
            return payload;
          },
          {
            validator: (v) => {
              if (typeof v !== 'object' || v === null || !('id' in v)) {
                throw new Error('id is required');
              }
            },
          },
        );
        await waitForever();
      }),
    );

    const handle = await engine.start('guarded', null);
    // Allow the workflow to run up to its park point so handlers are registered.
    await flush();

    // Invalid payload — validator throws (use string name to bypass payload type check)
    await expect(handle.update('approve', { wrong: true })).rejects.toThrow(UpdateValidationError);

    // Workflow never observed the bad payload
    expect(observed).toHaveLength(0);

    // Valid payload passes through
    const result = await handle.update(approve, { id: 'order-1' });
    expect(result).toEqual({ id: 'order-1' });
    expect(observed).toHaveLength(1);

    engine[Symbol.dispose]();
  });

  it('rejects when the validator returns a Standard Schema failure result', async () => {
    const setAge = update<{ age: number }>('setAge');
    const engine = makeEngine();

    engine.register(
      workflow({ name: 'age-check' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(setAge, (payload) => payload, {
          validator: (v): unknown => {
            const age = (v as Record<string, unknown>)['age'];
            if (typeof age !== 'number' || age < 0) {
              return { issues: [{ message: 'age must be a non-negative number' }] };
            }
            return undefined; // success
          },
        });
        await waitForever();
      }),
    );

    const handle = await engine.start('age-check', null);
    await flush();

    // Invalid: negative age triggers Standard Schema failure result
    const error = await handle.update(setAge, { age: -1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateValidationError);
    expect((error as UpdateValidationError).updateName).toBe('setAge');
    expect((error as UpdateValidationError).issues[0]?.message).toBe(
      'age must be a non-negative number',
    );

    // No checkpoint was written — workflow state is untouched; send valid update
    const result = await handle.update(setAge, { age: 25 });
    expect(result).toEqual({ age: 25 });

    engine[Symbol.dispose]();
  });

  it('allows a valid payload that passes the validator through to the workflow', async () => {
    const proceed = update<string, { accepted: boolean; echo: string }>('proceed');
    const engine = makeEngine();

    engine.register(
      workflow({ name: 'validated-pass' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(proceed, (payload) => ({ accepted: true, echo: payload }), {
          validator: (v) => {
            if (typeof v !== 'string') throw new Error('must be a string');
          },
        });
        await waitForever();
      }),
    );

    const handle = await engine.start('validated-pass', null);
    await flush();

    const response = await handle.update(proceed, 'hello');
    expect(response).toEqual({ accepted: true, echo: 'hello' });

    engine[Symbol.dispose]();
  });

  it('idempotent re-delivery of a rejected update stays rejected', async () => {
    const tick = update<string, string>('tick');
    const engine = makeEngine();
    let calls = 0;

    engine.register(
      workflow({ name: 'idempotent-reject' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(tick, (payload) => payload, {
          validator: () => {
            calls++;
            if (calls <= 2) throw new Error(`rejected attempt ${calls}`);
          },
        });
        await waitForever();
      }),
    );

    const handle = await engine.start('idempotent-reject', null);
    await flush();

    // First two calls are rejected by the validator
    await expect(handle.update(tick, 'a')).rejects.toThrow(UpdateValidationError);
    await expect(handle.update(tick, 'b')).rejects.toThrow(UpdateValidationError);

    // Third call passes — validator no longer throws
    const result = await handle.update(tick, 'c');
    expect(result).toBe('c');

    engine[Symbol.dispose]();
  });

  it('no validator — update passes through unchanged (no regression)', async () => {
    const ping = update<string, { pong: string }>('ping');
    const engine = makeEngine();

    engine.register(
      workflow({ name: 'no-validator' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(ping, (payload) => ({ pong: payload }));
        await waitForever();
      }),
    );

    const handle = await engine.start('no-validator', null);
    await flush();

    const result = await handle.update(ping, 'hello');
    expect(result).toEqual({ pong: 'hello' });

    engine[Symbol.dispose]();
  });

  it('validator runs on the submitCoordinatedUpdate path (HTTP server path)', async () => {
    const setPrice = update<{ price: number }, { accepted: boolean }>('setPrice');
    const engine = makeEngine();

    engine.register(
      workflow({ name: 'price-guard' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(setPrice, (payload) => ({ accepted: true, echo: payload }), {
          validator: (v) => {
            const price = (v as Record<string, unknown>)['price'];
            if (typeof price !== 'number' || price < 0) {
              throw new Error('price must be a non-negative number');
            }
          },
        });
        await waitForever();
      }),
    );

    const handle = await engine.start('price-guard', null);
    await flush();

    // Invalid payload via coordinated path
    const err = await engine
      .submitCoordinatedUpdate(handle.id, 'setPrice', { price: -5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpdateValidationError);
    expect((err as UpdateValidationError).updateName).toBe('setPrice');
    expect((err as UpdateValidationError).issues[0]?.message).toBe(
      'price must be a non-negative number',
    );

    // Valid payload succeeds via coordinated path
    const result = await engine.submitCoordinatedUpdate(handle.id, 'setPrice', { price: 99 });
    expect(result.result).toEqual({ accepted: true, echo: { price: 99 } });

    engine[Symbol.dispose]();
  });

  it('accepts a Standard Schema result whose issues carry no string message (parity with inline path)', async () => {
    // Regression: a validator that returns `{ issues: [...] }` where no entry
    // has a string `message` must be ACCEPTED, not spuriously rejected. The
    // pending path previously checked the raw `issues` length before filtering
    // for valid messages, so it rejected updates the inline path accepted.
    const setName = update<{ name: string }, { ok: boolean }>('setName');
    const engine = makeEngine();

    engine.register(
      workflow({ name: 'issue-shape-guard' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate(setName, () => ({ ok: true }), {
          // Returns a malformed Standard Schema failure result: an issues array
          // with an entry that has no string `message`. After filtering, there
          // are no actionable issues, so this must be treated as acceptance.
          validator: (): unknown => ({ issues: [{ code: 'custom' }] }),
        });
        await waitForever();
      }),
    );

    const handle = await engine.start('issue-shape-guard', null);
    await flush();

    // Inline path (handler already registered): accepted.
    const inline = await handle.update(setName, { name: 'a' });
    expect(inline).toEqual({ ok: true });

    // Coordinated path: also accepted — both paths must agree.
    const coordinated = await engine.submitCoordinatedUpdate(handle.id, 'setName', { name: 'b' });
    expect(coordinated.result).toEqual({ ok: true });

    engine[Symbol.dispose]();
  });

  it('validates via the pending-drain path when an update arrives before ctx.onUpdate registers', async () => {
    // Directly exercises runPendingUpdateValidator: the coordinated update lands
    // in the coordinator while the workflow is still parked at waitForSignal,
    // BEFORE ctx.onUpdate runs. The pending drain then validates it on delivery.
    // Pre-fix, the drain's raw-length check spuriously rejected the malformed
    // (message-less) Standard Schema result; post-fix it accepts, like inline.
    const setName = update<{ name: string }, { ok: boolean }>('setName');
    const engine = makeEngine();

    engine.register(
      workflow({ name: 'late-register-guard' }).execute(async function* (ctx: WorkflowContext) {
        // Park BEFORE registering the handler/validator, so an update submitted
        // now is queued and only validated later during the pending drain.
        yield* ctx.waitForSignal('register');
        ctx.onUpdate(setName, () => ({ ok: true }), {
          validator: (): unknown => ({ issues: [{ code: 'custom' }] }),
        });
        await waitForever();
      }),
    );

    const handle = await engine.start('late-register-guard', null);
    await flush();

    // Submit while parked at the signal — handler not yet registered, so this
    // routes through the coordinator and is drained after registration. Do not
    // await yet: the response only arrives once the workflow registers.
    const pending = engine.submitCoordinatedUpdate(handle.id, 'setName', { name: 'queued' });

    // Release the workflow so it registers the handler and the drain runs.
    await engine.signal(handle.id, 'register');

    const result = await pending;
    expect(result.result).toEqual({ ok: true });
    expect(result.error).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('UpdateValidationError carries updateName and issues', () => {
    const err = new UpdateValidationError('my-update', [
      { message: 'field x is required' },
      { message: 'field y must be a number' },
    ]);

    expect(err.updateName).toBe('my-update');
    expect(err.issues).toHaveLength(2);
    expect(err.issues[0]?.message).toBe('field x is required');
    expect(err.message).toContain('my-update');
    expect(err.message).toContain('field x is required');
  });
});
