import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
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

  it('reads client-facing provenance from the durable schedule-run link', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    await storage.put(
      KEYS.scheduleRunLink('scheduled-workflow'),
      encodeScheduleRunMetadata('nightly-schedule', 1_767_225_600_000),
    );

    await expect(engine.getScheduleProvenance('scheduled-workflow')).resolves.toEqual({
      scheduleId: 'nightly-schedule',
      occurrence: 1_767_225_600_000,
    });
    await expect(engine.getScheduleProvenance('ordinary-workflow')).resolves.toBeNull();
  });

  it('keeps historical string links readable through the client-facing provenance API', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    await storage.put(KEYS.scheduleRunLink('historical-workflow'), encode('historical-schedule'));

    await expect(engine.getScheduleProvenance('historical-workflow')).resolves.toEqual({
      scheduleId: 'historical-schedule',
    });
  });
});
