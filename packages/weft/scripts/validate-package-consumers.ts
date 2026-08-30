import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRealNodeExecutable } from './lib/resolve-real-node.ts';

const repositoryPath = join(import.meta.dir, '..');
const packageName = '@lostgradient/weft';
const textDecoder = new TextDecoder();

type PackResult = {
  filename: string;
};

function commandOutput(output: Uint8Array): string {
  return textDecoder.decode(output).trim();
}

function createSubprocessEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  // process.env's index signature is `string | undefined` (a key can be
  // present-but-unset), which is not assignable to Bun.spawnSync's expected
  // `Record<string, string>` env type. Filter undefined values explicitly
  // instead of asserting the type away.
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    environment[key] = value;
  }
  delete environment['npm_config_dry_run'];
  delete environment['npm_config_dry_run_'];
  return environment;
}

function runCommand(
  label: string,
  command: string[],
  cwd: string,
  env: Record<string, string> = createSubprocessEnvironment(),
): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  if (result.exitCode === 0) {
    console.log(`✓ ${label}`);
    return;
  }

  const stdout = commandOutput(result.stdout);
  const stderr = commandOutput(result.stderr);
  throw new Error(
    [
      `${label} failed with exit ${result.exitCode}`,
      `command: ${command.join(' ')}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function packPackage(packDirectory: string): string {
  const result = Bun.spawnSync(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    {
      cwd: repositoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: createSubprocessEnvironment({ npm_config_loglevel: 'silent' }),
    },
  );
  const stdout = commandOutput(result.stdout);
  const stderr = commandOutput(result.stderr);

  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed with exit ${result.exitCode}\n${stderr}\n${stdout}`.trim());
  }

  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned an unexpected shape: ${stdout}`);
  }
  const packResult = parsed[0] as PackResult;
  const tarballPath = join(packDirectory, packResult.filename);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported ${tarballPath}, but the tarball was not created`);
  }
  return tarballPath;
}

