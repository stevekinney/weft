import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { PayloadSizeExceededError } from '../payload-size.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';

/** True when `haystack` contains `needle` starting at `start` as a contiguous byte subsequence. */
function matchesAt(haystack: Uint8Array, needle: Uint8Array, start: number): boolean {
  for (let offset = 0; offset < needle.length; offset++) {
    if (haystack[start + offset] !== needle[offset]) return false;
  }
  return true;
}

/** True when `haystack` contains `needle` as a contiguous byte subsequence. */
function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (matchesAt(haystack, needle, start)) return true;
  }
  return false;
}

/** Walk an error's `cause` chain looking for a payload-size rejection. */
function causeChainHas(error: unknown, predicate: (candidate: unknown) => boolean): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (predicate(current)) return true;
    seen.add(current);
    current = current.cause;
  }
  return predicate(current);
}

const bigResult = 'x'.repeat(1024);

const oversizeActivity = activity({
  name: 'oversize',
  execute: async () => bigResult,
});

const runOversize = workflow({ name: 'run-oversize' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.run(oversizeActivity);
});

describe('payload-size cap — activity result', () => {
  it('fails the operation with PayloadSizeExceededError and appends no completed event with the oversize result', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(oversizeActivity);
    engine.register(runOversize);

    const handle = await engine.start('run-oversize', null, { id: 'wf-activity' });

    let thrown: unknown;
    try {
      await handle.result();
    } catch (error) {
      thrown = error;
    }

    // The workflow surfaces the activity failure as its terminal error.
    expect(thrown).toBeDefined();

    // No event in the durable log carries the oversize result value. Guard
    // against a vacuous pass: there must actually be events to scan.
    const events = await engine.getEvents('wf-activity');
    expect(events.length).toBeGreaterThan(0);
    const eventsCarryOversize = events.some((event) => JSON.stringify(event).includes(bigResult));
    expect(eventsCarryOversize).toBe(false);

    // Decisive: the oversize value is absent from EVERY persisted record —
    // not just the event log, but checkpoints, checkpoint history, and
    // workflow state too. Decode each stored value and look for the marker.
    const bigBytes = encode(bigResult);
    let scannedAny = false;
    let anyRecordCarriesOversize = false;
    for await (const [, bytes] of storage.scan('')) {
      scannedAny = true;
      if (bytesContain(bytes, bigBytes)) {
        anyRecordCarriesOversize = true;
        break;
      }
    }
    expect(scannedAny).toBe(true);
    expect(anyRecordCarriesOversize).toBe(false);

    engine[Symbol.dispose]();
  });

  it('admits an activity result at or below the limit', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 1024 } });
    const smallActivity = activity({ name: 'small', execute: async () => 'ok' });
    const runSmall = workflow({ name: 'run-small' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.run(smallActivity);
    });
    engine.register(smallActivity);
    engine.register(runSmall);

    const handle = await engine.start('run-small', null, { id: 'wf-activity-ok' });
    expect(await handle.result()).toBe('ok');

    engine[Symbol.dispose]();
  });

  it('surfaces PayloadSizeExceededError as the activity failure cause', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(oversizeActivity);
    engine.register(runOversize);

    const handle = await engine.start('run-oversize', null, { id: 'wf-activity-cause' });
    const error = await handle.result().then(
      () => null,
      (caught: unknown) => caught,
    );

    // The operation-failure boundary reconstructs the error as a plain `Error`,
    // so the class/name is not preserved — but the rejection *message* is
    // forwarded verbatim. Match on that stable message (or a genuine instance,
    // should the boundary ever start preserving the type).
    const isPayloadSizeError = (candidate: unknown): boolean =>
      candidate instanceof PayloadSizeExceededError ||
      (candidate instanceof Error &&
        candidate.message.includes('exceeds the configured maximum serialized size'));
    expect(causeChainHas(error, isPayloadSizeError)).toBe(true);

    engine[Symbol.dispose]();
  });
});
