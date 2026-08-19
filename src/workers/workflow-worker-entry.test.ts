/**
 * Realm-ready handshake integration test (WFT-28).
 *
 * Spawns the **same** `test-browser-worker.ts` real Bun Worker that
 * `browser-integration.test.ts` uses, verifying the `ready` message
 * `initializeWorkerMessageLoop` now sends before entering its message loop.
 *
 * @module workers/workflow-worker-entry
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { WORKER_PROTOCOL_VERSION } from '../core/worker-protocol.ts';
import type { WorkerRealmReadyMessage } from '../core/worker-realm-readiness.ts';
import { computeWorkerManifestDigest } from '../worker/manifest/index.ts';
import {
  buildInternalRealmManifest,
  INTERNAL_WORKER_REALM_DEPLOYMENT_NAME,
} from '../worker/manifest/internal-realm.ts';

const testWorkerUrl = new URL('./test-browser-worker.ts', import.meta.url);

/** Every workflow type `test-browser-worker.ts` registers. */
const TEST_WORKER_WORKFLOW_TYPES = [
  'simple',
  'infinite-loop',
  'infinite-loop-after-resume',
  'catch-failed-activity-then-wait',
  'with-activity',
  'multi-step',
  'wait-signal-then-complete',
].toSorted();

function waitForFirstMessage(worker: Worker, timeoutMilliseconds = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMilliseconds}ms waiting for the first message`));
    }, timeoutMilliseconds);
    worker.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        clearTimeout(timeout);
        resolve(event.data);
      },
      { once: true },
    );
  });
}

describe('realm-ready handshake', () => {
  let worker: Worker | undefined;
  let secondWorker: Worker | undefined;

  afterEach(() => {
    worker?.terminate();
    worker = undefined;
    secondWorker?.terminate();
    secondWorker = undefined;
  });

  it('sends a ready message before any run/resume/cancel message is processed', async () => {
    worker = new Worker(testWorkerUrl);

    const first = (await waitForFirstMessage(worker)) as WorkerRealmReadyMessage;

    expect(first.type).toBe('ready');
    expect(first.protocolVersion).toBe(WORKER_PROTOCOL_VERSION);
    expect(typeof first.realmGeneration).toBe('string');
    expect(first.realmGeneration.length).toBeGreaterThan(0);
  });

  it('reports a manifest whose workflows match exactly what the worker registered', async () => {
    worker = new Worker(testWorkerUrl);

    const first = (await waitForFirstMessage(worker)) as WorkerRealmReadyMessage;

    expect(Object.keys(first.manifest.workflows).toSorted()).toEqual(TEST_WORKER_WORKFLOW_TYPES);
    expect(first.manifest.deployment.name).toBe(INTERNAL_WORKER_REALM_DEPLOYMENT_NAME);
    expect(first.manifest.deployment.buildId).toBe(first.manifest.deployment.artifactDigest);
  });

  it('produces a manifest digest matching a host-side expectation built from the same workflow types', async () => {
    worker = new Worker(testWorkerUrl);

    const first = (await waitForFirstMessage(worker)) as WorkerRealmReadyMessage;

    const expectedManifest = buildInternalRealmManifest(TEST_WORKER_WORKFLOW_TYPES);
    const [actualDigest, expectedDigest] = await Promise.all([
      computeWorkerManifestDigest(first.manifest),
      computeWorkerManifestDigest(expectedManifest),
    ]);

    expect(actualDigest).toBe(expectedDigest);
  });

  it('generates a fresh realmGeneration per worker instance, independent of manifest identity', async () => {
    worker = new Worker(testWorkerUrl);
    secondWorker = new Worker(testWorkerUrl);

    const [first, second] = (await Promise.all([
      waitForFirstMessage(worker),
      waitForFirstMessage(secondWorker),
    ])) as [WorkerRealmReadyMessage, WorkerRealmReadyMessage];

    expect(first.realmGeneration).not.toBe(second.realmGeneration);

    const [firstDigest, secondDigest] = await Promise.all([
      computeWorkerManifestDigest(first.manifest),
      computeWorkerManifestDigest(second.manifest),
    ]);
    expect(firstDigest).toBe(secondDigest);
  });

  it('still completes a run turn normally after sending ready', async () => {
    worker = new Worker(testWorkerUrl);
    await waitForFirstMessage(worker);

    const completion = new Promise((resolve) => {
      worker!.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
        if (event.data.type === 'completed') resolve(event.data);
      });
    });

    worker.postMessage({
      type: 'run',
      workflowId: 'wf-ready-then-run',
      workflowType: 'simple',
      checkpoint: new ArrayBuffer(0),
      input: { test: 'value' },
    });

    await completion;
  });
});
