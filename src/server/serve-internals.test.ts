import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import {
  assertAuthenticationPosture,
  buildBunServeConfig,
  buildFetchHandler,
  clampWorkerReconnectGracePeriod,
  registerStackDisposers,
  resolveNetworkConfig,
  restoreInflightTasks,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from './serve-internals.ts';
import { transitionQueuedToInflight } from './task-state.ts';

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
        auth: { apiKeys: ['test-key'] },
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
        auth: { apiKeys: ['test-key'] },
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
      resolveNetworkConfig(minimalServeOptions()).serverOptions,
    );

    const response = await fetchHandler(new Request('http://localhost/health'));

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('Server not ready');
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
    // mcpSessionManager, the engine) that a minimal context does not provide.
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
        dispose() {},
      } as unknown as EventBroadcastingHandle,
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
});

describe('restoreInflightTasks', () => {
  /** Wait until the registry has rehydrated the operation, or throw on timeout. */
  async function waitForRestored(
    context: ReturnType<typeof minimalServerContext>,
    operationId: string,
  ): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (context.registry.getTask(operationId) !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`operation "${operationId}" was not restored within 1s`);
  }

  it('rehydrates the attemptToken so the stale-attempt guard survives a server restart', async () => {
    // Regression: restoreInflightTasks must carry the durable record's
    // attemptToken into the rehydrated registry entry. If it drops the token,
    // isAssignedToAttempt sees a token-less in-memory task and accepts ANY echo
    // (backward-compat), silently disabling the stale-attempt guard for every
    // in-flight task across a restart — even though storage still holds the
    // current attempt's token.
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    const options = minimalServeOptions(storage);

    const operationId = 'restore-op';
    const workerId = 'worker-a';
    const attemptToken = 'attempt-token-2';
    // Seed a durable inflight record (token-bearing) as if a dispatch persisted
    // it before the server went down. Deadline is in the future so restore keeps it.
    await transitionQueuedToInflight(storage, operationId, {
      operationId,
      workerId,
      deadline: Date.now() + 30_000,
      activityName: 'charge',
      queue: 'default',
      input: { amount: 1 },
      attempt: 2,
      visibilityTimeout: 30_000,
      attemptToken,
    });

    restoreInflightTasks(context, options);
    await waitForRestored(context, operationId);

    // A stale completion from the SAME worker echoing an EARLIER attempt's token
    // must be rejected — proving the current token survived the restart.
    expect(context.registry.isAssignedToAttempt(operationId, workerId, 'attempt-token-1')).toBe(
      false,
    );
    // The current attempt's token is accepted.
    expect(context.registry.isAssignedToAttempt(operationId, workerId, attemptToken)).toBe(true);
  });
});
