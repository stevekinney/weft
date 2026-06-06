import { describe, expect, it } from 'bun:test';

import {
  buildStartBody,
  buildStartOrSignalBody,
  scheduleSpecToWireFields,
  setIfDefined,
} from './start-body.ts';

describe('start body helpers', () => {
  it('setIfDefined copies defined values and skips undefined ones', () => {
    const body: Record<string, unknown> = {};

    setIfDefined(body, 'id', 'workflow-123');
    setIfDefined(body, 'missing', undefined);

    expect(body).toEqual({ id: 'workflow-123' });
  });

  it('maps a cron schedule string to cronExpression', () => {
    expect(scheduleSpecToWireFields('0 * * * *')).toEqual({ cronExpression: '0 * * * *' });
  });

  it('maps an interval schedule to every', () => {
    expect(scheduleSpecToWireFields({ every: '15m' })).toEqual({ every: '15m' });
  });

  it('maps a cron schedule object to cronExpression', () => {
    expect(scheduleSpecToWireFields({ cron: '*/5 * * * *' })).toEqual({
      cronExpression: '*/5 * * * *',
    });
  });

  it('buildStartBody copies only defined start options', () => {
    expect(
      buildStartBody('echo', { greeting: 'hello' }, { id: 'workflow-123', tags: ['nightly'] }),
    ).toEqual({
      type: 'echo',
      input: { greeting: 'hello' },
      id: 'workflow-123',
      tags: ['nightly'],
    });
  });

  it('buildStartOrSignalBody flattens the signal fields and start options', () => {
    expect(
      buildStartOrSignalBody(
        'waiter',
        { greeting: 'hello' },
        { name: 'continue', payload: { ok: true }, signalId: 'signal-123' },
        { idempotencyKey: 'idem-123', searchAttributes: { customerId: 'acme' } },
      ),
    ).toEqual({
      type: 'waiter',
      input: { greeting: 'hello' },
      signalName: 'continue',
      signalPayload: { ok: true },
      signalId: 'signal-123',
      idempotencyKey: 'idem-123',
      searchAttributes: { customerId: 'acme' },
    });
  });
});