async function createConsumerProject(
  consumerDirectory: string,
  tarballPath: string,
): Promise<void> {
  mkdirSync(consumerDirectory, { recursive: true });
  await Bun.write(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [packageName]: `file:${tarballPath}`,
        },
        devDependencies: {
          '@types/bun': '1.3.13',
          typescript: '5.9.3',
        },
      },
      null,
      2,
    )}\n`,
  );
  runCommand(
    'install packed package with npm in consumer fixture',
    ['npm', 'install', '--ignore-scripts'],
    consumerDirectory,
  );
}

async function runBunConsumerSmoke(consumerDirectory: string): Promise<void> {
  const script = [
    `import { Engine, LocalClient, MemoryStorage, workflow } from '${packageName}';`,
    `import { WorkflowStartedEvent as RootWorkflowStartedEvent, WorkflowResumedEvent as RootWorkflowResumedEvent, WorkflowCompletedEvent as RootWorkflowCompletedEvent, WorkflowFailedEvent as RootWorkflowFailedEvent, WorkflowCancelledEvent as RootWorkflowCancelledEvent, WorkflowTimedOutEvent as RootWorkflowTimedOutEvent, WorkflowSuspendedEvent as RootWorkflowSuspendedEvent, WorkflowTeardownEvent as RootWorkflowTeardownEvent } from '${packageName}';`,
    `import { isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent } from '${packageName}/client';`,
    `import { TestEngine } from '${packageName}/testing';`,
    `import * as storage from '${packageName}/storage';`,
    `import { runBasicStorageContract } from '${packageName}/storage/testing';`,
    `import { SQLiteStorage } from '${packageName}/storage/sqlite';`,
    `import { createFetchHandler } from '${packageName}/service-worker';`,
    `import { TaskQueue, WorkerRegistry } from '${packageName}/server';`,
    `import { parseWorkerToServerMessage } from '${packageName}/worker-protocol';`,
    `import { createMcpSessionManager } from '${packageName}/mcp';`,
    `import { createObservabilityInterceptors } from '${packageName}/observability';`,
    `import { validateStandardSchema } from '${packageName}/json-schema';`,
    'for (const value of [Engine, MemoryStorage, workflow, LocalClient, isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent, TestEngine, storage.MemoryStorage, runBasicStorageContract, SQLiteStorage, createFetchHandler, TaskQueue, WorkerRegistry, parseWorkerToServerMessage, createMcpSessionManager, createObservabilityInterceptors, validateStandardSchema]) {',
    "  if (value === undefined) throw new Error('missing Bun consumer export');",
    '}',
    "if (!isFaultCode('NotFound')) throw new Error('expected client isFaultCode export to recognize NotFound');",
    "if (WorkflowStartedEvent.type !== 'workflow:started' || WorkflowResumedEvent.type !== 'workflow:resumed' || WorkflowCompletedEvent.type !== 'workflow:completed' || WorkflowFailedEvent.type !== 'workflow:failed' || WorkflowCancelledEvent.type !== 'workflow:cancelled' || WorkflowTimedOutEvent.type !== 'workflow:timed-out' || WorkflowSuspendedEvent.type !== 'workflow:suspended' || WorkflowTeardownEvent.type !== 'workflow:teardown') throw new Error('unexpected client lifecycle event type');",
    "if (WorkflowStartedEvent !== RootWorkflowStartedEvent || WorkflowResumedEvent !== RootWorkflowResumedEvent || WorkflowCompletedEvent !== RootWorkflowCompletedEvent || WorkflowFailedEvent !== RootWorkflowFailedEvent || WorkflowCancelledEvent !== RootWorkflowCancelledEvent || WorkflowTimedOutEvent !== RootWorkflowTimedOutEvent || WorkflowSuspendedEvent !== RootWorkflowSuspendedEvent || WorkflowTeardownEvent !== RootWorkflowTeardownEvent) throw new Error('expected root and client lifecycle event constructors to be identical');",
    "if (SQLiteStorage.name !== 'BunSQLiteStorage') throw new Error(`expected Bun SQLite export, got ${SQLiteStorage.name}`);",
    'const taskQueue = new TaskQueue();',
    "if (!(taskQueue instanceof TaskQueue)) throw new Error('expected constructable TaskQueue export');",
    'taskQueue[Symbol.dispose]();',
  ].join('\n');
  runCommand(
    'Bun consumer imports public package surface',
    [process.execPath, '--eval', script],
    consumerDirectory,
  );
}

// Regression test for #710: `serve({ engine })` threw "Engine internals not
// initialized" for every consumer of the published 0.11.0 npm package. The
// root `.` export was unbundled (each module a real file), while the
// `./server` subpath was bundled into one minified file that inlined its own
// private copy of `core/engine/internals.ts`'s module-scope WeakMap — so an
// `Engine` built via the root import registered its internals in the ROOT's
// WeakMap, and `serve()` (checking its own, separately-inlined WeakMap) never
// saw it. This must be exercised through the PACKED package exports, not
// source-relative `src/` imports: the internal test suite shares one module
// graph by construction and cannot see a dual-bundle split. `server.stop()`
// and `engine.shutdown()` are awaited and the process exits explicitly so the
// scheduler/timers `serve()` starts don't keep this smoke step alive.
async function runServeEngineSmoke(consumerDirectory: string): Promise<void> {
  const script = [
    `import { Engine, workflow } from '${packageName}';`,
    `import { serve } from '${packageName}/server';`,
    "const wf = workflow({ name: 'ping' }).execute(async function* () { return 'pong'; });",
    'const engine = await Engine.create({ workflows: { ping: wf } });',
    'const server = serve({ engine, port: 0 });',
    'await server.stop();',
    'await engine.shutdown();',
    'process.exit(0);',
  ].join('\n');
  runCommand(
    'Bun consumer: serve({ engine }) does not throw (#710 regression)',
    [process.execPath, '--eval', script],
    consumerDirectory,
  );
}

// Regression test for the CLI-specific instance of the #710 bug class
// (Codex review on PR #716, "Keep CLI bins on the shared singleton graph").
// `weft serve --workflows <path>` constructs its own `Engine`, then
// dynamically `import()`s the caller's own workflow module — and that
// module, in real usage, imports `workflow`/`registerSerializer` from the
// root `@lostgradient/weft` package, a genuinely separate module resolution
// (via node_modules) from wherever the CLI binary's own code lives. If
// `dist/cli-main.js` were bundled, it would carry its own disconnected copy
// of `core/codec/serializer-registry.ts`'s registries: a serializer the
// dynamically-imported workflow module registers via the root import would
// be invisible to the CLI's own Engine when it encodes/decodes checkpoints —
// the same #710 bug, reproduced inside one process instead of across a
// library import boundary.
//
// The primary, deterministic proof that this cannot happen is structural:
// `bun run build`'s `assertSingletonModulesNotDuplicated()` guard fails if
// dist/cli-main.js or dist/mcp/cli.js contain their own copy of any
// singleton marker at all (they no longer do — see scripts/build.ts and
// scripts/lib/build-guards.ts). This test is a complementary, live
// end-to-end check: it runs the actual packed `weft` bin against a real
// dynamically-loaded workflow module that imports `registerSerializer` from
// the packed root export, starts a workflow, and confirms the whole
// pipeline — dynamic import, engine construction, workflow registration,
// serve() — completes without error. (A silent registry mismatch degrades
// custom-serialized data rather than throwing, per `registerSerializer`'s
// own docs on the generic Error/structured-clone fallback, so this
// integration run is a real-world smoke check on top of the structural
// guard above, not a substitute for it. It already caught two genuine
// defects during development: a stripped shebang and a missing packaged
// JSON asset, both only reachable by actually executing the built binary.)
async function runCliServeSharesRootSingletonsWithDynamicWorkflowModuleSmoke(
  consumerDirectory: string,
): Promise<void> {
  const workflowModulePath = join(consumerDirectory, 'cli-singleton-workflow.ts');
  await Bun.write(
    workflowModulePath,
    [
      `import { registerSerializer, workflow } from '${packageName}';`,
      '',
      'class TaggedFailure extends Error {',
      '  constructor(readonly proofTag: string) {',
      "    super('tagged failure');",
      "    this.name = 'TaggedFailure';",
      '  }',
      '}',
      '',
      'registerSerializer(',
      '  TaggedFailure,',
      '  {',
      '    toJSON: (error) => ({ proofTag: error.proofTag }),',
      '    fromJSON: (data) => new TaggedFailure((data as { proofTag: string }).proofTag),',
      '  },',
      "  { tag: 'TaggedFailure' },",
      ');',
      '',
      "export const cliSingletonProof = workflow({ name: 'cli-singleton-proof' }).execute(",
      '  async function* () {',
      "    return 'ok';",
      '  },',
      ');',
    ].join('\n'),
  );

  const cliBinaryPath = join(consumerDirectory, 'node_modules', '.bin', 'weft');
  const server = Bun.spawn({
    cmd: [cliBinaryPath, 'serve', '--workflows', workflowModulePath, '--port', '0'],
    cwd: consumerDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: createSubprocessEnvironment(),
  });

  const STARTUP_TIMEOUT_MS = 15_000;
  const stderrDrain = new Response(server.stderr as ReadableStream<Uint8Array>).text();

  try {
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let baseUrl: string | undefined;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    try {
      while (baseUrl === undefined) {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (remainingMs === 0) break;
        const readResult = await Promise.race([
          reader.read(),
          Bun.sleep(remainingMs).then(() => 'timeout' as const),
        ]);
        if (readResult === 'timeout' || readResult.done) break;
        buffered += decoder.decode(readResult.value, { stream: true });
        const match = /Weft API running at (\S+)\/api\/v1/.exec(buffered);
        if (match?.[1] !== undefined) baseUrl = match[1];
      }
    } finally {
      reader.releaseLock();
    }

    if (baseUrl === undefined) {
      throw new Error(
        `weft serve (with a dynamically-imported registerSerializer workflow module) did not ` +
          `announce readiness within ${STARTUP_TIMEOUT_MS}ms.\nstdout:\n${buffered}`,
      );
    }

    const startResponse = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.start',
        params: { type: 'cli-singleton-proof', input: undefined },
      }),
    });
    const startBody = (await startResponse.json()) as {
      result?: { id?: string };
      error?: unknown;
    };
    if (startBody.error !== undefined || typeof startBody.result?.id !== 'string') {
      throw new Error(`weft.workflows.start failed: ${JSON.stringify(startBody)}`);
    }
    const workflowId = startBody.result.id;

    const resultDeadline = Date.now() + 10_000;
    let finalStatus: string | undefined;
    while (Date.now() < resultDeadline) {
      const getResponse = await fetch(`${baseUrl}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'weft.workflows.get',
          params: { workflowId },
        }),
      });
      const getBody = (await getResponse.json()) as {
        result?: { status?: string };
        error?: unknown;
      };
      if (getBody.error !== undefined) {
        throw new Error(`weft.workflows.get failed: ${JSON.stringify(getBody)}`);
      }
      if (getBody.result?.status === 'completed' || getBody.result?.status === 'failed') {
        finalStatus = getBody.result.status;
        break;
      }
      await Bun.sleep(150);
    }

    if (finalStatus !== 'completed') {
      throw new Error(
        `Workflow did not reach 'completed' within 10s (last status: ${finalStatus ?? 'unknown'})`,
      );
    }
  } finally {
    server.kill('SIGTERM');
    await Promise.race([server.exited, Bun.sleep(5_000)]);
  }

  // Checked after the `finally` cleanup (rather than inside it) so this
  // assertion can never mask an exception already in flight from the `try`
  // block above.
  const stderrText = await stderrDrain.catch(() => '');
  if (/internals not initialized/i.test(stderrText)) {
    throw new Error(`weft serve crashed with the #710 error class:\n${stderrText}`);
  }

  console.log(
    '✓ weft serve CLI + dynamically-imported workflow module share root singleton state (#710 CLI regression)',
  );
}

