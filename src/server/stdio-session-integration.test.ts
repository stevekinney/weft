/**
 * End-to-end integration tests for `runStdioSession` wired to a real
 * `Engine` instance and the production `createEngineEventFeedBackend`.
 *
 * The four tests prove end-to-end correctness of the engine-backed stdio
 * path — that is, the full chain from newline-delimited JSON-RPC frames
 * through the session dispatcher, through the real event feed, to live
 * `weft.events.deliver` notifications.
 *
 * These tests are intentionally NOT mocked at the engine level. Using the
 * production `createEngineEventFeedBackend(engine)` is the core point:
 * the in-memory unit tests in `stdio-session.test.ts` already cover
 * pure session logic; these cover the wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import { runStdioSession } from './stdio-session.ts';
import { createWorkflowEventFeed, type WorkflowEventFeed } from './workflow-event-feed.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> that streams the given pre-encoded lines. */
function readableFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

/** Collect every chunk written to a WritableStream<Uint8Array> as newline-split lines. */
function collectingWritable(): {
  stream: WritableStream<Uint8Array>;
  lines(): string[];
} {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const complete: string[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        complete.push(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    close() {
      if (buffer.length > 0) complete.push(buffer);
    },
  });
  return {
    stream,
    lines() {
      return [...complete];
    },
  };
}

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
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    send(line: string) {
      controller.enqueue(encoder.encode(line));
    },
    close() {
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
  timeoutMs = 3_000,
  startFromIndex = 0,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
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
          resolve(parsed);
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error('waitForLine timed out'));
        return;
      }
      setTimeout(check, 10);
    }
    check();
  });
}

/** Poll until the engine workflow reaches the target status or timeout elapses. */
async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status} within ${timeoutMs}ms`);
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
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
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
  });

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
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      feed,
    });

    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const response = JSON.parse(lines[0]!);
    expect(response.result.id).toBe(handle.id);
    expect(response.result.status).toBe('running');
  });

  it('test 2: subscribes to events selector and receives weft.events.deliver notifications', async () => {
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    // Use a manually-controlled stream so the input stays open while we
    // signal the engine in parallel. Closing input prematurely would
    // tear down the session before any deliver notifications arrive.
    const input = controllableInput();
    const output = collectingWritable();

    // Send the subscription frame immediately.
    input.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: handle.id, selector: 'events' },
        id: 1,
      }) + '\n',
    );

    // Run the session concurrently — it will block on the input stream
    // until we close it.
    const sessionPromise = runStdioSession({
      input: input.stream,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      feed,
    });

    // Wait for the subscription acknowledgement to arrive before signalling.
    const subscribeResponse = (await waitForLine(
      output.lines.bind(output),
      (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
      3_000,
    )) as any;
    expect(subscribeResponse.result.subscriptionId).toBeTruthy();

    // Signal the workflow — this commits events that the engine-backed
    // feed must propagate as weft.events.deliver notifications.
    await engine.signal(handle.id, 'release', 'done');

    // Wait for at least one deliver notification to arrive.
    const delivered = (await waitForLine(
      output.lines.bind(output),
      (parsed: any) =>
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.envelope?.workflowId === handle.id &&
        parsed?.params?.envelope?.selector === 'events',
      3_000,
    )) as any;

    expect(delivered.params.envelope.workflowId).toBe(handle.id);
    expect(delivered.params.envelope.selector).toBe('events');
    expect(typeof delivered.params.envelope.kind).toBe('string');
    expect(typeof delivered.params.envelope.sequence).toBe('number');
    expect(delivered.params.envelope.sequence).toBeGreaterThanOrEqual(0);
    expect(typeof delivered.params.envelope.cursor).toBe('string');

    // Close the input to let the session drain and exit.
    input.close();
    const result = await sessionPromise;
    expect(result.exitCode).toBe(0);
  });

  it('test 3: unsubscribe stops further deliveries', async () => {
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    const input = controllableInput();
    const output = collectingWritable();

    // Subscribe.
    input.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: handle.id, selector: 'events' },
        id: 1,
      }) + '\n',
    );

    const sessionPromise = runStdioSession({
      input: input.stream,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      feed,
    });

    // Wait for the subscribe acknowledgement and capture the subscriptionId.
    const subscribeResponse = (await waitForLine(
      output.lines.bind(output),
      (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
      3_000,
    )) as any;
    const subscriptionId = subscribeResponse.result.subscriptionId as string;

    // Unsubscribe.
    input.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId },
        id: 2,
      }) + '\n',
    );

    // Wait for the unsubscribe acknowledgement before signalling.
    await waitForLine(
      output.lines.bind(output),
      (parsed: any) => parsed?.id === 2 && parsed?.result !== undefined,
      3_000,
    );

    // Snapshot the current line count — deliveries for this subscriptionId
    // that arrive after this index are post-unsubscribe and must not appear.
    const lineCountAfterUnsubscribe = output.lines().length;

    // Signal the engine — commits that would have triggered deliveries
    // MUST NOT reach the unsubscribed client.
    await engine.signal(handle.id, 'release', 'done');

    // Wait for the workflow to reach a terminal state so we know the engine
    // has committed all events. If any deliver was going to arrive, the
    // engine has finished emitting by this point.
    await waitForStatus(engine, handle.id, 'completed', 2_000);

    // Use a short window to assert no deliver arrives for this subscriptionId
    // AFTER the unsubscribe. `waitForLine` with `startFromIndex` only checks
    // new lines, so replayed events delivered before unsubscribe are excluded.
    // This is stronger than `Bun.sleep + boolean check`: the test only passes
    // if the promise explicitly times out.
    const deliverPromise = waitForLine(
      output.lines.bind(output),
      (parsed: any) =>
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.subscriptionId === subscriptionId,
      200,
      lineCountAfterUnsubscribe,
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

    // Tear down.
    input.close();
    const result = await sessionPromise;
    expect(result.exitCode).toBe(0);
  });

  it('test 4: session close releases the engine listener without unhandled rejections', async () => {
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    // Capture any unhandled rejections that escape during session teardown.
    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);

    try {
      // An empty input stream causes the session to reach EOF immediately,
      // which triggers the `finally` block in `runStdioSession` — that's
      // where `session.close()` is called and engine listeners are released.
      const input = readableFromLines([]);
      const output = collectingWritable();

      const result = await runStdioSession({
        input,
        output: output.stream,
        admission: { kind: 'allow-unauthenticated-local-admin' },
        registry,
        engine,
        feed,
      });

      // The externally-observable proof that cleanup ran is the session
      // returning a clean exitCode. Any engine-listener leak that caused an
      // in-flight write to a closed stream after session.close() would
      // surface as an unhandledRejection — asserted below.
      expect(result.exitCode).toBe(0);

      // Give microtasks a chance to surface any late rejections from the
      // session.close() → feed unsubscribe → engine-listener call chain.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }

    expect(leakedRejection).toBeNull();
  });
});
