# Subscription Wire Format Fixtures

Two fixture groups that pin the WebSocket subscription wire format
emitted by `createJsonRpcWebSocketSession`. The fixture-equivalence test
at `subscription-wire-equivalence.test.ts` asserts the live code emits
each frame byte-for-byte after non-deterministic fields are normalized.

## `current-contract/`

Frames captured from the production code path. These pin the current
wire contract, so any pull request that modifies them must review the
subscription protocol change end-to-end.

- `subscribe-request.json` — JSON-RPC request a client sends to subscribe.
- `subscribe-ack.json` — server's response containing `subscriptionId` and
  initial `cursor`.
- `event-deliver.json` — `weft.events.deliver` notification carrying one
  EventEnvelope.
- `unsubscribe-request.json` — JSON-RPC request a client sends to unsubscribe.
- `terminated-client-unsubscribed.json` — terminator emitted after the
  client requests unsubscribe.
- `terminated-server-closed.json` — terminator emitted when the server
  closes the iterable normally (no fault).

## `new-error-contract/`

Frames specified by PR 3's element-validation contract. Hand-authored;
pin the new failure-mode shape so a regression in
`SubscriptionElementValidationError` classification (or in the per-pump
fault sanitization) is caught.

- `terminated-validation-failed.json` — terminator emitted when an
  element fails `eventSchema` validation. `reason` is `validation-failed`
  and `fault` carries the embedded error.
- `terminated-engine-error.json` — terminator emitted when the pump
  catches a non-validation error. `reason` is `server-closed` (sanitized
  catch-all) and `fault` carries a generic `EngineFailure` with no
  potentially-sensitive payload.

## Normalization

Non-deterministic fields are replaced with placeholders in the fixtures:

- `<workflow-id>` for the engine-assigned UUID.
- `<subscription-id>` for `sub_${crypto.randomUUID()}`.
- `<cursor>` for the encoded cursor string.
- `0` for `emittedAtMs` (test fixtures use frozen time).

The equivalence test applies the same normalization to live frames before
comparing against the fixture.