async function runNodeConsumerSmoke(consumerDirectory: string): Promise<void> {
  const resolvedNode = resolveRealNodeExecutable(createSubprocessEnvironment(), consumerDirectory);
  if (resolvedNode === null) {
    throw new Error('validate-package-consumers requires a real node executable on PATH');
  }
  const { executable: nodeExecutable, env: nodeEnv } = resolvedNode;
  const script = [
    `import { Engine, MemoryStorage, WorkflowStartedEvent as RootWorkflowStartedEvent, WorkflowResumedEvent as RootWorkflowResumedEvent, WorkflowCompletedEvent as RootWorkflowCompletedEvent, WorkflowFailedEvent as RootWorkflowFailedEvent, WorkflowCancelledEvent as RootWorkflowCancelledEvent, WorkflowTimedOutEvent as RootWorkflowTimedOutEvent, WorkflowSuspendedEvent as RootWorkflowSuspendedEvent, WorkflowTeardownEvent as RootWorkflowTeardownEvent } from '${packageName}';`,
    `import { HttpClient, isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent } from '${packageName}/client';`,
    `import { MemoryStorage as SubpathMemoryStorage } from '${packageName}/storage/memory';`,
    `import { SQLiteStorage } from '${packageName}/storage/sqlite';`,
    `import { handleRequest } from '${packageName}/server/handler';`,
    `import { parseWorkerToServerMessage } from '${packageName}/worker-protocol';`,
    'for (const value of [Engine, MemoryStorage, HttpClient, isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent, SubpathMemoryStorage, SQLiteStorage, handleRequest, parseWorkerToServerMessage]) {',
    "  if (value === undefined) throw new Error('missing Node consumer export');",
    '}',
    "if (!isFaultCode('NotFound')) throw new Error('expected client isFaultCode export to recognize NotFound');",
    "if (WorkflowStartedEvent.type !== 'workflow:started' || WorkflowResumedEvent.type !== 'workflow:resumed' || WorkflowCompletedEvent.type !== 'workflow:completed' || WorkflowFailedEvent.type !== 'workflow:failed' || WorkflowCancelledEvent.type !== 'workflow:cancelled' || WorkflowTimedOutEvent.type !== 'workflow:timed-out' || WorkflowSuspendedEvent.type !== 'workflow:suspended' || WorkflowTeardownEvent.type !== 'workflow:teardown') throw new Error('unexpected client lifecycle event type');",
    "if (WorkflowStartedEvent !== RootWorkflowStartedEvent || WorkflowResumedEvent !== RootWorkflowResumedEvent || WorkflowCompletedEvent !== RootWorkflowCompletedEvent || WorkflowFailedEvent !== RootWorkflowFailedEvent || WorkflowCancelledEvent !== RootWorkflowCancelledEvent || WorkflowTimedOutEvent !== RootWorkflowTimedOutEvent || WorkflowSuspendedEvent !== RootWorkflowSuspendedEvent || WorkflowTeardownEvent !== RootWorkflowTeardownEvent) throw new Error('expected root and client lifecycle event constructors to be identical');",
    "if (SQLiteStorage.name !== 'NodeSQLiteStorage') throw new Error(`expected Node SQLite export, got ${SQLiteStorage.name}`);",
  ].join('\n');
  runCommand(
    'Node.js consumer imports portable public package surface',
    [nodeExecutable, '--input-type=module', '--eval', script],
    consumerDirectory,
    nodeEnv,
  );
}

