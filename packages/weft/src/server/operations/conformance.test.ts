/**
 * `weft.conformance.targets` / `weft.conformance.report` — the server-side
 * counterpart of `cli/cli-conformance.test.ts` and
 * `cli/conformance-command.test.ts` (COR-1365).
 *
 * The passing and failing runs here spawn the same worker fixtures those
 * suites do, through the same `runConformanceReport`, so a fixture that
 * passes the CLI and fails the operation (or the reverse) is a defect in the
 * shared check sequence, not in either surface. The parity test asserts that
 * directly: the CLI's JSON report and the operation's report agree on every
 * field the CLI prints.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeConformance } from '../../cli/conformance.ts';
import { createWeftClient } from '../../client/generated/operation-client.generated.ts';
import { createConformanceTargetRunner } from '../../conformance/targets.ts';
import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createConformanceTargets } from '../../testing/conformance-targets.ts';
import { outcomeOf, rethrow } from '../../testing/module-scope-scenario.test-support.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../worker/protocol-version.ts';
import { handleRequest } from '../handler.ts';
import { serve } from '../index.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  createListConformanceTargetsOperation,
  createRunConformanceReportOperation,
  listConformanceTargetsRestBinding,
  runConformanceReportOperation,
  runConformanceReportRestBinding,
  type RunConformanceReportOutput,
} from './conformance.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

const CHECK_NAMES = [
  'register',
  'task completion',
  'heartbeat',
  'cancellation',
  'reconnect',
  'revision echo',
  'graceful shutdown',
];

/**
 * A passing run has to get through all seven checks, each of which waits on a
 * spawned worker process. On a host shared with other agents a subprocess can
 * take seconds just to start, so these generous ceilings keep a correct
 * worker from failing on load alone. They only bound how long a broken run
 * may hang; a healthy run returns as soon as its last check passes.
 */
const PASSING_RUN_TIMEOUT_MS = 10_000;

const ADMIN_KEY = 'conformance-test-admin-key';

function adminAuth() {
  return {
    apiKeys: [ADMIN_KEY],
    defaultApiKeyScopes: ['system:read', 'system:admin'] as const,
    auditSink: () => {},
  };
}

const conformingWorker = ['bun', './src/cli/__fixtures__/conformance-worker.ts'];
const brokenWorker = ['bun', './src/cli/__fixtures__/conformance-broken-worker.ts'];
const hangingReplacementWorker = [
  'bun',
  './src/cli/__fixtures__/conformance-hanging-replacement-worker.ts',
];

function runnerFor(targets: Parameters<typeof createConformanceTargetRunner>[0]) {
  return createConformanceTargetRunner(targets, serve);
}

function adminPrincipal() {
  return principalFromApiKey({ subject: 'test', scopes: ['system:admin'] });
}

async function runReport(target: string, conformanceTargetRunner = runnerFor({})) {
  const engine = createOperationTestEngine();
  try {
    return await executeOperation(
      'weft.conformance.report',
      { target },
      {
        principal: adminPrincipal(),
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([
          createRunConformanceReportOperation({ conformanceTargetRunner }),
        ]),
      },
    );
  } finally {
    engine[Symbol.dispose]();
  }
}

// Each scenario below spawns real worker processes, which take seconds to start on a loaded
// host, so it runs here at module scope, off Bun's five-second per-test clock; its test
// rethrows the outcome.

const passingReport = await outcomeOf(async () => {
  const result = await runReport(
    'reference',
    runnerFor({ reference: { command: conformingWorker, timeoutMs: PASSING_RUN_TIMEOUT_MS } }),
  );

  if (!result.ok) throw new Error(`expected success, got ${result.fault.message}`);
  const report = result.value as RunConformanceReportOutput;
  expect(report.target).toBe('reference');
  expect(report.checks.filter((check) => !check.ok)).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.checks.map((check) => check.name)).toEqual(CHECK_NAMES);
  expect(report.checks.every((check) => check.ok && check.message.length > 0)).toBe(true);
  expect(report.protocolVersion).toBe(REMOTE_WORKER_PROTOCOL_VERSION);
  expect(report.supportedProtocolVersions).toEqual([...REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS]);
  expect(report.completedAt).toBeGreaterThanOrEqual(report.startedAt);
});

