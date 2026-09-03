/**
 * Admission for the application command mailbox (WFT-84): validating an offered
 * command, resolving its idempotency identity, enforcing backlog capacity, and
 * committing the record with its indexes and fleet event.
 *
 * Admission is the one transition that also allocates: it advances the mailbox
 * header's FIFO sequence and open count in the same conditional batch as the
 * record itself, so backlog accounting can never drift from the records it
 * describes.
 *
 * @module core/application-mailbox-admission
 */

import type {
  ApplicationCommandAdmission,
  ApplicationCommandInput,
  ApplicationMailboxCapacity,
} from './application-mailbox-contract.ts';
import {
  encodeApplicationCommandIdempotencyRecord,
  encodeApplicationReadyEntry,
} from './application-mailbox-index-codec.ts';
import {
  ApplicationMailboxContentionError,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  describeCommandTransition,
  toApplicationCommandReceipt,
  type MailboxRuntime,
} from './application-mailbox-internals.ts';
import {
  commitMailboxTransition,
  headerOperation,
  loadCommand,
  loadIdempotencyBinding,
  loadMailboxHeader,
  planCommandTransition,
} from './application-mailbox-storage.ts';
import { createAdmittedCommandRecord } from './application-mailbox-transitions.ts';
import { APPLICATION_MAILBOX_RECORD_VERSION } from './application-mailbox-types.ts';
import {
  ApplicationCommandValidationError,
  requireGeneratedIdentifier,
  validateCommandInput,
} from './application-mailbox-validation.ts';
import { computeIdentityDigest } from './application-payload-digest.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** Backlog accounting, shared by admission rejection and the public `capacity()`. */
export function capacityOf(
  runtime: MailboxRuntime,
  open: number,
  admitted: number,
): ApplicationMailboxCapacity {
  const limit = runtime.policy.maxBacklog;
  return Object.freeze({ open, limit, remaining: Math.max(0, limit - open), admitted });
}

/**
 * Offer a command to the mailbox.
 *
 * An exact retry of the same idempotency identity returns the original
 * receipt without creating a second command. Reusing the key with a different
 * caller, target, kind, or payload digest returns a conflict and leaves the
 * original command untouched. A full backlog is rejected before anything is
 * persisted.
 */
