/**
 * Shared fixtures for the application command mailbox suites.
 *
 * Every fixture drives an injected clock and an injected id source, so no test
 * ever sleeps or depends on wall-clock time. `.test-support.ts` is excluded from
 * the build, so none of this ships.
 *
 * @module core/application-mailbox.test-support
 */

import type { BatchOperation, ConditionalBatchCondition, Storage } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type {
  ApplicationCommandInput,
  ApplicationMailboxEventSink,
  ApplicationMailboxOptions,
} from './application-mailbox-contract.ts';
import { ApplicationMailbox } from './application-mailbox.ts';

/** A fixed, readable start instant so expected timestamps stay legible in assertions. */
export const MAILBOX_EPOCH = 1_700_000_000_000;

/** A manually advanced clock plus a deterministic id source. */
export type MailboxClock = {
  now(): number;
  advance(milliseconds: number): void;
};

export function createMailboxClock(start = MAILBOX_EPOCH): MailboxClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

/** Deterministic identifier source: `prefix-1`, `prefix-2`, … */
export function createIdSource(prefix = 'id'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

export type MailboxFixture = {
  readonly storage: Storage;
  readonly mailbox: ApplicationMailbox;
  readonly clock: MailboxClock;
};

/**
 * Build a mailbox over a fresh `MemoryStorage` with an injected clock and id
 * source. Pass `storage` to share a backend between two mailbox instances, which
 * is how the concurrency and recovery suites model separate processes.
 */
export function createMailboxFixture(
  overrides: Partial<ApplicationMailboxOptions> & { readonly clock?: MailboxClock } = {},
): MailboxFixture {
  const storage = overrides.storage ?? new MemoryStorage();
  const clock = overrides.clock ?? createMailboxClock();
  const { clock: _clock, storage: _storage, ...rest } = overrides;
  const mailbox = new ApplicationMailbox({
    namespace: 'bureau',
    resourceId: 'agent-7',
    now: clock.now,
    generateId: createIdSource(),
    ...rest,
    storage,
  });
  return { storage, mailbox, clock };
}

/** A minimal, valid command. Override any field to exercise a specific rule. */
export function commandInput(
  overrides: Partial<ApplicationCommandInput> = {},
): ApplicationCommandInput {
  return {
    caller: 'user:42',
    target: 'agent:7',
    kind: 'steer',
    payload: { form: 'inline', value: { text: 'stop' } },
    ...overrides,
  };
}

/** Admit a command and return its receipt, failing loudly on any other outcome. */
export async function admitOne(
  mailbox: ApplicationMailbox,
  overrides: Partial<ApplicationCommandInput> = {},
): Promise<string> {
  const admission = await mailbox.admit(commandInput(overrides));
  if (admission.status !== 'admitted') {
    throw new Error(`Expected an admitted command, received "${admission.status}".`);
  }
  return admission.receipt.commandId;
}

/** Claim the head, failing loudly when there is nothing claimable. */
export async function claimOne(
  mailbox: ApplicationMailbox,
): Promise<{ commandId: string; attemptToken: string; signal: AbortSignal }> {
  const result = await mailbox.claim();
  if (result.status !== 'claimed') {
    throw new Error(`Expected a claim, received "${result.status}".`);
  }
  return {
    commandId: result.claim.receipt.commandId,
    attemptToken: result.claim.attemptToken,
    signal: result.claim.signal,
  };
}

/** Every fleet event an {@link ApplicationMailboxEventSink} was asked to append. */
export type RecordedEvent = {
  readonly kind: string;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

/**
 * An event sink that records what it was asked to publish and commits the
 * caller's operations itself, so tests can assert the event stream without
 * standing up a real fleet feed.
 */
export class RecordingEventSink implements ApplicationMailboxEventSink {
  readonly events: RecordedEvent[] = [];
  /** When set, `append` throws this instead of committing. */
  failure: Error | null = null;

  constructor(private readonly storage: Storage) {}

  async append(
    event: RecordedEvent,
    options?: {
      readonly conditions?: readonly ConditionalBatchCondition[];
      readonly operations?: readonly BatchOperation[];
    },
  ): Promise<unknown> {
    if (this.failure !== null) throw this.failure;
    const committed = await this.storage.conditionalBatch?.(
      [...(options?.conditions ?? [])],
      [...(options?.operations ?? [])],
    );
    // A real feed throws once it has exhausted its own allocator retries; the
    // mailbox classifies that by re-reading its own conditions, so mirror it.
    if (committed !== true) throw new Error('Fleet event append lost its precondition.');
    this.events.push(event);
    return event;
  }
}
