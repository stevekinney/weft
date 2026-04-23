/**
 * Phase 15d — Reusable parity diff harness for REST migrations.
 *
 * Every operation migrated onto the `executeOperation` pipeline must
 * prove byte-for-byte equivalence between the legacy `handleXxx`
 * executor and the new binding + pipeline dispatch. This module
 * provides the minimal primitives every such test needs:
 *
 *   - `responseFingerprint(response)` — captures status, content-type,
 *     and body text for structural comparison.
 *   - `runParity(engine, request, { registry, bindings })` — runs the
 *     same request through legacy and pipeline dispatch, returns
 *     both fingerprints.
 *   - `assertFingerprintsMatch(actual, expected)` — asserts the
 *     triple matches. Does NOT invoke Bun's `expect` — callers pass
 *     their own assertion function so this module stays runtime-agnostic
 *     and the harness is usable in any test setup.
 *
 * @module server/parity-harness
 */

import type { Engine } from '../core/engine.ts';
import { handleRequest } from './handler.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';

/**
 * Structural snapshot of a `Response`. The body is read into a string
 * so comparison is exact byte equality; for binary responses the
 * caller should capture and compare headers + bytes separately.
 */
export type ResponseFingerprint = {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
};

export async function responseFingerprint(response: Response): Promise<ResponseFingerprint> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

export type ParityRunOptions = {
  readonly registry: OperationRegistry;
  readonly bindings: ReadonlyArray<UnknownRestBinding>;
};

export type ParityRunResult = {
  readonly legacy: ResponseFingerprint;
  readonly viaExecuteOperation: ResponseFingerprint;
};

/**
 * Dispatch the same request through both paths and return both
 * fingerprints. The caller is responsible for constructing the
 * request, seeding the engine, and asserting equivalence (typically
 * via `assertFingerprintsMatch`).
 *
 * The request is cloned before each dispatch so the body stream is
 * fresh — without this, the second dispatch reads an already-consumed
 * body and the parity assertion would always fail on POST/PATCH/PUT.
 */
export async function runParity(
  engine: Engine,
  request: Request,
  options: ParityRunOptions,
): Promise<ParityRunResult> {
  const legacyResponse = await handleRequest(request.clone(), engine);
  const legacy = await responseFingerprint(legacyResponse);

  const newResponse = await handleRequest(request.clone(), engine, {
    restDispatchMode: 'via-execute-operation',
    operationRegistry: options.registry,
    restBindings: options.bindings,
  });
  const viaExecuteOperation = await responseFingerprint(newResponse);

  return { legacy, viaExecuteOperation };
}

/**
 * Assert that two fingerprints match on all three axes. Throws an
 * `Error` with a message describing which axis diverged — the message
 * lists all three pairs so a single assertion failure surfaces every
 * drift in one place rather than forcing the caller to chase each
 * axis one at a time.
 */
export function assertFingerprintsMatch(
  actual: ResponseFingerprint,
  expected: ResponseFingerprint,
  context: string = 'parity fingerprint',
): void {
  const mismatches: string[] = [];
  if (actual.status !== expected.status) {
    mismatches.push(`status: ${actual.status} ≠ ${expected.status}`);
  }
  if (actual.contentType !== expected.contentType) {
    mismatches.push(
      `content-type: ${String(actual.contentType)} ≠ ${String(expected.contentType)}`,
    );
  }
  if (actual.body !== expected.body) {
    mismatches.push(`body:\n  actual:   ${actual.body}\n  expected: ${expected.body}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`${context} mismatch:\n  - ${mismatches.join('\n  - ')}`);
  }
}