export async function admitCommand(
  runtime: MailboxRuntime,
  command: ApplicationCommandInput,
): Promise<ApplicationCommandAdmission> {
  const input = await validateCommandInput(command, runtime.policy);
  const identityDigest = await computeIdentityDigest([
    input.caller,
    input.target,
    input.kind,
    input.payloadDigest,
  ]);
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    // The bytes this admission expects to find under the idempotency key:
    // `null` when the key is unused, or the stale binding's exact bytes when
    // retention retired the command it named. Requiring absence in the latter
    // case would make the key permanently unusable — the compare-and-swap
    // could never succeed against a binding nothing will ever delete.
    let expectedBinding: Uint8Array | null = null;
    if (input.idempotencyKey !== undefined) {
      const resolved = await resolveIdempotency(runtime, input.idempotencyKey, identityDigest);
      if (resolved.admission !== null) return resolved.admission;
      expectedBinding = resolved.staleBindingBytes;
    }
    const header = await loadMailboxHeader(
      runtime.storage,
      runtime.keys,
      runtime.policy.namespace,
      runtime.policy.resourceId,
    );
    if (header.record.openCount >= runtime.policy.maxBacklog) {
      return {
        status: 'rejected',
        reason: 'backlog-full',
        capacity: capacityOf(runtime, header.record.openCount, header.record.admittedCount),
      };
    }
    // A header at the safe-integer ceiling would be written back one past it
    // and never decode again, taking every later `capacity()` and `admit()`
    // down with it. Refuse before constructing anything.
    if (header.record.nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new ApplicationCommandValidationError(
        'This mailbox has exhausted its FIFO sequence allocator; no further commands can be admitted under this namespace and resource id.',
      );
    }
    const now = runtime.now();
    const record = createAdmittedCommandRecord(input, {
      namespace: runtime.policy.namespace,
      resourceId: runtime.policy.resourceId,
      commandId: requireGeneratedIdentifier(runtime.generateId(), 'commandId'),
      sequence: header.record.nextSequence,
      now,
    });
    const committed = await commitMailboxTransition(
      runtime.storage,
      runtime.events,
      planCommandTransition(runtime.keys, {
        previous: null,
        expectedBytes: null,
        next: record,
        event: describeCommandTransition(null, record),
        now,
        extraConditions: [
          { key: runtime.keys.header, expectedValue: header.bytes },
          ...(input.idempotencyKey === undefined
            ? []
            : [
                {
                  key: runtime.keys.idempotency(input.idempotencyKey),
                  expectedValue: expectedBinding,
                },
              ]),
        ],
        extraOperations: [
          {
            type: 'put' as const,
            key: runtime.keys.bySequence(record.sequence),
            value: encodeApplicationReadyEntry(record.commandId),
          },
          headerOperation(runtime.keys, {
            ...header.record,
            nextSequence: header.record.nextSequence + 1,
            openCount: header.record.openCount + 1,
            admittedCount: header.record.admittedCount + 1,
          }),
          ...(input.idempotencyKey === undefined
            ? []
            : [
                {
                  type: 'put' as const,
                  key: runtime.keys.idempotency(input.idempotencyKey),
                  value: encodeApplicationCommandIdempotencyRecord({
                    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
                    commandId: record.commandId,
                    identityDigest,
                  }),
                },
              ]),
        ],
      }),
    );
    if (!committed) continue;
    return { status: 'admitted', receipt: toApplicationCommandReceipt(record) };
  }
  throw new ApplicationMailboxContentionError('admit', null);
}

/**
 * Resolve an idempotency key against durable state.
 *
 * Returns the admission to hand straight back when the key already names a
 * live command, or the exact bytes a stale binding holds so the caller can
 * overwrite it under a compare-and-swap.
 */
async function resolveIdempotency(
  runtime: MailboxRuntime,
  idempotencyKey: string,
  identityDigest: string,
): Promise<{
  admission: ApplicationCommandAdmission | null;
  staleBindingBytes: Uint8Array | null;
}> {
  const binding = await loadIdempotencyBinding(runtime.storage, runtime.keys, idempotencyKey);
  if (binding === null) return { admission: null, staleBindingBytes: null };
  const loaded = await loadCommand(runtime.storage, runtime.keys, binding.record.commandId);
  // A binding whose command was retired by retention is spent, not a
  // conflict: the receipt it points at no longer exists, so a retry is
  // admitted afresh over the stale binding rather than answered with a
  // receipt this mailbox cannot produce.
  if (loaded === null) return { admission: null, staleBindingBytes: binding.bytes };
  // The binding must be the record's own: the record names this key, and the
  // record's identity reproduces the binding's digest. A damaged binding
  // pointing at an unrelated command with a matching digest would otherwise be
  // answered with that command's receipt as a duplicate.
  const ownDigest = await computeIdentityDigest([
    loaded.record.caller,
    loaded.record.target,
    loaded.record.kind,
    loaded.record.payloadDigest,
  ]);
  if (
    loaded.record.idempotencyKey !== idempotencyKey ||
    ownDigest !== binding.record.identityDigest
  ) {
    throw new PersistedDataCorruptError(runtime.keys.idempotency(idempotencyKey));
  }
  const receipt = toApplicationCommandReceipt(loaded.record);
  if (binding.record.identityDigest !== identityDigest) {
    return {
      admission: { status: 'conflict', receipt, reason: 'idempotency-identity-mismatch' },
      staleBindingBytes: null,
    };
  }
  return { admission: { status: 'duplicate', receipt }, staleBindingBytes: null };
}
