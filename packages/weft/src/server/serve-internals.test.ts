import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';

import { DEFAULT_SSE_HEARTBEAT_INTERVAL_MS } from "../embedded/backchannel/src/internals.ts";
import { SERVER_IDLE_TIMEOUT_MARGIN_SECONDS, SERVER_IDLE_TIMEOUT_SECONDS } from './idle-timeout.ts';
import {
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { MAX_POLL_TIMEOUT } from './runtime/task-polling.ts';
import {
  assertAuthenticationPosture,
  buildBunServeConfig,
  buildFetchHandler,
  buildServerContext,
  clampCancellationGracePeriod,
  clampWorkerReconnectGracePeriod,
  registerStackDisposers,
  resolveNetworkConfig,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from './serve-internals.ts';

import type { EventBroadcastingHandle } from './index.ts';

describe('clampWorkerReconnectGracePeriod', () => {
  it('returns the 2000ms default when undefined', () => {
    expect(clampWorkerReconnectGracePeriod(undefined)).toBe(2_000);
  });

  it('returns the 2000ms default for non-finite values', () => {
    expect(clampWorkerReconnectGracePeriod(Number.NaN)).toBe(2_000);
    expect(clampWorkerReconnectGracePeriod(Number.POSITIVE_INFINITY)).toBe(2_000);
    expect(clampWorkerReconnectGracePeriod(Number.NEGATIVE_INFINITY)).toBe(2_000);
  });

  it('honors 0 as the explicit no-grace bypass', () => {
    expect(clampWorkerReconnectGracePeriod(0)).toBe(0);
  });

  it('honors finite positive values inside the 1..5000 range', () => {
    expect(clampWorkerReconnectGracePeriod(1)).toBe(1);
    expect(clampWorkerReconnectGracePeriod(100)).toBe(100);
    expect(clampWorkerReconnectGracePeriod(250)).toBe(250);
    expect(clampWorkerReconnectGracePeriod(5_000)).toBe(5_000);
  });

  it('clamps negative values to 0', () => {
    expect(clampWorkerReconnectGracePeriod(-1)).toBe(0);
    expect(clampWorkerReconnectGracePeriod(-1_000)).toBe(0);
  });

  it('clamps values above 5000 to 5000', () => {
    expect(clampWorkerReconnectGracePeriod(5_001)).toBe(5_000);
    expect(clampWorkerReconnectGracePeriod(1_000_000)).toBe(5_000);
  });

  it('floors fractional values', () => {
    expect(clampWorkerReconnectGracePeriod(123.7)).toBe(123);
  });
});

describe('clampCancellationGracePeriod', () => {
  it('returns the 30000ms default when undefined', () => {
    expect(clampCancellationGracePeriod(undefined)).toBe(30_000);
  });

  it('returns the 30000ms default for non-finite values', () => {
    expect(clampCancellationGracePeriod(Number.NaN)).toBe(30_000);
    expect(clampCancellationGracePeriod(Number.POSITIVE_INFINITY)).toBe(30_000);
    expect(clampCancellationGracePeriod(Number.NEGATIVE_INFINITY)).toBe(30_000);
  });

  it('honors 0 as the explicit no-grace bypass', () => {
    expect(clampCancellationGracePeriod(0)).toBe(0);
  });

  it('honors finite positive values inside the 1..300000 range', () => {
    expect(clampCancellationGracePeriod(1)).toBe(1);
    expect(clampCancellationGracePeriod(1_000)).toBe(1_000);
    expect(clampCancellationGracePeriod(300_000)).toBe(300_000);
  });

  it('clamps negative values to 0', () => {
    expect(clampCancellationGracePeriod(-1)).toBe(0);
    expect(clampCancellationGracePeriod(-1_000)).toBe(0);
  });

  it('clamps values above 300000 to 300000', () => {
    expect(clampCancellationGracePeriod(300_001)).toBe(300_000);
    expect(clampCancellationGracePeriod(10_000_000)).toBe(300_000);
  });

  it('floors fractional values', () => {
    expect(clampCancellationGracePeriod(123.7)).toBe(123);
  });
});

describe('assertAuthenticationPosture', () => {
  it.each(['1', 'true', 'yes', 'on', ' true '])(
    'rejects missing auth when WEFT_SERVER_AUTHENTICATION_REQUIRED=%s',
    (environmentRequirement) => {
      expect(() =>
        assertAuthenticationPosture(minimalServeOptions(), environmentRequirement),
      ).toThrow('Refusing to start server with no authentication');
    },
  );

  it.each(['0', 'false', 'no', 'off', '', ' false '])(
    'does not require auth when WEFT_SERVER_AUTHENTICATION_REQUIRED=%s',
    (environmentRequirement) => {
      const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        assertAuthenticationPosture(minimalServeOptions(), environmentRequirement);
        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('server started with NO authentication'),
        );
      } finally {
        warningSpy.mockRestore();
      }
    },
  );

  it('treats an omitted environment requirement as absent', () => {
    const previousRequirement = Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      delete Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
      assertAuthenticationPosture(minimalServeOptions());
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('server started with NO authentication'),
      );
    } finally {
      if (previousRequirement === undefined) {
        delete Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
      } else {
        Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'] = previousRequirement;
      }
      warningSpy.mockRestore();
    }
  });

  it('rejects invalid environment requirement values', () => {
    expect(() => assertAuthenticationPosture(minimalServeOptions(), 'sometimes')).toThrow(
      'Invalid WEFT_SERVER_AUTHENTICATION_REQUIRED value "sometimes"',
    );
  });

  it('lets auth satisfy an environment requirement', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      assertAuthenticationPosture(
        { ...minimalServeOptions(), auth: { apiKeys: ['test-key'] } },
        '1',
      );
      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('does not parse the environment requirement when auth is configured', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      assertAuthenticationPosture(
        { ...minimalServeOptions(), auth: { apiKeys: ['test-key'] } },
        'sometimes',
      );
      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('does not let explicit allow override an environment requirement', () => {
    expect(() =>
      assertAuthenticationPosture(
        { ...minimalServeOptions(), unauthenticatedAccess: 'allow' },
        '1',
      ),
    ).toThrow('WEFT_SERVER_AUTHENTICATION_REQUIRED requires authentication');
  });

  it('rejects before network configuration can be resolved', () => {
    expect(() =>
      resolveNetworkConfig({ ...minimalServeOptions(), unauthenticatedAccess: 'reject' }),
    ).toThrow('Refusing to start server with no authentication');
  });
});

