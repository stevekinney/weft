/**
 * Worker registration records the worker's deployment version in the durable
 * catalog (COR-277), on both transports. Without it nothing populated
 * `WorkerDeploymentCatalog`, so `weft.worker.deployments.*` listed no versions.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleWorkerWebSocketMessage } from './websocket-worker.ts';
import { handleWorkerSessionRequest } from './worker-sessions.ts';

class FlakyStorage extends MemoryStorage {
  failing = false;
  override async get(key: string) {
    if (this.failing) throw new Error('storage offline');
    return super.get(key);
  }
}

/** Serves the first read of each key and fails the reads after it, once armed. */
class ReadOnceStorage extends MemoryStorage {
  armed = false;
  readonly #read = new Set<string>();
  /** Start counting reads from now: each key's next read is served, the ones after it fail. */
  arm(): void {
    this.#read.clear();
    this.armed = true;
  }
  override async get(key: string) {
    if (this.armed && this.#read.has(key)) throw new Error('storage offline on the re-read');
    this.#read.add(key);
    return super.get(key);
  }
}

function manifest(
  artifactDigest = 'sha256:artifact-a',
  buildId = 'build-1',
  runtimeVersion?: string,
): WorkerManifest {
  const base = manifestForActivities(['checkout.charge'], {
    deployment: { name: 'billing', buildId, artifactDigest },
  });
  return runtimeVersion === undefined
    ? base
    : { ...base, runtime: { ...base.runtime, version: runtimeVersion } };
}

function setup() {
  const storage = new FlakyStorage();
  const catalog = new WorkerDeploymentCatalog(storage);
  const context = { ...minimalServerContext(), workerDeploymentCatalog: catalog };
  return { storage, catalog, context, options: minimalServeOptions() };
}

type Context = ReturnType<typeof setup>['context'];

interface FakeSocket {
  data: WebSocketData;
  sentMessages: string[];
  readyState: number;
  closeCode?: number;
  terminated: boolean;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  unsubscribe(topic: string): void;
  terminate(): void;
}

function socket(): FakeSocket {
  return {
    data: { pathname: '/v1/tasks/default/stream', connectionType: 'worker', queue: 'default' },
    sentMessages: [],
    readyState: WebSocket.OPEN,
    terminated: false,
    send(message) {
      this.sentMessages.push(message);
    },
    close(code) {
      if (code !== undefined) this.closeCode = code;
    },
    unsubscribe() {},
    terminate() {
      this.terminated = true;
    },
  };
}

/** Registers a WebSocket worker and waits for it to be answered (ack, error, or close). */
async function registerSocket(
  context: Context,
  options: ReturnType<typeof setup>['options'],
  workerId: string,
  workerManifest: WorkerManifest,
): Promise<FakeSocket> {
  const ws = socket();
  handleWorkerWebSocketMessage(
    context,
    options,
    ws as never,
    JSON.stringify({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId,
      manifest: workerManifest,
      concurrency: 2,
    }),
    () => {},
  );
  await waitForCondition(() => ws.sentMessages.length > 0 || ws.closeCode !== undefined, {
    label: 'registration answer',
  });
  return ws;
}

async function registerSession(
  context: Context,
  options: ReturnType<typeof setup>['options'],
  workerManifest: WorkerManifest,
): Promise<Response> {
  const request = new Request('http://127.0.0.1/v1/worker-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: workerManifest }),
  });
  const response = await handleWorkerSessionRequest(
    context,
    options,
    request,
    new URL(request.url),
  );
  if (response === null) throw new Error('expected a registration response');
  return response;
}

function answer(ws: FakeSocket): { type: string; code?: string; acceptedManifestDigest?: string } {
  return JSON.parse(ws.sentMessages[0] ?? '{}');
}

async function versionOf(catalog: WorkerDeploymentCatalog, buildId = 'build-1') {
  return catalog.getVersion('billing', buildId);
}