async function runBrowserBundleSmoke(consumerDirectory: string): Promise<void> {
  const entrypoint = join(consumerDirectory, 'browser-entry.ts');
  const outdir = join(consumerDirectory, 'browser-out');
  await Bun.write(
    entrypoint,
    [
      `import { HttpClient, isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent } from '${packageName}/client';`,
      `import { createFetchHandler } from '${packageName}/service-worker';`,
      `import { IndexedDBStorage } from '${packageName}/storage/indexeddb';`,
      `import { HTTPStorage } from '${packageName}/storage/http';`,
      `import { handleRequest } from '${packageName}/server/handler';`,
      'export { HttpClient, isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent, createFetchHandler, IndexedDBStorage, HTTPStorage, handleRequest };',
    ].join('\n'),
  );

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: 'browser',
    format: 'esm',
    minify: true,
  });

  if (!result.success) {
    throw new Error(
      `browser consumer bundle failed:\n${result.logs.map((log) => log.message).join('\n')}`,
    );
  }

  const bundleOutputs = await Promise.all(result.outputs.map((output) => output.text()));
  const bundleText = bundleOutputs.join('\n');
  const staticRuntimeImportPattern =
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(?:bun:|node:)[^"']+\1/g;
  const staticRuntimeImports = [...bundleText.matchAll(staticRuntimeImportPattern)].map(
    (match) => match[0],
  );
  if (staticRuntimeImports.length > 0) {
    throw new Error(
      `browser consumer bundle statically imports Bun/Node modules: ${staticRuntimeImports.join(', ')}`,
    );
  }

  const forbiddenTokens = ['BunSQLiteStorage', 'NodeSQLiteStorage', 'better-sqlite3'];
  const found = forbiddenTokens.filter((token) => bundleText.includes(token));
  if (found.length > 0) {
    throw new Error(
      `browser consumer bundle contains server-only storage tokens: ${found.join(', ')}`,
    );
  }

  console.log('✓ browser consumer bundle excludes Bun/Node-only storage code');
}