describe('MCP origin configuration posture', () => {
  it('warns at startup when MCP origin controls are omitted', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      resolveNetworkConfig(minimalServeOptions());
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'MCP HTTP transport is enabled without publicOrigin or trustedHosts',
        ),
      );
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('does not warn when publicOrigin is configured', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      resolveNetworkConfig({
        ...minimalServeOptions(),
        auth: { apiKeys: ['test-key'], defaultApiKeyScopes: ['workflows:read'] },
        publicOrigin: 'https://api.example.com',
      });
      expect(warningSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(
          'MCP HTTP transport is enabled without publicOrigin or trustedHosts',
        ),
      );
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('does not warn when trustedHosts is configured', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      resolveNetworkConfig({
        ...minimalServeOptions(),
        auth: { apiKeys: ['test-key'], defaultApiKeyScopes: ['workflows:read'] },
        trustedHosts: ['api.example.com'],
      });
      expect(warningSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(
          'MCP HTTP transport is enabled without publicOrigin or trustedHosts',
        ),
      );
    } finally {
      warningSpy.mockRestore();
    }
  });
});

describe('registerStackDisposers', () => {
  it('returns 503 until the server holder has been populated', async () => {
    const fetchHandler = buildFetchHandler(
      { current: null },
      minimalServerContext(),
      resolveNetworkConfig({
        ...minimalServeOptions(),
        unauthenticatedAccess: 'allow',
        trustedHosts: ['localhost'],
      }).serverOptions,
    );

    const response = await fetchHandler(new Request('http://localhost/health'));

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('Server not ready');
  });

  it('keeps a connection open longer than the longest silence it has to survive', () => {
    const config = buildBunServeConfig(
      7233,
      '127.0.0.1',
      false,
      {},
      undefined,
      async () => new Response('ok'),
      { open() {}, message() {}, close() {} },
    );
    expect(config.idleTimeout).toBe(SERVER_IDLE_TIMEOUT_SECONDS);
    // Bun's default of 10 seconds cut a stream between two 15 second pings.
    const longestSilenceSeconds =
      Math.max(DEFAULT_SSE_HEARTBEAT_INTERVAL_MS, MAX_POLL_TIMEOUT) / 1000;
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBe(
      Math.ceil(longestSilenceSeconds) + SERVER_IDLE_TIMEOUT_MARGIN_SECONDS,
    );
    // Each silent interval stays clear of the cut by the margin, so growing either constant past
    // the idle timeout fails here rather than as a stream cut in a browser.
    expect(SERVER_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThanOrEqual(
      DEFAULT_SSE_HEARTBEAT_INTERVAL_MS + SERVER_IDLE_TIMEOUT_MARGIN_SECONDS * 1000,
    );
    expect(SERVER_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThanOrEqual(
      MAX_POLL_TIMEOUT + SERVER_IDLE_TIMEOUT_MARGIN_SECONDS * 1000,
    );
    // Bun accepts at most 255 seconds.
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  it('adds tls to the Bun serve config only when tls options exist', () => {
    const websocketCallbacks: Parameters<typeof buildBunServeConfig>[6] = {
      open() {},
      message() {},
      close() {},
    };

    const baseConfig = buildBunServeConfig(
      7233,
      '127.0.0.1',
      true,
      {},
      undefined,
      async () => new Response('ok'),
      websocketCallbacks,
    );
    expect(baseConfig.tls).toBeUndefined();
    expect(baseConfig.websocket!.maxPayloadLength).toBe(WEBSOCKET_MAX_PAYLOAD_BYTES);

    const tlsOptions = { key: 'key', cert: 'cert' } as unknown as ReturnType<
      typeof resolveNetworkConfig
    >['tlsOptions'];
    const tlsConfig = buildBunServeConfig(
      7233,
      '127.0.0.1',
      false,
      {},
      tlsOptions,
      async () => new Response('ok'),
      websocketCallbacks,
    );
    expect(tlsConfig.tls).toBe(tlsOptions);
  });

  describe('buildBunServeConfig websocket frame size', () => {
    const websocketCallbacks: Parameters<typeof buildBunServeConfig>[6] = {
      open() {},
      message() {},
      close() {},
    };

    it('sets maxPayloadLength to the constant 4 MiB transport ceiling', () => {
      // The frame cap is a fixed transport-safety ceiling, independent of
      // `payloadSize.maxBytes` (which is an application value-size policy in a
      // different unit). A bounded 4 MiB parse is not a CPU-burn, so the
      // constant ceiling closes the DoS without risking false rejections of
      // legitimate frames whose value is within the admission cap.
      const config = buildBunServeConfig(
        7233,
        '127.0.0.1',
        false,
        {},
        undefined,
        async () => new Response('ok'),
        websocketCallbacks,
      );
      expect(config.websocket!.maxPayloadLength).toBe(WEBSOCKET_MAX_PAYLOAD_BYTES);
      expect(config.websocket!.maxPayloadLength).toBe(4 * 1024 * 1024);
    });
  });

  it('disposes the task queue from the timer-cleanup disposer', () => {
    const context = minimalServerContext();
    // registerStackDisposers wires terminal/cancellation listeners onto the
    // engine during registration, so the stub engine needs addEventListener.
    const options = {
      ...minimalServeOptions(),
      engine: { addEventListener() {}, removeEventListener() {} },
    } as unknown as ReturnType<typeof minimalServeOptions>;

    const disposeSpy = spyOn(context.taskQueue, Symbol.dispose);

    // Capture the registered disposers rather than driving a full server
    // teardown: the other disposers touch collaborators (workflowEventFeed,
    // mcpEndpoint, the engine) that a minimal context does not provide.
    // We only need to prove the timer-cleanup disposer — registered last, so
    // LIFO-disposed first — calls taskQueue[Symbol.dispose].
    const deferred: Array<() => void | Promise<void>> = [];
    const stack = {
      defer(callback: () => void | Promise<void>) {
        deferred.push(callback);
      },
    } as unknown as AsyncDisposableStack;

    const broadcastingHandle = {
      cleanupWorkflow() {},
      dispose() {},
    } as unknown as EventBroadcastingHandle;

    registerStackDisposers(stack, context, options, broadcastingHandle, () => {});

    const timerCleanupDisposer = deferred.at(-1);
    expect(timerCleanupDisposer).toBeDefined();
    timerCleanupDisposer!();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('clears pending timeout handles from the timer-cleanup disposer', () => {
    const context = minimalServerContext();
    const options = {
      ...minimalServeOptions(),
      engine: { addEventListener() {}, removeEventListener() {} },
    } as unknown as ReturnType<typeof minimalServeOptions>;

    const timeoutHandle = setTimeout(() => {}, 60_000);
    context.pendingTimers.add(timeoutHandle);

    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
    const deferred: Array<() => void | Promise<void>> = [];
    const stack = {
      defer(callback: () => void | Promise<void>) {
        deferred.push(callback);
      },
    } as unknown as AsyncDisposableStack;

    registerStackDisposers(
      stack,
      context,
      options,
      {
        cleanupWorkflow() {},
        dispose: () => Promise.resolve(),
      },
      () => {},
    );

    try {
      const timerCleanupDisposer = deferred.at(-1);
      expect(timerCleanupDisposer).toBeDefined();
      timerCleanupDisposer!();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
      expect(context.pendingTimers.size).toBe(0);
    } finally {
      clearTimeout(timeoutHandle);
      clearTimeoutSpy.mockRestore();
    }
  });

  it('sets context.stopping from the timer-cleanup disposer', () => {
    // WFT-23: startup recovery's scan loop and scheduleDelayedDispatch both
    // check context.stopping before doing further work, so a still-running
    // recovery scan cannot arm a new timer or issue a durable write after
    // this disposer has already cleared pendingTimers. This must be set
    // before pendingTimers is cleared, not after — see the disposer's own
    // comment in serve-internals.ts.
    const context = minimalServerContext();
    const options = {
      ...minimalServeOptions(),
      engine: { addEventListener() {}, removeEventListener() {} },
    } as unknown as ReturnType<typeof minimalServeOptions>;

    const deferred: Array<() => void | Promise<void>> = [];
    const stack = {
      defer(callback: () => void | Promise<void>) {
        deferred.push(callback);
      },
    } as unknown as AsyncDisposableStack;

    registerStackDisposers(
      stack,
      context,
      options,
      {
        cleanupWorkflow() {},
        dispose: () => Promise.resolve(),
      },
      () => {},
    );

    expect(context.stopping).toBe(false);

    const timerCleanupDisposer = deferred.at(-1);
    expect(timerCleanupDisposer).toBeDefined();
    timerCleanupDisposer!();

    expect(context.stopping).toBe(true);
  });
});

// Startup task-ledger recovery (formerly `restoreInflightTasks`, scanning
// the retired `op:inflight:` keyspace) is now `runTaskLedgerRecovery` in
// `runtime/task-ledger-recovery.ts` — see that module's own test file.

describe('buildServerContext task queue policy', () => {
  async function schedulingPolicyFor(
    schedulingPolicy: 'fifo' | 'lifo' | undefined,
  ): Promise<string> {
    using engine = new Engine({ storage: new MemoryStorage() });
    const configuration = resolveNetworkConfig({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      trustedHosts: ['localhost'],
      ...(schedulingPolicy === undefined ? {} : { schedulingPolicy }),
    });
    const context = buildServerContext(
      configuration.serverOptions,
      configuration.serverMetricsCollector,
    );
    await context.taskLedgerRecovery.ready;
    return context.taskQueue.schedulingPolicy;
  }

  it('builds the task queue with the configured scheduling policy', async () => {
    expect(await schedulingPolicyFor('fifo')).toBe('fifo');
  });

  it('defaults the task queue to priority scheduling', async () => {
    expect(await schedulingPolicyFor(undefined)).toBe('priority');
  });
});

describe('buildServerContext engine events (COR-1724)', () => {
  it('raises worker:registration-rejected on the engine when the registry records a rejection', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });
    const configuration = resolveNetworkConfig({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      trustedHosts: ['localhost'],
    });
    const context = buildServerContext(
      configuration.serverOptions,
      configuration.serverMetricsCollector,
    );
    await context.taskLedgerRecovery.ready;
    const seen: Array<[string | undefined, string]> = [];
    engine.addEventListener('worker:registration-rejected', (event) => {
      seen.push([event.workerId, event.code]);
    });

    context.registry.recordRejection({
      code: 'registration_rejected',
      workerId: 'w-9',
      rejectedAt: 1,
    });

    expect(seen).toEqual([['w-9', 'registration_rejected']]);
  });

  it('raises queue:depth-changed on the engine when the server task queue gains a pending task', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });
    const configuration = resolveNetworkConfig({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      trustedHosts: ['localhost'],
    });
    const context = buildServerContext(
      configuration.serverOptions,
      configuration.serverMetricsCollector,
    );
    await context.taskLedgerRecovery.ready;
    const seen: Array<[string, number]> = [];
    engine.addEventListener('queue:depth-changed', (event) => {
      seen.push([event.queue, event.depth]);
    });

    context.taskQueue.enqueue('payments', {
      operationId: 'op-1',
      activityName: 'charge',
      input: {},
    });
    context.taskQueue[Symbol.dispose]();

    expect(seen).toEqual([['payments', 1]]);
  });
});