async function stateOf(catalog: WorkerDeploymentCatalog) {
  const version = await versionOf(catalog);
  return version?.state;
}

async function artifactOf(catalog: WorkerDeploymentCatalog) {
  const version = await versionOf(catalog);
  return version?.artifactDigest;
}

describe.each([
  ['WebSocket', 'websocket'],
  ['HTTP long-poll', 'long-poll'],
] as const)('registration records the version — %s', (_label, transport) => {
  /** Registers one worker on this transport; resolves to whether it was accepted. */
  async function register(
    env: ReturnType<typeof setup>,
    workerManifest: WorkerManifest,
    workerId = `worker-${Math.random()}`,
  ): Promise<{ accepted: boolean; digest?: string; detail: string }> {
    if (transport === 'websocket') {
      const ws = await registerSocket(env.context, env.options, workerId, workerManifest);
      const message = answer(ws);
      return {
        accepted: message.type === 'registerAck',
        ...(message.acceptedManifestDigest === undefined
          ? {}
          : { digest: message.acceptedManifestDigest }),
        detail: message.code ?? String(ws.closeCode ?? ''),
      };
    }
    const response = await registerSession(env.context, env.options, workerManifest);
    const body = (await response.json()) as { acceptedManifestDigest?: string; code?: string };
    return {
      accepted: response.status === 200,
      ...(body.acceptedManifestDigest === undefined ? {} : { digest: body.acceptedManifestDigest }),
      detail: body.code ?? String(response.status),
    };
  }

  it('records an accepted worker’s build as a ready version with the digests it registered', async () => {
    const env = setup();
    const result = await register(env, manifest());
    expect(result.accepted).toBe(true);

    const stored = await versionOf(env.catalog);
    expect(stored).toMatchObject({
      deploymentName: 'billing',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact-a',
      manifestDigest: result.digest,
      state: 'ready',
    });
    expect(stored?.firstSeenAt).toBeGreaterThan(0);
    expect(stored?.manifest.deployment).toEqual(manifest().deployment);
  });

  it('is idempotent: another worker, or a reconnect, of the same build leaves the version untouched', async () => {
    const env = setup();
    await register(env, manifest(), 'worker-1');
    const first = await versionOf(env.catalog);

    await register(env, manifest(), 'worker-2');
    await register(env, manifest(), 'worker-1');

    expect(await versionOf(env.catalog)).toEqual(first);
    expect(await env.catalog.listVersions()).toHaveLength(1);
  });

  it.each(['draining', 'removed'] as const)(
    'never moves a %s version back to ready',
    async (state) => {
      const env = setup();
      await register(env, manifest(), 'worker-1');
      await env.catalog.setVersionState('billing', 'build-1', 'draining');
      if (state === 'removed') await env.catalog.removeVersion('billing', 'build-1');

      const result = await register(env, manifest(), 'worker-2');

      expect(result.accepted).toBe(true);
      expect(await stateOf(env.catalog)).toBe(state);
    },
  );

  it('accepts a second worker of the same build and artifact on another runtime version, keeping the first-seen manifest', async () => {
    const env = setup();
    const first = await register(
      env,
      manifest('sha256:artifact-a', 'build-1', '1.3.14'),
      'worker-1',
    );
    const stored = await versionOf(env.catalog);

    const second = await register(
      env,
      manifest('sha256:artifact-a', 'build-1', '1.4.2'),
      'worker-2',
    );

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    // Identity is the artifact digest: the worker is told its own manifest digest, the record stays first-seen.
    expect(second.digest).not.toBe(first.digest);
    expect(await versionOf(env.catalog)).toEqual(stored);
    expect(await env.catalog.listVersions()).toHaveLength(1);
  });

  it('still refuses a different artifact for the stored build', async () => {
    const env = setup();
    await register(env, manifest('sha256:artifact-a', 'build-1', '1.3.14'), 'worker-1');
    // A restarted server has no in-memory digest record; only the catalog remembers the artifact.
    const restarted = {
      ...env,
      context: { ...minimalServerContext(), workerDeploymentCatalog: env.catalog },
    };
    const result = await register(restarted, manifest('sha256:artifact-b', 'build-1'), 'worker-2');
    expect(result.accepted).toBe(false);
    expect(result.detail).toBe('deployment_conflict');
    expect(await artifactOf(env.catalog)).toBe('sha256:artifact-a');
  });

  it.each(['draining', 'removed'] as const)(
    'admits a worker of a %s build but takes it out of untargeted routing',
    async (state) => {
      const env = setup();
      await register(env, manifest(), 'worker-1');
      await env.catalog.setVersionState('billing', 'build-1', 'draining');
      if (state === 'removed') await env.catalog.removeVersion('billing', 'build-1');
      // A restarted server has no drain marker in memory; only the catalog remembers.
      const restarted = {
        ...env,
        context: { ...minimalServerContext(), workerDeploymentCatalog: env.catalog },
      };

      const result = await register(restarted, manifest(), 'worker-2');

      expect(result.accepted).toBe(true);
      expect(restarted.context.registry.size).toBe(1);
      expect(
        restarted.context.registry.findWorker('checkout.charge', { queue: 'default' }),
      ).toBeUndefined();
      expect(restarted.context.registry.getDeploymentSummaries(1)[0]?.health).not.toBe('active');
      expect(await stateOf(env.catalog)).toBe(state);
    },
  );

  it('a ready build registers as routable', async () => {
    const env = setup();
    await register(env, manifest(), 'worker-1');
    expect(env.context.registry.findWorker('checkout.charge', { queue: 'default' })).toBeDefined();
  });

  it('two workers of one new build registering at once produce one version', async () => {
    const env = setup();
    const results = await Promise.all([
      register(env, manifest(), 'worker-a'),
      register(env, manifest(), 'worker-b'),
      register(env, manifest(), 'worker-c'),
    ]);
    expect(results.every((result) => result.accepted)).toBe(true);
    const versions = await env.catalog.listVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.state).toBe('ready');
  });

  it('refuses a conflicting artifact digest from a connected worker first, and writes nothing', async () => {
    const env = setup();
    await register(env, manifest('sha256:artifact-a'), 'worker-1');
    const before = await env.storage.get('worker-deployment-version:billing:build-1');

    const conflicting = await register(env, manifest('sha256:artifact-b'), 'worker-2');

    expect(conflicting.accepted).toBe(false);
    expect(conflicting.detail).toBe('deployment_conflict');
    expect(await env.storage.get('worker-deployment-version:billing:build-1')).toEqual(before);
    expect(await artifactOf(env.catalog)).toBe('sha256:artifact-a');
  });

  it('refuses a build whose digests differ from the stored version, with nothing connected, as a conflict', async () => {
    const env = setup();
    // A previous run of the server recorded this build; this process has no connected worker for it.
    await env.catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact-old',
      manifestDigest: 'sha256:manifest-old',
      manifest: manifest('sha256:artifact-old'),
      state: 'ready',
      firstSeenAt: 1,
    });

    const result = await register(env, manifest('sha256:artifact-new'), 'worker-1');

    expect(result.accepted).toBe(false);
    expect(result.detail).toBe('deployment_conflict');
    expect(env.context.registry.size).toBe(0);
    expect(await artifactOf(env.catalog)).toBe('sha256:artifact-old');
  });

  it('refuses a registration the catalog cannot record, retryably, accepting no worker', async () => {
    const env = setup();
    env.storage.failing = true;
    using warning = spyOn(console, 'warn').mockImplementation(() => {});

    const result = await register(env, manifest(), 'worker-1');

    expect(result.accepted).toBe(false);
    // WebSocket: closed with 1013 (Try Again Later). Long-poll: 503 `catalog_unavailable` with Retry-After.
    expect(result.detail).toBe(transport === 'websocket' ? '1013' : 'catalog_unavailable');
    expect(env.context.registry.size).toBe(0);
    expect(warning).toHaveBeenCalled();

    // The catalog recovers and the same worker's retry is accepted.
    env.storage.failing = false;
    const retried = await register(env, manifest(), 'worker-1');
    expect(retried.accepted).toBe(true);
    expect(await versionOf(env.catalog)).not.toBeNull();
  });

  it('refuses retryably when the catalog fails while re-reading a conflicting version', async () => {
    const storage = new ReadOnceStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    const env = {
      storage,
      catalog,
      context: { ...minimalServerContext(), workerDeploymentCatalog: catalog },
      options: minimalServeOptions(),
    };
    // The stored version has the same artifact but another manifest digest, so `registerVersion`
    // reports a conflict and registration must read the stored version back to decide.
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact-a',
      manifestDigest: 'sha256:manifest-first-seen',
      manifest: manifest(),
      state: 'ready',
      firstSeenAt: 1,
    });
    storage.arm();
    using warning = spyOn(console, 'warn').mockImplementation(() => {});

    const result = await register(env as never, manifest(), 'worker-1');

    expect(result.accepted).toBe(false);
    expect(result.detail).toBe(transport === 'websocket' ? '1013' : 'catalog_unavailable');
    expect(env.context.registry.size).toBe(0);
    expect(warning).toHaveBeenCalled();
  });

  it('registers without a catalog on a hand-built context', async () => {
    const env = setup();
    const bare = { ...env, context: minimalServerContext() };
    const result = await register(bare as never, manifest(), 'worker-1');
    expect(result.accepted).toBe(true);
  });
});

