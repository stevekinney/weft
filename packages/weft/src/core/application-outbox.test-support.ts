/**
 * Shared fixtures for the application delivery outbox suites.
 *
 * Every fixture drives an injected clock and an injected id source, so no test
 * ever sleeps or depends on wall-clock time. The event sink is the mailbox's
 * `RecordingEventSink`, imported rather than duplicated. `.test-support.ts` is
 * excluded from the build, so none of this ships.
 *
 * @module core/application-outbox.test-support
 */

import type { Storage } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  createIdSource,
  createMailboxClock,
  type MailboxClock,
} from './application-mailbox.test-support.ts';
import type {
  ApplicationDeliveryAdapter,
  ApplicationDeliveryInput,
  ApplicationDeliveryOutcome,
  ApplicationDeliverySendRequest,
  ApplicationOutboxOptions,
} from './application-outbox-contract.ts';
import { ApplicationOutbox } from './application-outbox.ts';

export {
  createIdSource,
  createMailboxClock as createOutboxClock,
  RecordingEventSink,
} from './application-mailbox.test-support.ts';
export type { MailboxClock as OutboxClock } from './application-mailbox.test-support.ts';

/**
 * A scripted transport: each `send()` takes the next queued outcome, or a
 * thrown error, or blocks until released. Every request is recorded so tests
 * can assert what the adapter saw — and what it never saw.
 */
export class ScriptedAdapter implements ApplicationDeliveryAdapter {
  readonly requests: ApplicationDeliverySendRequest[] = [];
  readonly #script: (
    | { readonly kind: 'outcome'; readonly outcome: unknown }
    | { readonly kind: 'throw'; readonly error: unknown }
    | { readonly kind: 'block'; readonly release: Promise<ApplicationDeliveryOutcome> }
  )[] = [];
  /** The outcome used once the script runs dry. */
  fallback: ApplicationDeliveryOutcome = { status: 'acknowledged' };

  // Explicit so Bun's LCOV function counting does not report the synthesized
  // constructor as a function no test can reach.
  constructor() {
    this.fallback = { status: 'acknowledged' };
  }

  reply(outcome: unknown): this {
    this.#script.push({ kind: 'outcome', outcome });
    return this;
  }

  fail(error: unknown): this {
    this.#script.push({ kind: 'throw', error });
    return this;
  }

  /** Queue a send that stays pending until the returned resolver is called. */
  block(): (outcome: ApplicationDeliveryOutcome) => void {
    let release!: (outcome: ApplicationDeliveryOutcome) => void;
    const promise = new Promise<ApplicationDeliveryOutcome>((resolve) => {
      release = resolve;
    });
    this.#script.push({ kind: 'block', release: promise });
    return release;
  }

  readonly #requestWaiters: ((request: ApplicationDeliverySendRequest) => void)[] = [];

  /** Resolves with the next send request, or at once with the last one already seen. */
  nextRequest(): Promise<ApplicationDeliverySendRequest> {
    const last = this.requests.at(-1);
    if (last !== undefined) return Promise.resolve(last);
    return new Promise((resolve) => {
      this.#requestWaiters.push(resolve);
    });
  }

  async send(request: ApplicationDeliverySendRequest): Promise<ApplicationDeliveryOutcome> {
    this.requests.push(request);
    for (const waiter of this.#requestWaiters.splice(0)) waiter(request);
    const step = this.#script.shift();
    if (step === undefined) return this.fallback;
    if (step.kind === 'throw') throw step.error;
    if (step.kind === 'block') return step.release;
    // The script may deliberately hand back a malformed outcome.
    return step.outcome as ApplicationDeliveryOutcome;
  }
}

export type OutboxFixture = {
  readonly storage: Storage;
  readonly outbox: ApplicationOutbox;
  readonly clock: MailboxClock;
  readonly adapter: ScriptedAdapter;
};

/**
 * Build an outbox over a fresh `MemoryStorage` with an injected clock, id
 * source, and scripted adapter. Pass `storage` to share a backend between two
 * instances, which is how the concurrency and recovery suites model separate
 * processes.
 */
export function createOutboxFixture(
  overrides: Partial<ApplicationOutboxOptions> & {
    readonly clock?: MailboxClock;
    readonly scripted?: ScriptedAdapter;
  } = {},
): OutboxFixture {
  const storage = overrides.storage ?? new MemoryStorage();
  const clock = overrides.clock ?? createMailboxClock();
  const adapter = overrides.scripted ?? new ScriptedAdapter();
  const { clock: _clock, storage: _storage, scripted: _scripted, ...rest } = overrides;
  const outbox = new ApplicationOutbox({
    namespace: 'bureau',
    ownerId: 'agent-7',
    now: clock.now,
    generateId: createIdSource(),
    adapter,
    ...rest,
    storage,
  });
  return { storage, outbox, clock, adapter };
}

/** A minimal, valid delivery. Override any field to exercise a specific rule. */
export function deliveryInput(
  overrides: Partial<ApplicationDeliveryInput> = {},
): ApplicationDeliveryInput {
  return {
    destinationRef: 'webhook:orders',
    kind: 'order.shipped',
    payload: { form: 'inline', value: { orderId: 42 } },
    ...overrides,
  };
}

/** Enqueue a delivery and return its id, failing loudly on any other outcome. */
export async function enqueueOne(
  outbox: ApplicationOutbox,
  overrides: Partial<ApplicationDeliveryInput> = {},
): Promise<string> {
  const admission = await outbox.enqueue(deliveryInput(overrides));
  if (admission.status !== 'enqueued') {
    throw new Error(`Expected an enqueued delivery, received "${admission.status}".`);
  }
  return admission.receipt.deliveryId;
}

/** Claim the earliest due delivery, failing loudly when there is nothing claimable. */
export async function claimOne(
  outbox: ApplicationOutbox,
): Promise<{ deliveryId: string; attemptToken: string; signal: AbortSignal }> {
  const result = await outbox.claim();
  if (result.status !== 'claimed') {
    throw new Error(`Expected a claim, received "${result.status}".`);
  }
  return {
    deliveryId: result.claim.receipt.deliveryId,
    attemptToken: result.claim.attemptToken,
    signal: result.claim.signal,
  };
}

/** Claim and durably begin one attempt, returning its fencing token. */
export async function beginOne(
  outbox: ApplicationOutbox,
): Promise<{ deliveryId: string; attemptToken: string; signal: AbortSignal }> {
  const claim = await claimOne(outbox);
  const begun = await outbox.beginAttempt(claim);
  if (begun.status !== 'settled') throw new Error(`Expected begin, received "${begun.status}".`);
  return claim;
}

/** Deliver one through the adapter, failing loudly unless it settled. */
export async function deliverOne(outbox: ApplicationOutbox): Promise<string> {
  const result = await outbox.deliverNext();
  if (result.status !== 'settled') {
    throw new Error(`Expected a settled delivery, received "${result.status}".`);
  }
  return result.receipt.state;
}

/** The `status` of a result, without indexing an await expression. */
export async function statusOf<T extends { readonly status: string }>(
  result: Promise<T>,
): Promise<T['status']> {
  const resolved = await result;
  return resolved.status;
}

/** One field of an awaited value, `undefined` when the value is null. */
export async function fieldOf<T, K extends keyof NonNullable<T>>(
  value: Promise<T>,
  key: K,
): Promise<NonNullable<T>[K] | undefined> {
  const resolved = await value;
  return resolved === null || resolved === undefined ? undefined : resolved[key];
}
