import { describe, expect, it } from 'bun:test';

import {
  extractSharedScheduleRestFields,
  parseScheduleRestBodyRequestRecord,
} from './schedule-rest-body.ts';

describe('schedule REST body extraction', () => {
  it('maps malformed JSON to the shared invalid JSON fault', async () => {
    await expect(
      parseScheduleRestBodyRequestRecord(
        new Request('http://localhost/v1/schedules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }),
      ),
    ).rejects.toMatchObject({ code: 'InvalidParams', message: 'Invalid JSON body' });
  });

  it.each([null, 'not-an-object', 42])('rejects JSON %j as a non-object body', async (body) => {
    await expect(
      parseScheduleRestBodyRequestRecord(
        new Request('http://localhost/v1/schedules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'InvalidParams',
      message: 'Request body must be a JSON object',
    });
  });

  it('keeps arrays available for operation-specific validation', async () => {
    const record = await parseScheduleRestBodyRequestRecord(
      new Request('http://localhost/v1/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(['not-an-object']),
      }),
    );

    expect(extractSharedScheduleRestFields(record)).toEqual({
      cronExpression: undefined,
      every: undefined,
      description: undefined,
      overlap: undefined,
      backfill: undefined,
      jitter: undefined,
    });
  });

  it('preserves explicit undefined cadence properties and partial policy fields', () => {
    const fields = extractSharedScheduleRestFields({
      every: undefined,
      overlap: 'queue',
      jitter: '30s',
    });

    expect(fields).toEqual({
      cronExpression: undefined,
      every: undefined,
      description: undefined,
      overlap: 'queue',
      backfill: undefined,
      jitter: '30s',
    });
  });
});