describe('long-poll catalog failure carries Retry-After', () => {
  it('answers 503 with a retry hint', async () => {
    const env = setup();
    env.storage.failing = true;
    using warning = spyOn(console, 'warn').mockImplementation(() => {});
    const response = await registerSession(env.context, env.options, manifest());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(warning).toHaveBeenCalled();
  });
});

describe('WebSocket: a refused registration records nothing', () => {
  it('does not record the build of a socket that tries to take over a live worker id', async () => {
    const env = setup();
    const live = await registerSocket(env.context, env.options, 'W1', manifest());
    expect(answer(live).type).toBe('registerAck');
    env.context.workerSockets.set('W1', live as never);

    const hijack = await registerSocket(
      env.context,
      env.options,
      'W1',
      manifest('sha256:X', 'build-2'),
    );

    expect(answer(hijack).code).toBe('invalid_registration');
    // The rejected socket is terminated by a short timer; let it fire so none outlives the test.
    await waitForCondition(() => hijack.terminated, {
      label: 'socket terminated',
    });
    expect(await env.catalog.getVersion('billing', 'build-2')).toBeNull();

    // The legitimate build-2, with its own digest, then registers.
    const legitimate = await registerSocket(
      env.context,
      env.options,
      'W2',
      manifest('sha256:Y', 'build-2'),
    );
    expect(answer(legitimate).type).toBe('registerAck');
    const recorded = await env.catalog.getVersion('billing', 'build-2');
    expect(recorded?.artifactDigest).toBe('sha256:Y');
  });
});

