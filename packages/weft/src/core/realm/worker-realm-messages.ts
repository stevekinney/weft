/**
 * Wire messages a real Worker-backed revision realm exchanges with its host
 * (COR-249), layered on top of the existing internal Worker realm-ready
 * handshake (`ready`, WFT-28, {@link
 * import('../worker-realm-readiness.ts').WorkerRealmReadyMessage}) and
 * fenced by {@link import('./realm-protocol.ts').RealmTurnEnvelope} (COR-117).
 *
 * This is a new, opt-in envelope for the revision-realm path only — see ADR
 * 0003 and 0004. It does not replace or extend the generic
 * `WorkerInboundMessage`/`WorkerOutboundMessage` shapes in
 * `../worker-protocol.ts`, which the existing `workflowExecutionMode:
 * 'worker'` path keeps using unchanged.
 *
 * @module core/realm/worker-realm-messages
 */

import type { RealmTurnEnvelope } from './realm-protocol.ts';

/** Host-to-realm: dispatch one turn. The realm answers with either a {@link RealmResultMessage} or a {@link RealmFailureMessage} carrying the same envelope. */
export interface RealmRunMessage {
  readonly type: 'realm-run';
  readonly envelope: RealmTurnEnvelope;
  readonly input: unknown;
}

/** Realm-to-host: the turn identified by `envelope` completed successfully. */
export interface RealmResultMessage {
  readonly type: 'realm-result';
  readonly envelope: RealmTurnEnvelope;
  readonly result: unknown;
}

/** Realm-to-host: the turn identified by `envelope` failed. Distinct from a host-side refusal (`realm-not-active`/`unknown-turn`) — this is the realm reporting that user code itself threw. */
export interface RealmFailureMessage {
  readonly type: 'realm-failure';
  readonly envelope: RealmTurnEnvelope;
  readonly error: string;
}

function isRecordWithType(message: unknown, type: string): message is Record<string, unknown> {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['type'] === type
  );
}

export function isRealmResultMessage(message: unknown): message is RealmResultMessage {
  return isRecordWithType(message, 'realm-result');
}

export function isRealmFailureMessage(message: unknown): message is RealmFailureMessage {
  return isRecordWithType(message, 'realm-failure');
}