const brokenReport = await outcomeOf(async () => {
  const result = await runReport(
    'broken',
    runnerFor({ broken: { command: brokenWorker, timeoutMs: 500 } }),
  );

  if (!result.ok) throw new Error(`expected a report, got ${result.fault.message}`);
  const report = result.value as RunConformanceReportOutput;
  expect(report.ok).toBe(false);
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({ name: 'conformance', ok: false });
  expect(report.checks[0]?.message).toContain('worker register');
});

const cliAgreement = await outcomeOf(async () => {
  const cli = await executeConformance({
    timeoutMs: 500,
    json: true,
    workerCommand: brokenWorker,
  });
  const result = await runReport(
    'broken',
    runnerFor({ broken: { command: brokenWorker, timeoutMs: 500 } }),
  );

  if (!result.ok) throw new Error(`expected a report, got ${result.fault.message}`);
  const { target, startedAt, completedAt, ...report } = result.value as RunConformanceReportOutput;
  void target;
  void startedAt;
  void completedAt;
  expect(cli.exitCode).toBe(1);
  expect(report).toEqual(JSON.parse(cli.stdout));
});

// Regression: every run's sandbox server logged the MCP origin warning into
// the host server's console, once per report request.
const quietSandbox = await outcomeOf(async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await runReport(
      'broken',
      runnerFor({ broken: { command: brokenWorker, timeoutMs: 500 } }),
    );
    expect(result.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

// Regression: the reconnect check's replacement worker was held in a local
// that the run's cleanup never saw, so a replacement that never registered
// kept running after the run reported its failure.
const replacementCleanup = await outcomeOf(async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'weft-conformance-replacement-'));
  const pidFile = join(stateDirectory, 'replacement.pid');
  try {
    const result = await runReport(
      'hanging',
      runnerFor({
        hanging: {
          command: [...hangingReplacementWorker, stateDirectory],
          timeoutMs: PASSING_RUN_TIMEOUT_MS,
        },
      }),
    );

    if (!result.ok) throw new Error(`expected a report, got ${result.fault.message}`);
    const report = result.value as RunConformanceReportOutput;
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)?.message).toContain('replacement worker');
    expect(existsSync(pidFile)).toBe(true);
    expect(isProcessAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  } finally {
    if (existsSync(pidFile)) killIfAlive(Number(readFileSync(pidFile, 'utf8')));
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

const servedTargets = await outcomeOf(async () => {
  const engine = new Engine({ storage: new MemoryStorage() });
  const server = serve({
    engine,
    port: 0,
    hostname: '127.0.0.1',
    auth: adminAuth(),
    trustedHosts: [],
    conformanceTargets: createConformanceTargets({
      reference: { command: conformingWorker, timeoutMs: PASSING_RUN_TIMEOUT_MS },
    }),
  });
  try {
    const client = createWeftClient({
      server: server.url,
      token: ADMIN_KEY,
      includeRunLockfile: false,
    });

    expect(await client['weft.conformance.targets']({})).toEqual({
      targets: [{ name: 'reference', timeoutMs: PASSING_RUN_TIMEOUT_MS }],
    });
    const report = await client['weft.conformance.report']({ target: 'reference' });
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(CHECK_NAMES);
  } finally {
    await server.stop();
    engine[Symbol.dispose]();
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
}

describe('weft.conformance.targets — REST GET /v1/conformance/targets', () => {
  // spawn-free: listing targets reads the runner's resolved names and never starts a run.
  it('lists configured target names and timeouts without revealing commands', async () => {
    const engine = createOperationTestEngine();
    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/conformance/targets', { method: 'GET' }),
        engine,
        {
          operationRegistry: createOperationRegistry([
            createListConformanceTargetsOperation({
              conformanceTargetRunner: runnerFor({
                reference: { command: [...conformingWorker, '--private-flag'], timeoutMs: 3_000 },
              }),
            }),
          ]),
          restBindings: [listConformanceTargetsRestBinding],
          ...systemReadAuthContext(),
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ targets: [{ name: 'reference', timeoutMs: 3_000 }] });
      expect(JSON.stringify(body)).not.toContain('private-flag');
      expect(JSON.stringify(body)).not.toContain('conformance-worker');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('weft.conformance.report — check results', () => {
  it('passes a conforming worker fixture with every named check and protocol metadata', () =>
    rethrow(passingReport));

  it('fails a worker fixture that omits protocolVersion, with a failed check and message', () =>
    rethrow(brokenReport));

  it('agrees with the weft conformance CLI JSON report for the same worker', () =>
    rethrow(cliAgreement));
});

describe('weft.conformance.report — host server output', () => {
  it('runs its sandbox server without logging a startup warning', () => rethrow(quietSandbox));
});

describe('weft.conformance.report — worker cleanup', () => {
  it('stops a replacement worker that never registers', () => rethrow(replacementCleanup));
});

describe('weft.conformance.report — target selection and access', () => {
  // spawn-free: the requested target is not registered, so the runner never starts a run.
  it('answers NotFound over REST for a target the server did not register', async () => {
    const engine = createOperationTestEngine();
    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/conformance/targets/constructor/report', {
          method: 'POST',
        }),
        engine,
        {
          operationRegistry: createOperationRegistry([
            createRunConformanceReportOperation({
              conformanceTargetRunner: runnerFor({ reference: { command: conformingWorker } }),
            }),
          ]),
          restBindings: [runConformanceReportRestBinding],
          authContext: { method: 'api-key', principal: adminPrincipal() },
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'No conformance target named "constructor" is registered on this server',
        data: { resource: 'conformanceTarget', identifier: 'constructor' },
      });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // spawn-free: the scope check rejects the caller before the operation reaches the runner.
  it('rejects a system:read caller: running a target needs system:admin', async () => {
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.conformance.report',
        { target: 'reference' },
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createLiveOperationRegistry({
            conformanceTargetRunner: runnerFor({ reference: { command: conformingWorker } }),
          }),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('Forbidden');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // spawn-free: the runner has no targets, and only the target list is invoked.
  it('rejects unauthenticated and under-scoped callers of the target list', async () => {
    const engine = createOperationTestEngine();
    try {
      const liveRegistry = createLiveOperationRegistry({ conformanceTargetRunner: runnerFor({}) });
      await assertOperationRejectsUnauthenticated({
        operationName: 'weft.conformance.targets',
        engine,
        liveRegistry,
      });
      await assertOperationRejectsInsufficientScope({
        operationName: 'weft.conformance.targets',
        engine,
        liveRegistry,
      });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('throws when invoked from a discovery-only registry (no runner wired in)', async () => {
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.conformance.report',
        { target: 'reference' },
        {
          principal: adminPrincipal(),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([runConformanceReportOperation]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('EngineFailure');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('weft.conformance.* — served through serve() and the generated client', () => {
  it('lists and runs serve({ conformanceTargets }) targets over JSON-RPC HTTP', () =>
    rethrow(servedTargets));

  it('registers no targets when conformanceTargets is omitted', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const server = serve({
      engine,
      port: 0,
      hostname: '127.0.0.1',
      auth: adminAuth(),
      trustedHosts: [],
    });
    try {
      const client = createWeftClient({
        server: server.url,
        token: ADMIN_KEY,
        includeRunLockfile: false,
      });
      expect(await client['weft.conformance.targets']({})).toEqual({ targets: [] });
      expect(
        await throwingRejectionOf(client['weft.conformance.report']({ target: 'reference' })),
      ).toThrow('No conformance target named "reference"');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  // spawn-free: an empty command fails validation before any runner exists.
  it('rejects an invalid target before serve() is ever called', () => {
    expect(() => createConformanceTargets({ reference: { command: [] } })).toThrow(
      'conformanceTargets.reference.command',
    );
  });
});
