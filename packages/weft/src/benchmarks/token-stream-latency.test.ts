import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import type { WeftServer } from '../server/index.ts';
import { serve } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForRealTimersForTesting } from '../testing/fake-timers.test-support.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

class TokenEvent extends Event {
  static readonly type = 'stream:token';

  constructor(
    public readonly workflowId: string,
    public readonly token: string,
    public readonly model: string,
  ) {
    super(TokenEvent.type);
  }
}

/**
 * K2g: token stream latency benchmark.
 *
 * Measures median latency from `engine.dispatchEvent(new TokenEvent(...))` to
 * receipt on a live WebSocket client connected to
 * `WS /v1/workflows/:id/stream`.
 *
 * Architecture target: <10ms median.
 *
 * Coverage mode gets a looser threshold because instrumentation affects event
 * dispatch, JSON serialization, and the local WebSocket path. The regular
 * `bun test` path keeps the architecture threshold.
 */

const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 20;
const SMOKE_WARMUP_SAMPLES = 1;
const SMOKE_MEASURED_SAMPLES = 1;
const BASELINE_TARGET_MILLISECONDS = 10;
const COVERAGE_TARGET_MILLISECONDS = 15;
const runArchitectureBenchmark =
  process.env['WEFT_TOKEN_STREAM_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;

type TokenLatencyBenchmarkResult = {
  warmupSamples: number;
  measuredSamples: number;
  medianMilliseconds: number;
  samples: number[];
  targetMilliseconds: number;
};

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1]! + sorted[middleIndex]!) / 2;
  }

  return sorted[middleIndex]!;
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  const streamTarget = workflow({ name: 'stream-target' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    yield* ctx.sleep('1h');
    return 'done';
  });
  engine.register(streamTarget);

  return engine;
}

async function connectStream(server: WeftServer, workflowId: string): Promise<WebSocket> {
  const wsUrl = server.url.replace('http://', 'ws://');
  const ws = new WebSocket(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/stream`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out opening WebSocket connection'));
    }, 5_000);

    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      },
      {
        once: true,
      },
    );
  });

  return ws;
}

function isTokenMessage(
  value: unknown,
  expectedToken: string,
): value is { type: typeof TokenEvent.type; data: { token: string } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record['type'] !== TokenEvent.type) {
    return false;
  }

  const data = record['data'];
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  return (data as Record<string, unknown>)['token'] === expectedToken;
}

async function measureTokenLatency(
  engine: Engine,
  workflowId: string,
  streamSocket: WebSocket,
  token: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const sentAt = performance.now();
    let settled = false;

    const cleanup = (): void => {
      streamSocket.removeEventListener('message', handleMessage as EventListener);
      clearTimeout(timeout);
    };

    const finish = (result: { ok: true; latency: number } | { ok: false; error: Error }): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (result.ok) {
        resolve(result.latency);
      } else {
        reject(result.error);
      }
    };

    const handleMessage = (event: MessageEvent): void => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!isTokenMessage(payload, token)) {
        return;
      }

      finish({ ok: true, latency: performance.now() - sentAt });
    };

    const timeout = setTimeout(
      () =>
        finish({
          ok: false,
          error: new Error(`Timed out waiting for token stream delivery: ${token}`),
        }),
      5_000,
    );

    streamSocket.addEventListener('message', handleMessage as EventListener);
    engine.dispatchEvent(new TokenEvent(workflowId, token, 'gpt-4'));
  });
}

function getTargetMilliseconds(): number {
  return isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_MILLISECONDS
    : BASELINE_TARGET_MILLISECONDS;
}

function logTokenLatencyBenchmark(result: TokenLatencyBenchmarkResult): void {
  console.log(
    [
      `\n  Token stream latency benchmark:`,
      `    Warmup samples:  ${result.warmupSamples.toLocaleString()}`,
      `    Measured:        ${result.measuredSamples.toLocaleString()}`,
      `    Samples (ms):    ${result.samples.map((sample) => sample.toFixed(2)).join(', ')}`,
      `    Median (ms):     ${result.medianMilliseconds.toFixed(2)}`,
      `    Target (ms):     <${result.targetMilliseconds.toFixed(2)}`,
      `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}\n`,
    ].join('\n'),
  );
}

describe('Token stream latency', () => {
  let engine: Engine;
  let server: WeftServer;
  let streamSocket: WebSocket | undefined;

  afterEach(async () => {
    streamSocket?.close();
    streamSocket = undefined;
    if (server) {
      await server.stop();
    }
    engine?.[Symbol.dispose]();
  });

  async function runTokenLatencyBenchmark(
    warmupSamples: number,
    measuredSamples: number,
  ): Promise<TokenLatencyBenchmarkResult> {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const handle = await engine.start('stream-target', 'hello');
    streamSocket = await connectStream(server, handle.id);
    await measureTokenLatency(engine, handle.id, streamSocket, '__stream-ready__');

    for (let sample = 0; sample < warmupSamples; sample += 1) {
      await measureTokenLatency(engine, handle.id, streamSocket, `warmup-${String(sample)}`);
      await waitForRealTimersForTesting(5);
    }

    const samples: number[] = [];
    for (let sample = 0; sample < measuredSamples; sample += 1) {
      samples.push(
        await measureTokenLatency(engine, handle.id, streamSocket, `token-${String(sample)}`),
      );
      await waitForRealTimersForTesting(5);
    }

    streamSocket.close();
    return {
      warmupSamples,
      measuredSamples,
      medianMilliseconds: median(samples),
      samples,
      targetMilliseconds: getTargetMilliseconds(),
    };
  }

  it('records stream delivery latency in a non-gating smoke benchmark', async () => {
    const result = await runTokenLatencyBenchmark(SMOKE_WARMUP_SAMPLES, SMOKE_MEASURED_SAMPLES);

    logTokenLatencyBenchmark(result);

    expect(result.samples).toHaveLength(SMOKE_MEASURED_SAMPLES);
    expect(result.medianMilliseconds).toBeGreaterThan(0);
  }, 60_000);

  runArchitectureBenchmark(
    `stream delivery median stays below ${getTargetMilliseconds().toFixed(0)}ms`,
    async () => {
      const result = await runTokenLatencyBenchmark(WARMUP_SAMPLES, MEASURED_SAMPLES);

      logTokenLatencyBenchmark(result);

      expect(result.medianMilliseconds).toBeLessThan(result.targetMilliseconds);
    },
    30_000,
  );
});
