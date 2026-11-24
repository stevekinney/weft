/**
 * COR-1908: `await engine[Symbol.asyncDispose]()` resolves only once a scheduler tick already
 * scanning storage has settled, so the host can close its storage straight after it (the late scan
 * that hit a disposed Postgres pool in COR-1906).
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage, type ScanOptions } from "../../embedded/storage/src/index.ts";
import { quietFor, waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { Engine } from './index.ts';

/** A storage whose deadline scan can be held at its first read, and that notices use after close. */
class GatedStorage extends MemoryStorage {
  gate: Promise<void> | null = null;
  parkedScans = 0;
  closed = false;
  readonly callsAfterClose: string[] = [];

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    if (this.closed) this.callsAfterClose.push(`scan ${prefix}`);
    if (prefix === 'wf-deadline:' && this.gate !== null) {
      this.parkedScans += 1;
      await this.gate;
      if (this.closed) this.callsAfterClose.push(`scan ${prefix} (after gate)`);
    }
    yield* super.scan(prefix, options);
  }
}

describe('Engine[Symbol.asyncDispose] and a scheduler tick in flight', () => {
  it('resolves only after the tick settles, and the scheduler touches no storage after', async () => {
    const storage = new GatedStorage();
    const engine = new Engine({ storage });
    const gate = Promise.withResolvers<void>();
    storage.gate = gate.promise;
    const tick = engine.scheduler.tick();
    await waitUntil(() => storage.parkedScans > 0, { message: 'a tick parked in a read' });

    let disposed = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposed = true;
    });
    await quietFor(40);
    expect(disposed).toBe(false);

    gate.resolve();
    await tick;
    await disposal;
    storage.closed = true;
    await quietFor(40);
    expect(storage.callsAfterClose).toEqual([]);
  });

  it('on an engine already disposed synchronously, waits for the tick too', async () => {
    const storage = new GatedStorage();
    const engine = new Engine({ storage });
    const gate = Promise.withResolvers<void>();
    storage.gate = gate.promise;
    const tick = engine.scheduler.tick();
    await waitUntil(() => storage.parkedScans > 0, { message: 'a tick parked in a read' });
    engine[Symbol.dispose]();

    let disposed = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposed = true;
    });
    await quietFor(40);
    expect(disposed).toBe(false);

    gate.resolve();
    await tick;
    await disposal;
  });
});
