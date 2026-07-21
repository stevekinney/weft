import { describe, expect, it } from 'bun:test';

import { encode } from '../codec.ts';
import { decodeScheduleRunMetadata, encodeScheduleRunMetadata } from './schedule-run-metadata.ts';

describe('schedule-run metadata', () => {
  it('round-trips current scheduled run metadata with an occurrence', () => {
    const metadata = decodeScheduleRunMetadata(
      encodeScheduleRunMetadata('nightly-schedule', 1_767_225_600_000),
    );

    expect(metadata).toEqual({
      id: 'nightly-schedule',
      occurrence: 1_767_225_600_000,
    });
  });

  it('round-trips metadata with an omitted occurrence', () => {
    const metadata = decodeScheduleRunMetadata(
      encodeScheduleRunMetadata('queued-schedule', undefined),
    );

    expect(metadata).toEqual({ id: 'queued-schedule' });
  });

  it('decodes historical schedule-run string metadata', () => {
    expect(decodeScheduleRunMetadata(encode('historical-schedule'))).toEqual({
      id: 'historical-schedule',
    });
  });

  it('rejects malformed persisted metadata', () => {
    for (const malformed of [
      42,
      null,
      ['schedule-id'],
      { invalid: true },
      { id: 'nightly-schedule', occurrence: 1.5 },
      { id: 'nightly-schedule', occurrence: '2026-01-01' },
    ]) {
      expect(decodeScheduleRunMetadata(encode(malformed))).toBeNull();
    }
  });

  it('rejects unreadable persisted metadata bytes', () => {
    expect(decodeScheduleRunMetadata(new Uint8Array([0xc1]))).toBeNull();
  });
});
