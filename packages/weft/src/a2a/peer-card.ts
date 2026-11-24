/**
 * Validates a peer's Agent Card and selects the interface a client will use.
 *
 * @module a2a/peer-card
 */

import type { AgentCard, AgentInterface } from '@a2a-js/sdk';

import { A2APeerError, ExtensionSupportRequiredError } from './peer-client-types.ts';

/** What the client keeps from a validated card. */
export interface ValidatedPeerCard {
  /** The one interface the client will call. */
  readonly selected: AgentInterface;
  /** Whether the card advertises streaming. */
  readonly streaming: boolean;
  /** The declared extensions this client supports, activated on every request. */
  readonly activeExtensions: readonly string[];
}

/** The origin of `url`, or `undefined` when it is not an absolute URL. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function assertExtensionsSupported(card: AgentCard, supported: ReadonlySet<string>): void {
  const missing = (card.capabilities?.extensions ?? [])
    .filter((extension) => extension.required && !supported.has(extension.uri))
    .map((extension) => extension.uri);
  if (missing.length > 0) throw new ExtensionSupportRequiredError(missing);
}

function selectInterface(card: AgentCard, allowedOrigins: ReadonlySet<string>): AgentInterface {
  const speaksJsonRpc = card.supportedInterfaces.filter(
    (entry) => entry.protocolBinding === 'JSONRPC' && /^1\.0(\.\d+)?$/.test(entry.protocolVersion),
  );
  if (speaksJsonRpc.length === 0) {
    throw new A2APeerError(
      'version-not-supported',
      'The card lists no JSONRPC interface that speaks A2A 1.0.',
    );
  }
  const allowed = speaksJsonRpc.find((entry) => allowedOrigins.has(originOf(entry.url) ?? ''));
  if (allowed === undefined) {
    throw new A2APeerError(
      'egress-denied',
      'Every A2A 1.0 interface on the card is on an origin this client does not allow.',
    );
  }
  return allowed;
}

/** Whether a media type a card lists covers `text/plain`: that type or a wildcard for it, parameters ignored. */
function coversText(mode: string): boolean {
  const type = (mode.split(';')[0] ?? '').trim().toLowerCase();
  return type === 'text/plain' || type === 'text/*' || type === '*/*';
}

function assertAcceptsText(card: AgentCard): void {
  if (card.defaultInputModes.length > 0 && !card.defaultInputModes.includes('text/plain')) {
    throw new A2APeerError('content-type-not-supported', 'The peer accepts no text/plain input.');
  }
  // The client sends `acceptedOutputModes: ['text/plain']` on every request, so a peer that lists
  // only other modes could answer in none the client accepts.
  if ((card.defaultOutputModes ?? []).length > 0 && !card.defaultOutputModes.some(coversText)) {
    throw new A2APeerError(
      'content-type-not-supported',
      'The peer answers in no text/plain output, which is all this client accepts.',
    );
  }
}

/**
 * Checks a freshly read card. Refuses, in order: a required extension the client does not
 * support, a card with no usable A2A 1.0 JSON-RPC interface on an allowed origin, and a card
 * that accepts no `text/plain` input or lists output modes of which none is text. The caller still checks egress for the selected URL.
 */
export function validatePeerCard(
  card: AgentCard,
  supported: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
): ValidatedPeerCard {
  assertExtensionsSupported(card, supported);
  const selected = selectInterface(card, allowedOrigins);
  assertAcceptsText(card);
  return {
    selected,
    streaming: card.capabilities?.streaming === true,
    activeExtensions: (card.capabilities?.extensions ?? [])
      .map((extension) => extension.uri)
      .filter((uri) => supported.has(uri)),
  };
}