/** Holds the first read of any key until released, so one registration can be paused mid-write. */
class FirstReadGatedStorage extends MemoryStorage {
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  armed = false;

  override async get(key: string) {
    if (this.armed && this.#gate === undefined) {
      this.#gate = new Promise<void>((resolve) => {
        this.#release = resolve;
      });
      await this.#gate;
    }
    return super.get(key);
  }

  release(): void {
    this.#release?.();
  }

  get held(): boolean {
    return this.#gate !== undefined;
  }
}

describe('WebSocket: a worker id taken while a registration is writing the catalog', () => {
  it('is refused at the final commit, which re-checks what the read-only gate saw', async () => {
    const storage = new FirstReadGatedStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    const env = {
      storage,
      catalog,
      context: { ...minimalServerContext(), workerDeploymentCatalog: catalog },
      options: minimalServeOptions(),
    };
    storage.armed = true;

    // The first registration passes the read-only gate, then pauses inside the catalog write.
    const paused = registerSocket(env.context, env.options, 'W1', manifest());
    await waitForCondition(() => storage.held, { label: 'the write paused' });
    // A second socket takes the id while it is paused (its own catalog read is not held).
    const winner = await registerSocket(env.context, env.options, 'W1', manifest());
    expect(answer(winner).type).toBe('registerAck');

    storage.release();
    const loser = await paused;

    expect(answer(loser).code).toBe('invalid_registration');
    expect(env.context.registry.size).toBe(1);
    await waitForCondition(() => loser.terminated, {
      label: 'the refused socket terminated',
    });
  });
});

