import { WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';
/**
 * End-to-end integration tests for `runStdioSession` wired to a real
 * `Engine` instance and the production `createEngineEventFeedBackend`.
 *
 * The four tests prove end-to-end correctness of the engine-backed stdio
 * path — unary JSON-RPC dispatch works against the real engine, stdio
 * correctly rejects subscription operations that are not live on that
 * transport, and rejected attempts tear down cleanly without leaking event
 * listeners or spurious output.
 *
 * These tests are intentionally NOT mocked at the engine level. Using the
 * production `createEngineEventFeedBackend(engine)` is the core point:
 * the in-memory unit tests in `stdio-session.test.ts` already cover
 * pure session logic; these cover the wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createWeftDiscoverDocument } from './weft-documents.ts';

import { runStdioSession } from "../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { HANG_GUARD_MILLISECONDS, afterAwakeTime } from "../../test-support/embedded/testing/src/hang-guard.ts";
import { Engine } from '../core/engine.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import { collectingWritable, readableFromLines } from './stdio-stream.test-support.ts';
import { createWorkflowEventFeed, type WorkflowEventFeed } from './workflow-event-feed.ts';
import {
  waitForStatus as waitForStatusWithTimeout,
  type WaitableWorkflowStatus,
} from './workflow-status.test-support.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  return yield* ctx.waitForSignal<string>('release');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A manually-controlled readable stream. Callers enqueue encoded lines
 * on demand and close the stream when done. Used by subscribe tests so
 * the input stream can stay open while engine commits happen in parallel.
 */
function controllableInput(): {
  stream: ReadableStream<Uint8Array>;
  send(line: string): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  // The Web Streams spec guarantees `start()` runs synchronously inside
  // the `ReadableStream` constructor, so `controller` is always assigned
  // before any `send()` / `close()` call returns. The `!` non-null
  // assertion is safe here — but only because of that constructor
  // contract; do not lift this pattern into production code that might
  // call `send()` from inside `start()` itself.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    send(line: string) {
      if (closed) return;
      controller.enqueue(encoder.encode(line));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}

/**
 * Wait for a collected-output predicate to become true, polling every
 * ~10 ms. Rejects if `timeoutMs` elapses without the predicate returning
 * a truthy value.
 *
 * `startFromIndex` — if provided, only lines at index >= startFromIndex
 * are scanned. Pass `output.lines().length` before an action to assert
 * that nothing matching arrives AFTER that action.
 */
function waitForLine(
  lines: () => string[],
  predicate: (parsed: unknown) => boolean,
  timeoutMs = HANG_GUARD_MILLISECONDS,
  startFromIndex = 0,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // A line that should arrive waits on the awake-time hang guard; a caller that proves one never
    // arrives passes a short window, which a loaded host can only make later, never earlier.
    let hung = false;
    const cancelGuard = afterAwakeTime(timeoutMs, () => {
      hung = true;
    });
    function check() {
      const all = lines();
      for (let i = startFromIndex; i < all.length; i++) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(all[i]!);
        } catch {
          continue;
        }
        if (predicate(parsed)) {
          cancelGuard();
          resolve(parsed);
          return;
        }
      }
      if (hung) {
        reject(new Error('waitForLine timed out'));
        return;
      }
      setTimeout(check, 10);
    }
    check();
  });
}

/**
 * Poll until the engine workflow reaches the target status or timeout elapses.
 * These engine-backed integration tests allow a longer 2s window than the
 * in-process default of the shared helper.
 */
function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WaitableWorkflowStatus,
): Promise<void> {
  return waitForStatusWithTimeout(engine, workflowId, status);
}

