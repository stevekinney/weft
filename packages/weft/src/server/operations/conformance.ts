/**
 * `weft.conformance.targets` and `weft.conformance.report` operations + REST
 * bindings.
 *
 * `weft.conformance.report` runs the RemoteWorker protocol conformance check
 * sequence — the same `runConformanceReport` the `weft conformance` CLI
 * command runs — against one operator-registered target and returns the
 * structured report: every named check with its pass/fail verdict and
 * message, the overall verdict, and the protocol version metadata.
 * `weft.conformance.targets` lists the target names a caller may ask for.
 *
 * Security model (COR-1365). A request names a target; it never supplies a
 * command, arguments, environment, or timeout. Targets are fixed at boot by
 * `serve({ conformanceTargets })`, so the set of processes a request can
 * start is exactly the set the host process chose to allow — the operation is
 * not a remote-execution primitive. A run never touches the live server it
 * was requested from: it builds its own private `MemoryStorage`, `Engine`,
 * and loopback server, because the reconnect check kills a worker and the
 * graceful-shutdown check disconnects one. Running a target still spawns
 * processes on the server host, so `report` requires `system:admin`;
 * `targets` reveals only names and timeouts (never commands) and requires
 * `system:read`. Concurrent requests for one target join a single in-flight
 * run rather than each spawning workers.
 *
 * @module server/operations/conformance
 */

import { z } from 'zod';

import type {
  ConformanceTargetReport,
  ConformanceTargetRunner,
  ConformanceTargetSummary,
} from '../../conformance/targets.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const conformanceTargetSummarySchema = z
  .object({
    name: z.string(),
    timeoutMs: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<ConformanceTargetSummary>;

const conformanceCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    message: z.string(),
  })
  .strict();

const conformanceReportSchema = z
  .object({
    target: z.string(),
    startedAt: z.number(),
    completedAt: z.number(),
    ok: z.boolean(),
    protocolVersion: z.number().int(),
    supportedProtocolVersions: z.array(z.number().int()),
    checks: z.array(conformanceCheckSchema),
  })
  .strict() satisfies z.ZodType<ConformanceTargetReport>;

const listConformanceTargetsInput = z.object({});
const listConformanceTargetsOutput = z.object({
  targets: z.array(conformanceTargetSummarySchema),
});

const runConformanceReportInput = z.object({
  target: z.string().min(1),
});

export type ListConformanceTargetsOutput = z.infer<typeof listConformanceTargetsOutput>;
export type RunConformanceReportInput = z.infer<typeof runConformanceReportInput>;
export type RunConformanceReportOutput = z.infer<typeof conformanceReportSchema>;

type ConformanceOperationOptions = {
  conformanceTargetRunner?: ConformanceTargetRunner;
};

const conformanceTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
} as const;

function requireRunner(
  runner: ConformanceTargetRunner | undefined,
  operationName: string,
): ConformanceTargetRunner {
  if (runner === undefined) {
    throw new Error(
      `${operationName} invoked from a discovery-only operation registry; no conformance target runner was wired in`,
    );
  }
  return runner;
}

/**
 * Build the `weft.conformance.targets` operation. Without a runner, `invoke`
 * throws if reached — reserved for discovery-only registries.
 */
export function createListConformanceTargetsOperation(options: ConformanceOperationOptions = {}) {
  const runner = options.conformanceTargetRunner;
  return defineOperation({
    name: 'weft.conformance.targets',
    mcpExposable: false,
    summary: 'List the worker conformance targets this server can run',
    description:
      'Names and per-wait timeouts of the worker commands registered with ' +
      '`serve({ conformanceTargets })`, which `weft.conformance.report` can run. ' +
      'Commands are never returned. Empty when the server registers no targets.',
    destructive: false,
    tags: ['Observability'],
    inputSchema: listConformanceTargetsInput,
    outputSchema: listConformanceTargetsOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
    producibleFaults: [],
    discoverable: true,
    transports: conformanceTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async (): Promise<ListConformanceTargetsOutput> => ({
      targets: requireRunner(runner, 'weft.conformance.targets').list(),
    }),
  });
}

/**
 * Build the `weft.conformance.report` operation. Without a runner, `invoke`
 * throws if reached — reserved for discovery-only registries.
 */
export function createRunConformanceReportOperation(options: ConformanceOperationOptions = {}) {
  const runner = options.conformanceTargetRunner;
  const operation = defineOperation({
    name: 'weft.conformance.report',
    mcpExposable: false,
    summary: 'Run RemoteWorker protocol conformance checks against a registered target',
    description:
      'Run the `weft conformance` check sequence (register, task completion, heartbeat, ' +
      'cancellation, reconnect, revision echo, graceful shutdown) against one target ' +
      'registered with `serve({ conformanceTargets })`, inside a private sandbox server, and ' +
      'return every check with its verdict and message plus protocol version metadata. ' +
      'The request names a target only; it cannot supply a command. Concurrent requests for ' +
      'one target share a single run.',
    destructive: false,
    tags: ['Observability'],
    inputSchema: runConformanceReportInput,
    outputSchema: conformanceReportSchema,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:admin'] } },
    producibleFaults: ['NotFound'],
    discoverable: true,
    transports: conformanceTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<RunConformanceReportOutput> => {
      const run = requireRunner(runner, 'weft.conformance.report').run(input.target);
      if (run === undefined) {
        raiseFault(operation, {
          code: 'NotFound',
          message: `No conformance target named "${input.target}" is registered on this server`,
          data: { resource: 'conformanceTarget', identifier: input.target },
        });
      }
      return run;
    },
  });
  return operation;
}

/** Default discovery-only operations; live servers wire a runner through `createLiveOperationRegistry`. */
export const listConformanceTargetsOperation = createListConformanceTargetsOperation();
export const runConformanceReportOperation = createRunConformanceReportOperation();

/** REST binding for `weft.conformance.targets`: `GET /v1/conformance/targets`. */
export const listConformanceTargetsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/conformance/targets',
  pathParamNames: [],
  operationName: 'weft.conformance.targets',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};

/**
 * REST binding for `weft.conformance.report`:
 * `POST /v1/conformance/targets/:target/report`. `POST` because each call
 * starts (or joins) a run that spawns worker processes.
 */
export const runConformanceReportRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/conformance/targets/:target/report',
  pathParamNames: ['target'],
  operationName: 'weft.conformance.report',
  inputSources: { target: { kind: 'path', pathParam: 'target' } },
  extractInput: async (_request, pathParams) => ({ target: pathParams['target'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