/** Runs a hook once, at the first read of a version record, so a test can act mid-write. */
class VersionReadHookStorage extends MemoryStorage {
  hook: (() => Promise<void>) | undefined;
  override async get(key: string) {
    if (key.startsWith('worker-deployment-version:') && this.hook !== undefined) {
      const hook = this.hook;
      this.hook = undefined;
      await hook();
    }
    return super.get(key);
  }
}

describe('WebSocket: a proven reconnect whose grace window closes during the catalog write', () => {
  async function reconnect(timerFiresDuringWrite: boolean) {
    const storage = new VersionReadHookStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    const context = { ...minimalServerContext(), workerDeploymentCatalog: catalog };
    const options = minimalServeOptions();

    const first = await registerSocket(context, options, 'W1', manifest());
    expect(answer(first).type).toBe('registerAck');
    context.workerSockets.set('W1', first as never);
    context.registry.assignTask('W1', 'op-1', 30_000, undefined, 'attempt-1');
    const generation = context.registry.sessionIdentity('W1')?.sessionGeneration;

    // The first socket drops: the grace window is armed and the session and its task stay.
    const timer = setTimeout(() => {}, 60_000);
    context.pendingWorkerRequeues.set('W1', { timer, endsAt: Date.now() + 60_000 });
    if (timerFiresDuringWrite) {
      storage.hook = async () => {
        // The first thing the grace timer does when it fires: forget the window. The proof is a
        // claim about a window that no longer exists once this has run.
        context.pendingWorkerRequeues.delete('W1');
        context.workerSockets.delete('W1');
      };
    }

    const second = socket();
    handleWorkerWebSocketMessage(
      context,
      options,
      second as never,
      JSON.stringify({
        type: 'register',
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        workerId: 'W1',
        manifest: manifest(),
        concurrency: 2,
        resumeSessionGeneration: generation,
      }),
      () => {},
    );
    await waitForCondition(() => second.sentMessages.length > 0, {
      label: 'the reconnect answer',
    });
    clearTimeout(timer);
    const leftover = context.pendingWorkerRequeues.get('W1');
    if (leftover !== undefined) clearTimeout(leftover.timer);
    const reply = JSON.parse(second.sentMessages[0] ?? '{}') as {
      type: string;
      sessionGeneration?: number;
    };
    return {
      reply,
      generation,
      inFlight: context.registry.getWorkerTasks('W1').length,
    };
  }

  it('control: with no race the resume is honored and the in-flight attempt is kept', async () => {
    const result = await reconnect(false);
    expect(result.reply.type).toBe('registerAck');
    expect(result.reply.sessionGeneration).toBe(result.generation);
    expect(result.inFlight).toBe(1);
  });

  it('does not acknowledge a resume once the grace window is gone, because the proof is taken last', async () => {
    const result = await reconnect(true);
    expect(result.reply.type).toBe('registerAck');
    // The window closed during the catalog write. Had the proof been taken before the write, the
    // commit would still honor it and keep the old generation; taken after, it is a new session.
    expect(result.reply.sessionGeneration).toBe((result.generation ?? 0) + 1);
  });
});
