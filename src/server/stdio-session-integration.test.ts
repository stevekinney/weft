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

    try {
      // Wait for the subscription acknowledgement to arrive before signalling.
      const subscribeResponse = (await waitForLine(
        output.lines.bind(output),
        (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
        3_000,
      )) as any;
      expect(subscribeResponse.result.subscriptionId).toBeTruthy();
      const subscriptionId = subscribeResponse.result.subscriptionId as string;

      // Capture a baseline of the highest sequence already delivered
      // by replay (from `engine.start`'s initial workflow:checkpoint).
      // Any post-signal delivery the test asserts on must have a
      // sequence STRICTLY GREATER than this baseline — otherwise a
      // replayed event could satisfy the predicate and the signal-
      // to-deliver wiring would not actually be exercised.
      function highestDeliveredSequence(): number {
        let max = -1;
        for (const line of output.lines()) {
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            parsed?.method === 'weft.events.deliver' &&
            parsed?.params?.subscriptionId === subscriptionId &&
            typeof parsed?.params?.envelope?.sequence === 'number' &&
            parsed.params.envelope.sequence > max
          ) {
            max = parsed.params.envelope.sequence;
          }
        }
        return max;
      }

      // Give replay a brief moment to drain into the output buffer
      // so the baseline reflects every pre-signal delivery. Then
      // snapshot.
      await Bun.sleep(10);
      const baselineSequence = highestDeliveredSequence();

      // Signal the workflow — this commits events that the engine-backed
      // feed must propagate as weft.events.deliver notifications.
      await engine.signal(handle.id, 'release', 'done');

      // Wait for a deliver whose sequence advances past the baseline.
      // This proves the signal → engine commit → feed → stdio path
      // produced a NEW envelope, not just a replay.
      const delivered = (await waitForLine(
        output.lines.bind(output),
        (parsed: any) =>
          parsed?.method === 'weft.events.deliver' &&
          parsed?.params?.subscriptionId === subscriptionId &&
          parsed?.params?.envelope?.workflowId === handle.id &&
          parsed?.params?.envelope?.selector === 'events' &&
          typeof parsed?.params?.envelope?.sequence === 'number' &&
          parsed.params.envelope.sequence > baselineSequence,
        3_000,
      )) as any;

      expect(delivered.params.subscriptionId).toBe(subscriptionId);
      expect(delivered.params.envelope.workflowId).toBe(handle.id);
      expect(delivered.params.envelope.selector).toBe('events');
      expect(typeof delivered.params.envelope.kind).toBe('string');
      expect(delivered.params.envelope.sequence).toBeGreaterThan(baselineSequence);
      expect(typeof delivered.params.envelope.cursor).toBe('string');
      // Close the input to let the session drain and exit.
      input.close();
      const result = await sessionPromise;
      expect(result.exitCode).toBe(0);
    } finally {
      // Defense-in-depth: a thrown assertion above would skip the
      // happy-path teardown. Ensure the session can't leak into the
      // next test even on failure.
      input.close();
      await sessionPromise.catch(() => {});
    }
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

    try {
      // Wait for the subscribe acknowledgement and capture the subscriptionId.
      const subscribeResponse = (await waitForLine(
        output.lines.bind(output),
        (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
        3_000,
      )) as any;
      const subscriptionId = subscribeResponse.result.subscriptionId as string;

      // Prove the subscription is actually live BEFORE unsubscribing.
      // `engine.start('hold', ...)` already committed a
      // `workflow:checkpoint`, so the subscribe replay must deliver it.
      // Without this assertion, an unsubscribe-before-listener-active
      // race would let the test pass vacuously — there'd be no
      // delivery to suppress because the listener never installed.
      const initialDelivered = (await waitForLine(
        output.lines.bind(output),
        (parsed: any) =>
          parsed?.method === 'weft.events.deliver' &&
          parsed?.params?.subscriptionId === subscriptionId,
        3_000,
      )) as any;
      const baselineSequence = initialDelivered.params.envelope.sequence as number;
      expect(baselineSequence).toBeGreaterThanOrEqual(0);

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

      // Signal the engine — this commits another checkpoint that
      // WOULD trigger a deliver if the unsubscribe failed. The pre-
      // unsubscribe assertion above proved deliveries DO happen for
      // this subscription; if the post-signal scan finds another
      // deliver with sequence > baseline, the unsubscribe didn't
      // actually unwire the listener.
      await engine.signal(handle.id, 'release', 'done');

      // Wait for the workflow to reach a terminal state so we know the engine
      // has committed all events.
      await waitForStatus(engine, handle.id, 'completed', 2_000);

      // Primary assertion: scan every line written AFTER the
      // unsubscribe index. None should be a deliver for our
      // subscriptionId. `output.lines()` returns raw JSON strings,
      // so each line must be parsed before predicate checks —
      // calling `.find` on raw strings would always return
      // undefined and the assertion would pass vacuously.
      function findPostUnsubscribeDeliver(): unknown {
        for (const line of output.lines().slice(lineCountAfterUnsubscribe)) {
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            parsed?.method === 'weft.events.deliver' &&
            parsed?.params?.subscriptionId === subscriptionId
          ) {
            return parsed;
          }
        }
        return undefined;
      }
      expect(findPostUnsubscribeDeliver()).toBeUndefined();

      // Defense in depth: a short timeout window to catch any deliver
      // that the engine commits asynchronously after the terminal-state
      // wait. Pass condition is the timeout, not a delivery — a regression
      // that re-introduced post-unsubscribe deliveries would surface here
      // even if `waitForStatus` returned before the engine's emit.
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
    } finally {
      // Defense-in-depth cleanup if any assertion above threw.
      input.close();
      await sessionPromise.catch(() => {});
    }
  });

  it('test 4: subscribed session closes cleanly and releases engine listeners', async () => {
    // Open a real subscription, prove it's wired (one delivery
    // arrives), then tear the session down and assert:
    //   1. The session returns `exitCode === 0`.
    //   2. No unhandled rejection escapes (a late `emitter.send` on
    //      a closed stream would otherwise leak).
    //   3. Post-close engine commits do NOT produce any further
    //      output — proof the engine listener was actually
    //      unregistered, not just orphaned.
    //
    // The previous version of this test never subscribed, so it
    // only proved EOF on an idle session returns cleanly — it did
    // NOT exercise the listener-teardown path it claimed to.
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);

    const input = controllableInput();
    const output = collectingWritable();

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

    try {
      // Confirm the subscription is live before tearing down.
      const subscribeResponse = (await waitForLine(
        output.lines.bind(output),
        (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
        3_000,
      )) as any;
      const subscriptionId = subscribeResponse.result.subscriptionId as string;

      const initialDelivered = (await waitForLine(
        output.lines.bind(output),
        (parsed: any) =>
          parsed?.method === 'weft.events.deliver' &&
          parsed?.params?.subscriptionId === subscriptionId,
        3_000,
      )) as any;
      expect(initialDelivered.params.subscriptionId).toBe(subscriptionId);

      // Close input → EOF → session.close() runs in the `finally`
      // block of runStdioSession, which is what releases the
      // engine listener for this subscription.
      input.close();
      const result = await sessionPromise;
      expect(result.exitCode).toBe(0);

      // Snapshot the line count post-teardown. Any further engine
      // commit MUST NOT produce a deliver in the output buffer
      // (the writable is still alive in the test, but the session
      // is gone).
      const lineCountAfterClose = output.lines().length;

      // Post-close commits — these would surface as deliveries if
      // the engine listener was leaked.
      await engine.signal(handle.id, 'release', 'done');
      await waitForStatus(engine, handle.id, 'completed', 2_000);

      // Give microtasks a turn so any late emission would land.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      function findPostCloseDeliver(): unknown {
        for (const line of output.lines().slice(lineCountAfterClose)) {
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            parsed?.method === 'weft.events.deliver' &&
            parsed?.params?.subscriptionId === subscriptionId
          ) {
            return parsed;
          }
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