/**
 * Regression coverage for #714: `createEngineEventFeedBackend`,
 * `createWorkflowEventFeed`, and `createFleetEventFeed` are the only public
 * way to build a real, `Engine`-backed feed for `HandlerOptions.workflowEventFeed`
 * / `HandlerOptions.fleetEventFeed` — the documented way to drive
 * `/v1/workflows/:id/events/sse` and `/v1/events/sse` through `handleRequest()`
 * directly, without `serve()`. This drives both SSE routes end to end against
 * the packed, npm-installed `@lostgradient/weft/server/handler` subpath — not
 * a source-relative `src/` import — to prove the published exports actually
 * wire up a working feed.
 */
async function runEventFeedIntegrationSmoke(consumerDirectory: string): Promise<void> {
  const script = [
    `import { Engine, MemoryStorage, workflow } from '${packageName}';`,
    `import {`,
    `  createEngineEventFeedBackend,`,
    `  createFleetEventFeed,`,
    `  createWorkflowEventFeed,`,
    `  handleRequest,`,
    `} from '${packageName}/server/handler';`,
    `import { principalFromApiKey } from '${packageName}/mcp';`,
    '',
    '// `Engine` starts background timers (scheduler polling, retention) that',
    '// keep this `--eval` child process alive, so `Bun.spawnSync` on the parent',
    '// side would otherwise hang forever after `main()` returns — dispose it in',
    '// a `finally` block on every exit path.',
    'const READ_TIMEOUT_MS = 10_000;',
    '',
    'async function readWithTimeout(reader, timeoutMs) {',
    '  let timer;',
    '  const timeout = new Promise((_, reject) => {',
    '    timer = setTimeout(',
    '      () => reject(new Error(`SSE read timed out after ${timeoutMs}ms`)),',
    '      timeoutMs,',
    '    );',
    '  });',
    '  try {',
    '    return await Promise.race([reader.read(), timeout]);',
    '  } finally {',
    '    clearTimeout(timer);',
    '  }',
    '}',
    '',
    'async function readSseUntil(response, marker, maxChunks = 20) {',
    '  const reader = response.body?.getReader();',
    "  if (reader === undefined) throw new Error('expected an SSE response body');",
    '  const decoder = new TextDecoder();',
    "  let text = '';",
    '  try {',
    '    for (let i = 0; i < maxChunks; i += 1) {',
    '      const { value, done } = await readWithTimeout(reader, READ_TIMEOUT_MS);',
    '      if (done) break;',
    '      text += decoder.decode(value, { stream: true });',
    '      if (text.includes(marker)) break;',
    '    }',
    '  } finally {',
    '    await reader.cancel();',
    '  }',
    '  return text;',
    '}',
    '',
    'async function main() {',
    '  const engine = new Engine({ storage: new MemoryStorage() });',
    '  try {',
    '    engine.register(',
    "      workflow({ name: 'greet' }).execute(async function* (ctx, input) {",
    '        const greeting = yield* ctx.run(async () => `Hello, ${input.name}!`);',
    '        return greeting;',
    '      }),',
    '    );',
    '',
    "    const handle = await engine.start('greet', { name: 'Ada' });",
    '    await handle.result();',
    '',
    '    const workflowEventFeed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));',
    '    const fleetEventFeed = createFleetEventFeed(engine.storage);',
    '',
    '    const authContext = {',
    "      method: 'api-key',",
    "      principal: principalFromApiKey({ subject: 'consumer', scopes: ['events:read'] }),",
    '    };',
    '',
    '    const workflowResponse = await handleRequest(',
    '      new Request(`http://localhost/v1/workflows/${handle.id}/events/sse`, {',
    "        headers: { Accept: 'text/event-stream' },",
    '      }),',
    '      engine,',
    '      { authContext, workflowEventFeed },',
    '    );',
    '    if (workflowResponse.status !== 200) {',
    '      throw new Error(`workflow events/sse expected 200, got ${workflowResponse.status}`);',
    '    }',
    "    const workflowBody = await readSseUntil(workflowResponse, 'workflow:checkpoint');",
    "    if (!workflowBody.includes('workflow:checkpoint')) {",
    "      throw new Error('workflow events/sse missing workflow:checkpoint event: ' + workflowBody);",
    '    }',
    '',
    '    await fleetEventFeed.append({',
    "      kind: 'workflow:completed',",
    '      workflowId: handle.id,',
    '      emittedAtMs: Date.now(),',
    '      payload: { workflowId: handle.id },',
    '    });',
    '',
    '    const fleetResponse = await handleRequest(',
    "      new Request('http://localhost/v1/events/sse', {",
    "        headers: { Accept: 'text/event-stream' },",
    '      }),',
    '      engine,',
    '      { authContext, fleetEventFeed },',
    '    );',
    '    if (fleetResponse.status !== 200) {',
    '      throw new Error(`events/sse expected 200, got ${fleetResponse.status}`);',
    '    }',
    "    const fleetBody = await readSseUntil(fleetResponse, 'workflow:completed');",
    "    if (!fleetBody.includes('workflow:completed')) {",
    "      throw new Error('fleet events/sse missing workflow:completed event: ' + fleetBody);",
    '    }',
    '',
    "    console.log('event feed integration smoke ok');",
    '  } finally {',
    '    await engine[Symbol.asyncDispose]();',
    '  }',
    '}',
    '',
    'await main();',
  ].join('\n');
  runCommand(
    'Bun consumer drives workflow/fleet SSE via handleRequest() with no serve()',
    [process.execPath, '--eval', script],
    consumerDirectory,
  );
}

