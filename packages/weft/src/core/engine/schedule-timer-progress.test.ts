/**
 * COR-1925: a tick's pause is built from `progress.state` and conditioned on `progress.stored`, so
 * the two must advance together. `advanceScheduleTimerProgress` is the one place that assigns
 * `progress.stored`; a direct assignment elsewhere is how a pause came to be built from a state
 * older than the bytes it was conditioned on, and is refused here.
 */
import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';

const OWNER_OF_THE_ASSIGNMENT = 'schedule-timer-writes.ts';

describe('the progress of a schedule timer tick', () => {
  it('advances its stored bytes only through advanceScheduleTimerProgress', async () => {
    const directory = dirname(import.meta.path);
    const assigning: string[] = [];
    for await (const file of new Glob('**/*.ts').scan({ cwd: directory })) {
      if (file.includes('.test') || file === OWNER_OF_THE_ASSIGNMENT) continue;
      const source = await Bun.file(join(directory, file)).text();
      if (/\bprogress\.stored\s*=[^=]/.test(source)) assigning.push(file);
    }
    expect(assigning).toEqual([]);
    const owner = await Bun.file(join(directory, OWNER_OF_THE_ASSIGNMENT)).text();
    expect(owner.match(/\bprogress\.stored\s*=[^=]/g)).toHaveLength(1);
  });
});
