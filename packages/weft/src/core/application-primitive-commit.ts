/**
 * Committing one durable state transition of an application primitive,
 * atomically with the fleet event that describes it (WFT-84, WFT-85).
 *
 * A transition is a compare-and-swap plan: the conditions it was decided
 * against and the operations that carry it out. Without an event sink the plan
 * is a plain conditional batch. With one, the sink is asked to append the event
 * under the same conditions and operations, and the FIRST commit through a sink
 * also writes a single-use probe key that is read back afterwards: nothing else
 * ever writes that key, so a concurrent transition on the record between the
 * commit and the read cannot be mistaken for a sink that committed to a
 * different backend.
 *
 * @module core/application-primitive-commit
 */

import type { BatchOperation, ConditionalBatchCondition, Storage } from '../storage/interface.ts';
import { storageConditionalBatch } from '../storage/interface.ts';

/**
 * What a primitive needs from a fleet event feed: append one event atomically
 * with the transition's conditions and operations. Structural on purpose, so
 * the core never imports the server's feed.
 */
export type ApplicationEventSink = {
  append(
    event: { readonly kind: string; readonly emittedAtMs: number; readonly payload: unknown },
    transaction: {
      readonly conditions: readonly ConditionalBatchCondition[];
      readonly operations: readonly BatchOperation[];
    },
  ): Promise<unknown>;
};

/** One durable state transition, optionally paired with the fleet event that describes it. */
export type ApplicationCommitPlan = {
  readonly conditions: readonly ConditionalBatchCondition[];
  readonly operations: readonly BatchOperation[];
  readonly event: { readonly kind: string; readonly payload: unknown } | null;
  readonly now: number;
  /**
   * Where the first commit through an event sink writes its verification
   * probe. Unique per plan, so a concurrent transition on the record can never
   * be mistaken for a sink that committed somewhere else.
   */
  readonly sinkProbeKey: string;
};

/**
 * Whether every compare-and-swap condition still matches durable state.
 *
 * Used to classify a failed event-sink append: if the caller's own conditions
 * still hold, the append failed for the feed's own reasons and the error must
 * propagate; if one moved, another actor won the race and the caller retries.
 */
export async function conditionsStillHold(
  storage: Storage,
  conditions: readonly ConditionalBatchCondition[],
): Promise<boolean> {
  for (const condition of conditions) {
    const current = await storage.get(condition.key);
    if (condition.expectedValue === null) {
      if (current !== null) return false;
      continue;
    }
    if (current === null || !bytesEqual(current, condition.expectedValue)) return false;
  }
  return true;
}

/** Byte-for-byte equality of two values, as `conditionalBatch` compares them. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Commit one transition, atomically with its fleet event when a sink is
 * configured.
 *
 * Returns `false` when a compare-and-swap condition was lost, which means
 * another actor transitioned the record first and the caller should re-read and
 * re-decide. Any other failure throws. `subject` names the primitive in the
 * misconfiguration diagnostic ("application mailbox", "application outbox").
 */
export async function commitApplicationTransition(
  storage: Storage,
  events: ApplicationEventSink | undefined,
  plan: ApplicationCommitPlan,
  subject: string,
): Promise<boolean> {
  if (events === undefined || plan.event === null) {
    return storageConditionalBatch(storage, [...plan.conditions], [...plan.operations]);
  }
  const probe = isSinkVerified(storage, events)
    ? null
    : { key: plan.sinkProbeKey, value: new TextEncoder().encode(plan.sinkProbeKey) };
  try {
    await events.append(
      { kind: plan.event.kind, emittedAtMs: plan.now, payload: plan.event.payload },
      {
        conditions: plan.conditions,
        operations:
          probe === null
            ? plan.operations
            : [...plan.operations, { type: 'put', key: probe.key, value: probe.value }],
      },
    );
  } catch (error) {
    // The feed retries its own sequence allocation internally and only throws
    // once it has exhausted those attempts. That exhaustion is indistinguishable
    // from our record condition being lost, so re-read the conditions we own: if
    // they still hold, the failure was genuinely the feed's and must propagate.
    if (await conditionsStillHold(storage, plan.conditions)) throw error;
    return false;
  }
  // Outside the catch above on purpose. A missing probe after a successful
  // append is unambiguous — the batch did not land here — and must never be
  // reported as a lost compare-and-swap for the caller to retry.
  if (probe !== null) await assertSinkCommittedLocally(storage, events, probe, subject);
  return true;
}

/**
 * Storage backends already proven to receive an event sink's committed writes.
 *
 * The check runs once per backend rather than per transition: a sink that
 * commits to the right place once will keep doing so, and a misconfiguration is
 * a construction-time mistake that shows up on the very first commit. Keyed by
 * the sink AND the backend: keying by backend alone would let one correctly
 * configured handle mark a store verified, after which a second handle on the
 * same store with a feed over a DIFFERENT store would skip the check entirely.
 */
const VERIFIED_SINK_BACKENDS = new WeakMap<ApplicationEventSink, WeakSet<Storage>>();

function verifiedBackendsFor(events: ApplicationEventSink): WeakSet<Storage> {
  let verified = VERIFIED_SINK_BACKENDS.get(events);
  if (verified === undefined) {
    verified = new WeakSet();
    VERIFIED_SINK_BACKENDS.set(events, verified);
  }
  return verified;
}

function isSinkVerified(storage: Storage, events: ApplicationEventSink): boolean {
  return verifiedBackendsFor(events).has(storage);
}

async function assertSinkCommittedLocally(
  storage: Storage,
  events: ApplicationEventSink,
  probe: { readonly key: string; readonly value: Uint8Array },
  subject: string,
): Promise<void> {
  let stored: Uint8Array | null;
  try {
    stored = await storage.get(probe.key);
  } catch {
    // The transition and its event are already durable. A read that cannot
    // determine the probe's fate is not evidence of a misconfigured sink, and
    // surfacing it would invite the caller to retry a committed operation —
    // for a keyless admission, into a second record. Stay unverified; the next
    // commit through this sink checks again.
    return;
  }
  if (stored === null || !bytesEqual(stored, probe.value)) {
    throw new Error(
      `The configured ${subject} event sink committed to a different storage backend than the ${subject}. Build the fleet event feed over the same Storage instance the ${subject} uses.`,
    );
  }
  verifiedBackendsFor(events).add(storage);
  // The probe has done its job and the batch that wrote it is durable either
  // way, so cleanup is best-effort: a transient delete failure must not turn a
  // committed operation into a rejection the caller would retry — for a keyless
  // admission that retry would create a second record.
  try {
    await storage.delete(probe.key);
  } catch {
    // Left behind. It is inert, unique to this plan, and never read again.
  }
}