async function runTypeScriptConsumerSmoke(consumerDirectory: string): Promise<void> {
  await Bun.write(
    join(consumerDirectory, 'consumer.ts'),
    [
      `import type { Engine } from '${packageName}';`,
      `import { isFaultCode, WorkflowStartedEvent, WorkflowResumedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowTimedOutEvent, WorkflowSuspendedEvent, WorkflowTeardownEvent, type FaultCode, type WeftClient } from '${packageName}/client';`,
      `declare module '${packageName}' {`,
      '  interface WorkflowRegistry {',
      '    welcome: { input: { name: string }; output: { greeting: string } };',
      '  }',
      '}',
      'declare const engine: Engine;',
      'declare const client: WeftClient;',
      'declare const unknownCode: unknown;',
      'if (isFaultCode(unknownCode)) {',
      '  const knownCode: FaultCode = unknownCode;',
      '  knownCode.toUpperCase();',
      '}',
      'const lifecycleTypes = [WorkflowStartedEvent.type, WorkflowResumedEvent.type, WorkflowCompletedEvent.type, WorkflowFailedEvent.type, WorkflowCancelledEvent.type, WorkflowTimedOutEvent.type, WorkflowSuspendedEvent.type, WorkflowTeardownEvent.type] as const;',
      'void lifecycleTypes;',
      'async function checkEngine(): Promise<void> {',
      "  const handle = await engine.start('welcome', { name: 'Steve' });",
      '  const output = await handle.result();',
      '  output.greeting.toUpperCase();',
      '}',
      'async function checkClient(): Promise<void> {',
      "  const handle = await client.start('welcome', { name: 'Steve' });",
      '  const output = await handle.result();',
      '  output.greeting.toUpperCase();',
      '}',
      'void checkEngine;',
      'void checkClient;',
    ].join('\n'),
  );
  await Bun.write(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );

  runCommand(
    'TypeScript consumer compiles scoped module augmentation',
    [join(consumerDirectory, 'node_modules/.bin/tsc'), '--noEmit', '-p', 'tsconfig.json'],
    consumerDirectory,
  );
}

async function main(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'weft-package-consumers-'));
  try {
    const tarballPath = packPackage(workingDirectory);
    const consumerDirectory = join(workingDirectory, 'consumer');
    await createConsumerProject(consumerDirectory, tarballPath);
    await runBunConsumerSmoke(consumerDirectory);
    await runServeEngineSmoke(consumerDirectory);
    await runCliServeSharesRootSingletonsWithDynamicWorkflowModuleSmoke(consumerDirectory);
    await runNodeConsumerSmoke(consumerDirectory);
    await runBrowserBundleSmoke(consumerDirectory);
    await runTypeScriptConsumerSmoke(consumerDirectory);
    await runEventFeedIntegrationSmoke(consumerDirectory);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

await main();
