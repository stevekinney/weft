/**
 * Test-only builder for the fault-envelope golden: every fault code, with every `data` field
 * set, projected onto its REST response and its JSON-RPC error. It imports only the fault
 * model and its two mappers.
 */

import { join } from 'node:path';

import type { FaultCode } from './fault-code.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { formatGoldenJson, writeGoldenDirectory } from './golden-files.test-support.ts';
import type { OperationFault } from './operation-fault.ts';

/** The directory holding the fault-envelope golden files. */
export const FAULT_ENVELOPE_GOLDEN_DIRECTORY = join(
  import.meta.dir,
  '__fixtures__',
  'fault-envelope-golden',
);

/**
 * One literal fault per code. Each has `message: 'golden'` and every `data` field set, optional
 * fields included: strings are `'golden'` (`weftCode` is `'WorkflowNotFoundError'`), numbers `1`,
 * booleans `true`, a union takes its first member, and an array holds one element.
 */
export const GOLDEN_FAULTS = {
  Unauthorized: { code: 'Unauthorized', message: 'golden', data: { reason: 'golden' } },
  Forbidden: { code: 'Forbidden', message: 'golden', data: { reason: 'golden' } },
  NotFound: {
    code: 'NotFound',
    message: 'golden',
    data: { resource: 'golden', identifier: 'golden', weftCode: 'WorkflowNotFoundError' },
  },
  Conflict: {
    code: 'Conflict',
    message: 'golden',
    data: {
      reason: 'golden',
      publicReason: 'workflow-replaced',
      weftCode: 'WorkflowNotFoundError',
      missingTypes: ['golden'],
      missingWorkflowCount: 1,
      samplesTruncated: true,
      currentGeneration: 1,
      compatibilityReasons: ['name-mismatch'],
      sourceValidationReasons: ['unregistered-source-kind'],
    },
  },
  Unprocessable: { code: 'Unprocessable', message: 'golden', data: { reason: 'golden' } },
  Timeout: {
    code: 'Timeout',
    message: 'golden',
    data: { operationName: 'golden', updateId: 'golden' },
  },
  PayloadTooLarge: { code: 'PayloadTooLarge', message: 'golden', data: { maxBytes: 1 } },
  NotImplemented: { code: 'NotImplemented', message: 'golden', data: {} },
  UnsupportedTransport: {
    code: 'UnsupportedTransport',
    message: 'golden',
    data: { transport: 'http-rest', supported: ['http-rest'] },
  },
  SubscriptionOverflow: {
    code: 'SubscriptionOverflow',
    message: 'golden',
    data: { subscriptionId: 'golden', droppedCount: 1 },
  },
  InvalidParams: {
    code: 'InvalidParams',
    message: 'golden',
    data: {
      issues: [{ path: ['golden'], message: 'golden', code: 'golden' }],
      weftCode: 'WorkflowNotFoundError',
    },
  },
  MethodNotFound: { code: 'MethodNotFound', message: 'golden', data: { method: 'golden' } },
  StaleRevision: {
    code: 'StaleRevision',
    message: 'golden',
    data: { expectedRevision: 'golden', currentRevision: 'golden' },
  },
  RateLimited: { code: 'RateLimited', message: 'golden', data: { retryAfterSeconds: 1 } },
  Unavailable: {
    code: 'Unavailable',
    message: 'golden',
    data: { reason: 'golden', retryAfterSeconds: 1 },
  },
  UnsupportedCapability: {
    code: 'UnsupportedCapability',
    message: 'golden',
    data: { capability: 'golden' },
  },
  EngineFailure: { code: 'EngineFailure', message: 'golden', data: {} },
} as const satisfies { readonly [Code in FaultCode]: Extract<OperationFault, { code: Code }> };

/**
 * Every golden fault's REST response and JSON-RPC error, keyed by fault code. Each fault is built
 * with `remediation: 'golden'`.
 */
export async function buildFaultEnvelopes(): Promise<Record<string, unknown>> {
  const envelopes: Record<string, unknown> = {};
  for (const [code, goldenFault] of Object.entries(GOLDEN_FAULTS)) {
    // Every fault carries a remediation, so the golden pins the field on each transport and the
    // `EngineFailure` mask that drops it.
    const fault: OperationFault = { ...goldenFault, remediation: 'golden' };
    const response = faultToHttpResponse(fault);
    envelopes[code] = {
      http: {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json(),
      },
      jsonRpc: faultToJsonRpcError(fault),
    };
  }
  return envelopes;
}

/** Rewrite a directory to hold exactly the fault-envelope golden. */
export async function writeFaultEnvelopeGolden(directory: string): Promise<void> {
  await writeGoldenDirectory(directory, {
    'fault-envelopes.json': formatGoldenJson(await buildFaultEnvelopes()),
  });
}