// ---------------------------------------------------------------------------
// Fixture: hold-then-release workflow
// ---------------------------------------------------------------------------

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  // Register a workflow that parks on a signal, then completes — this
  // gives us a stable "workflow is running" state for test assertions,
  // and signalling it from the test drives engine commits that the feed
  // can deliver to the stdio subscriber.
  engine.register(holdWorkflow);
  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runStdioSession — engine-backed integration', () => {
  let engine: Engine;
  let feed: WorkflowEventFeed;
  const registry = createLiveOperationRegistry();

  beforeEach(() => {
    engine = createHoldEngine();
    feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
  });

  afterEach(() => {
    feed.dispose();
    engine[Symbol.dispose]();
  });

  /**
   * Send a `weft.workflows.subscribe` request, start a stdio session, and wait
   * for stdio to reject it with `UnsupportedTransport`. Returns the live
   * input/output handles plus the session promise so each test can continue
   * with its own teardown and post-rejection assertions.
   */
  async function startRejectedSubscription(workflowId: string): Promise<{
    input: ReturnType<typeof controllableInput>;
    output: ReturnType<typeof collectingWritable>;
    sessionPromise: ReturnType<typeof runStdioSession>;
  }> {
    const input = controllableInput();
    const output = collectingWritable();

    input.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId, selector: 'events' },
        id: 1,
      }) + '\n',
    );

    const sessionPromise = runStdioSession({
      scopeVocabulary: WEFT_SCOPE_VOCABULARY,
      input: input.stream,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      discoverDocument: createWeftDiscoverDocument(registry, engine),
      feed,
    });

    const subscribeResponse = (await waitForLine(
      output.lines.bind(output),
      (parsed: any) => parsed?.id === 1 && parsed?.error?.data?.weftCode === 'UnsupportedTransport',
    )) as any;
    expect(subscribeResponse.error.code).toBe(-32030);

    return { input, output, sessionPromise };
  }

  it('test 1: dispatches a non-subscription operation against the real engine', async () => {
    // Start a workflow, then ask the real engine for its state via stdio.
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
        id: 1,
      }) + '\n',
    ]);
    const output = collectingWritable();

    const result = await runStdioSession({
      scopeVocabulary: WEFT_SCOPE_VOCABULARY,
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      discoverDocument: createWeftDiscoverDocument(registry, engine),
      feed,
    });

    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const response = JSON.parse(lines[0]!);
    expect(response.result.id).toBe(handle.id);
    expect(response.result.status).toBe('running');
  });

  it('test 2: rejects event subscriptions over stdio with UnsupportedTransport', async () => {
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: handle.id, selector: 'events' },
        id: 1,
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      scopeVocabulary: WEFT_SCOPE_VOCABULARY,
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      discoverDocument: createWeftDiscoverDocument(registry, engine),
      feed,
    });

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.id).toBe(1);
    expect(response.error.code).toBe(-32030);
    expect(response.error.data.weftCode).toBe('UnsupportedTransport');
  });

  it('test 3: rejected stdio subscriptions do not emit deliver notifications after engine commits', async () => {
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    const { input, output, sessionPromise } = await startRejectedSubscription(handle.id);

    try {
      const lineCountAfterRejectedSubscribe = output.lines().length;

      // Signal the engine and complete the workflow. A rejected subscribe
      // MUST NOT leave any active listener behind that would forward
      // weft.events.deliver notifications to this session.
      await engine.signal(handle.id, 'release', 'done');
      await waitForStatus(engine, handle.id, 'completed');

      function findPostRejectDeliver(): unknown {
        for (const line of output.lines().slice(lineCountAfterRejectedSubscribe)) {
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed?.method === 'weft.events.deliver') return parsed;
        }
        return undefined;
      }
      expect(findPostRejectDeliver()).toBeUndefined();

      // Short timeout window in case any asynchronous emission lands after
      // the workflow completion commit.
      // load-proof: no delivery may arrive after the rejected subscribe, and a loaded host can only delay one
      const deliverPromise = waitForLine(
        output.lines.bind(output),
        (parsed: any) => parsed?.method === 'weft.events.deliver',
        200,
        lineCountAfterRejectedSubscribe,
      );

      let timedOut = false;
      try {
        await deliverPromise;
      } catch (error) {
        if (error instanceof Error && /timed out/i.test(error.message)) {
          timedOut = true;
        } else {
          throw error;
        }
      }
      expect(timedOut).toBe(true);

      input.close();
      const result = await sessionPromise;
      expect(result.exitCode).toBe(0);
    } finally {
      // Defense-in-depth cleanup if any assertion above threw.
      input.close();
      await sessionPromise.catch(() => {});
    }
  });

  it('test 4: rejected stdio subscriptions close cleanly without leaking output', async () => {
    // Attempt an unsupported subscription, then tear the session down and
    // assert:
    //   1. The session returns `exitCode === 0`.
    //   2. No unhandled rejection escapes.
    //   3. Post-close engine commits do NOT produce any further
    //      output.
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);

    const { input, output, sessionPromise } = await startRejectedSubscription(handle.id);

    try {
      input.close();
      const result = await sessionPromise;
      expect(result.exitCode).toBe(0);

      const lineCountAfterClose = output.lines().length;

      await engine.signal(handle.id, 'release', 'done');
      await waitForStatus(engine, handle.id, 'completed');

      // load-proof: negative window for a late rejection: load can only delay an unhandled rejection, never produce one earlier, so the absence check cannot flip
      await new Promise<void>((resolve) => setImmediate(resolve));
      // load-proof: negative window for a late rejection: load can only delay an unhandled rejection, never produce one earlier, so the absence check cannot flip
      await new Promise<void>((resolve) => setImmediate(resolve));

      function findPostCloseDeliver(): unknown {
        for (const line of output.lines().slice(lineCountAfterClose)) {
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed?.method === 'weft.events.deliver') return parsed;
        }
        return undefined;
      }
      expect(findPostCloseDeliver()).toBeUndefined();
    } finally {
      input.close();
      await sessionPromise.catch(() => {});
      process.off('unhandledRejection', rejectionHandler);
    }

    expect(leakedRejection).toBeNull();
  });
});
