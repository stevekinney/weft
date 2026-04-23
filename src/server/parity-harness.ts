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
 *
 * `headers` is a full normalized header map (lowercase names → values)
 * so parity tests catch divergence on ANY header — not just
 * `content-type`. Without this, a binding that silently drops
 * `retry-after` or `cache-control` passes the parity test while
 * breaking the HTTP contract.
 */
export type ResponseFingerprint = {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

/**
 * Normalize the response's headers into a plain object keyed by
 * lowercase name. Fetch/Bun `Headers` already lowercase names, but
 * we materialize into a Record so the fingerprint is JSON-serializable
 * and comparable via `Object.entries` without iteration-order surprises.
 */
function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, name) => {
    normalized[name.toLowerCase()] = value;
  });
  return normalized;
}

export async function responseFingerprint(response: Response): Promise<ResponseFingerprint> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    headers: normalizeHeaders(response.headers),
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
 * fingerprints. Caller constructs the request, seeds the engine, and
 * asserts equivalence (typically via `assertFingerprintsMatch`). The
 * request is cloned before each dispatch so POST/PATCH/PUT body
 * streams stay fresh across both calls.
 *
 * ⚠ Engine isolation: both passes share the same `engine` instance.
 * The legacy dispatch runs first; mutating operations (start/signal/
 * cancel/etc.) see post-mutation state on the second pass and parity
 * will break. Safe for pure reads, idempotent writes, and 4xx
 * fast-exits. Mutating migrations should construct separate engines
 * per dispatch or make the operation idempotent — the right choice
 * lives in the per-operation migration test, not here.
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
  const headerDiff = diffHeaders(actual.headers, expected.headers);
  if (headerDiff.length > 0) {
    mismatches.push(`headers:\n    ${headerDiff.join('\n    ')}`);
  }
  if (actual.body !== expected.body) {
    mismatches.push(`body:\n  actual:   ${actual.body}\n  expected: ${expected.body}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`${context} mismatch:\n  - ${mismatches.join('\n  - ')}`);
  }
}

/**
 * Produce a list of header-level mismatch strings. Returns an empty
 * array when both header maps are equivalent. Reports:
 *   - "only-in-actual" headers (present in actual, absent in expected)
 *   - "only-in-expected" headers (absent in actual, present in expected)
 *   - value mismatches for headers present in both
 *
 * Headers like `date` that legitimately vary per request are NOT
 * filtered here — migrations whose legacy and pipeline paths produce
 * different `date` values by running sequentially should capture both
 * responses at the same moment or strip volatile headers before
 * comparing.
 */
function diffHeaders(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const sortedKeys = [...allKeys].toSorted();
  for (const key of sortedKeys) {
    const a = actual[key];
    const e = expected[key];
    if (a === undefined && e !== undefined) {
      diffs.push(`only-in-expected: ${key}: ${e}`);
    } else if (e === undefined && a !== undefined) {
      diffs.push(`only-in-actual: ${key}: ${a}`);
    } else if (a !== e) {
      diffs.push(`${key}: ${String(a)} ≠ ${String(e)}`);
    }
  }
  return diffs;
}
