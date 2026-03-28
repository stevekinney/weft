import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { LLMProvider } from '../ai/providers/interface.ts';
import {
  Context,
  type AgentContextOptions,
  type ContextOperationRequest,
  type OffloadReference,
  type StreamReference,
  type StreamSink,
} from './context.ts';
import type { SearchAttributeValue } from './types.ts';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-test-123',
    workflowType: 'test-workflow',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

// Helper functions used as activity stubs (at module scope to satisfy consistent-function-scoping)
function greet(...args: unknown[]) {
  return `Hello, ${String(args[0])}!`;
}

function sendEmail(...args: unknown[]) {
  return `Sent to ${String(args[0])}`;
}

function taskA() {
  return 'a';
}

function taskB() {
  return 'b';
}

function task() {
  return 'result';
}

const handler = (payload: unknown) => payload;
const accessor = () => 42;

/** Narrow a yielded ContextOperationRequest by its type discriminant. */
function expectRequest<T extends ContextOperationRequest['type']>(
  yielded: IteratorResult<ContextOperationRequest, unknown>,
  expectedType: T,
): Extract<ContextOperationRequest, { type: T }> {
  expect(yielded.done).toBe(false);
  const request = yielded.value as ContextOperationRequest;
  expect(request.type).toBe(expectedType);
  return request as Extract<ContextOperationRequest, { type: T }>;
}

describe('Context', () => {
  describe('ctx.run', () => {
    it('yields an activity request', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('greet');
      expect(request.fn).toBe(greet);
      expect(request.args).toEqual(['Alice']);
    });

    it('returns the fed-back result', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      generator.next(); // yield

      const result = generator.next('Hello, Alice!');
      expect(result.done).toBe(true);
      expect(result.value).toBe('Hello, Alice!');
    });

    it('on recovery returns cached result without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'cached-result');
      const context = createContext({ accumulatedResults });

      const generator = context.run(greet, 'Alice');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-result');
    });

    it('derives activity name from function name', () => {
      const context = createContext();

      const generator = context.run(sendEmail, 'bob@example.com');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('sendEmail');
    });

    it('accepts ActivityCallOptions as the last argument with queue', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { queue: 'gpu' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('greet');
      expect(request.args).toEqual(['Alice']);
      expect(request.options).toEqual({ queue: 'gpu' });
    });

    it('accepts ActivityCallOptions with no function arguments', () => {
      const context = createContext();

      const generator = context.run(task, { queue: 'billing' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('task');
      expect(request.args).toEqual([]);
      expect(request.options).toEqual({ queue: 'billing' });
    });

    it('accepts ActivityCallOptions with multiple options', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { queue: 'gpu', timeout: 5000 });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.args).toEqual(['Alice']);
      expect(request.options).toEqual({ queue: 'gpu', timeout: 5000 });
    });

    it('does not include options when none are provided', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.options).toBeUndefined();
    });

    it('does not treat a plain object argument as options if it has unknown keys', () => {
      const context = createContext();

      const generator = context.run(greet, { name: 'Alice', queue: 'not-options' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.args).toEqual([{ name: 'Alice', queue: 'not-options' }]);
      expect(request.options).toBeUndefined();
    });

    it('accepts sticky: true as an ActivityCallOption', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { sticky: true });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.args).toEqual(['Alice']);
      expect(request.options).toEqual({ sticky: true });
    });

    it('accepts sticky: true combined with queue option', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { queue: 'gpu', sticky: true });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.args).toEqual(['Alice']);
      expect(request.options).toEqual({ queue: 'gpu', sticky: true });
    });

    it('accepts visibilityTimeout as an ActivityCallOption', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { visibilityTimeout: 60_000 });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.args).toEqual(['Alice']);
      expect(request.options).toEqual({ visibilityTimeout: 60_000 });
    });

    it('defaults queue to "default" in explain mode when no queue option is provided', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.run(greet, 'Alice');
      generator.next();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('queue "default"');
      consoleSpy.mockRestore();
    });

    it('logs the specified queue in explain mode', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.run(greet, 'Alice', { queue: 'gpu' });
      generator.next();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('queue "gpu"');
      consoleSpy.mockRestore();
    });
  });

  describe('ctx.sleep', () => {
    it('yields a sleep request with parsed duration from string', () => {
      const now = 1_000_000;
      const context = createContext({ getNow: () => now });

      const generator = context.sleep('1 hour');
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.duration).toBe(3_600_000);
      expect(request.scheduledFireAt).toBe(now + 3_600_000);
    });

    it('yields a sleep request with numeric duration', () => {
      const now = 1_000_000;
      const context = createContext({ getNow: () => now });

      const generator = context.sleep(5000);
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.duration).toBe(5000);
      expect(request.scheduledFireAt).toBe(now + 5000);
    });
  });

  describe('ctx.waitForSignal', () => {
    it('yields a wait-signal request with the signal name', () => {
      const context = createContext();

      const generator = context.waitForSignal('approval');
      const request = expectRequest(generator.next(), 'wait-signal');

      expect(request.signalName).toBe('approval');
    });
  });

  describe('ctx.all', () => {
    it('yields a parallel request containing sub-operations', () => {
      const context = createContext();

      const generator = context.all([context.run(taskA), context.run(taskB)]);
      const request = expectRequest(generator.next(), 'parallel');

      expect(request.operations).toHaveLength(2);
      expect(request.operations[0]!.type).toBe('activity');
      expect(request.operations[1]!.type).toBe('activity');
    });

    it('preserves queue options on parallel sub-operations', () => {
      const context = createContext();

      const generator = context.all([
        context.run(taskA, { queue: 'gpu' }),
        context.run(taskB, { queue: 'cpu' }),
      ]);
      const request = expectRequest(generator.next(), 'parallel');

      expect(request.operations).toHaveLength(2);
      const op0 = request.operations[0] as Extract<ContextOperationRequest, { type: 'activity' }>;
      const op1 = request.operations[1] as Extract<ContextOperationRequest, { type: 'activity' }>;
      expect(op0.options).toEqual({ queue: 'gpu' });
      expect(op1.options).toEqual({ queue: 'cpu' });
    });
  });

  describe('ctx.race', () => {
    it('yields a race request containing sub-operations', () => {
      const context = createContext();

      const generator = context.race([context.run(taskA), context.run(taskB)]);
      const request = expectRequest(generator.next(), 'race');

      expect(request.operations).toHaveLength(2);
    });
  });

  describe('ctx.memo', () => {
    it('returns cached value on second call without re-yielding', () => {
      const context = createContext();

      let _callCount = 0;
      const compute = () => {
        _callCount++;
        return 42;
      };

      // First call: yields
      const generator1 = context.memo('key1', compute);
      const yielded = generator1.next();
      expect(yielded.done).toBe(false);
      const request = yielded.value as ContextOperationRequest;
      expect(request.type).toBe('memo');
      // Feed the result back
      const result1 = generator1.next(42);
      expect(result1.done).toBe(true);
      expect(result1.value).toBe(42);

      // Second call: returns from memo cache without yielding
      const generator2 = context.memo('key1', compute);
      const result2 = generator2.next();
      expect(result2.done).toBe(true);
      expect(result2.value).toBe(42);
    });

    it('on recovery returns checkpoint-cached value', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'recovered-value');
      const context = createContext({ accumulatedResults });

      const generator = context.memo('key1', () => 'computed');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('recovered-value');
    });
  });

  describe('ctx.waitForUpdate', () => {
    it('yields a wait-update request', () => {
      const context = createContext();

      const generator = context.waitForUpdate('updateName');
      const request = expectRequest(generator.next(), 'wait-update');

      expect(request.updateName).toBe('updateName');
    });
  });

  describe('setAttribute / getAttribute', () => {
    it('stores and retrieves an attribute', () => {
      const context = createContext();
      context.setAttribute('region', 'us-east-1');
      expect(context.getAttribute('region')).toBe('us-east-1');
    });

    it('setAttributes merges with existing attributes', () => {
      const context = createContext();
      context.setAttribute('region', 'us-east-1');
      context.setAttributes({ priority: 5, region: 'eu-west-1' });

      expect(context.getAttribute('region')).toBe('eu-west-1');
      expect(context.getAttribute('priority')).toBe(5);
    });

    it('getAttributes returns a readonly copy that cannot mutate internal state', () => {
      const context = createContext();
      context.setAttribute('key', 'value');

      const attributes = context.getAttributes() as Record<string, SearchAttributeValue>;
      attributes['key'] = 'mutated';

      expect(context.getAttribute('key')).toBe('value');
    });
  });

  describe('ctx.onUpdate', () => {
    it('registers an update handler', () => {
      const context = createContext();
      context.onUpdate('myUpdate', handler);

      expect(context.updateHandlers.get('myUpdate')).toBe(handler);
    });
  });

  describe('ctx.expose', () => {
    it('stores accessor functions', () => {
      const context = createContext();
      context.expose({ counter: accessor });

      expect(context.exposedAccessors.get('counter')).toBe(accessor);
    });
  });

  describe('ctx.signal', () => {
    it('returns an AbortSignal', () => {
      const context = createContext();
      expect(context.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('ctx.executionTimeRemaining', () => {
    it('returns the time remaining when deadline is set', () => {
      const now = 10_000;
      const deadline = 20_000;
      const context = createContext({ deadline, getNow: () => now });

      expect(context.executionTimeRemaining).toBe(10_000);
    });

    it('returns Infinity when no deadline is set', () => {
      const context = createContext();
      expect(context.executionTimeRemaining).toBe(Infinity);
    });
  });

  describe('step index', () => {
    it('increments monotonically across different operations', () => {
      const context = createContext();

      // Step 0: run
      const runGenerator = context.run(taskA);
      runGenerator.next();
      runGenerator.next('result-a');

      // Step 1: sleep
      const sleepGenerator = context.sleep(1000);
      sleepGenerator.next();
      sleepGenerator.next(undefined);

      // Step 2: run
      const runGenerator2 = context.run(taskB);
      runGenerator2.next();
      runGenerator2.next('result-b');

      expect(context.stepIndex).toBe(3);
    });
  });

  describe('operationId', () => {
    it('is a valid UUID', () => {
      const context = createContext();

      const generator = context.run(task);
      const request = expectRequest(generator.next(), 'activity');

      expect(request.operationId).toMatch(UUID_PATTERN);
    });
  });

  describe('pendingAttributeChanges', () => {
    it('tracks attribute changes separately', () => {
      const context = createContext();
      context.setAttribute('key', 'value');

      expect(context.pendingAttributeChanges).toEqual({ key: 'value' });
    });
  });

  describe('constructor options', () => {
    it('initializes with provided search attributes', () => {
      const context = createContext({
        searchAttributes: { region: 'us-east-1' },
      });
      expect(context.getAttribute('region')).toBe('us-east-1');
    });

    it('initializes with a provided initial step', () => {
      const context = createContext({ initialStep: 5 });
      expect(context.stepIndex).toBe(5);
    });
  });

  describe('accumulatedResults getter', () => {
    it('returns the internal accumulated results map', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'value-0');
      const context = createContext({ accumulatedResults });
      expect(context.accumulatedResults).toBe(accumulatedResults);
      expect(context.accumulatedResults.get(0)).toBe('value-0');
    });
  });

  describe('ctx.offload', () => {
    it('yields an offload operation request', () => {
      const context = createContext();
      const fn = async () => ({ large: 'data' });

      const generator = context.offload('large-payload', fn);
      const request = expectRequest(generator.next(), 'offload');

      expect(request.key).toBe('large-payload');
      expect(request.fn).toBe(fn);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached OffloadReference without yielding', () => {
      const cachedReference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 1024,
      };
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, cachedReference);
      const context = createContext({ accumulatedResults });

      const generator = context.offload('large-payload', async () => 'data');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe(cachedReference);
    });

    it('returns the fed-back OffloadReference', () => {
      const context = createContext();
      const reference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 2048,
      };

      const generator = context.offload('large-payload', async () => 'data');
      generator.next(); // yield
      const result = generator.next(reference);

      expect(result.done).toBe(true);
      expect(result.value).toBe(reference);
    });
  });

  describe('ctx.load', () => {
    it('yields a load operation request', () => {
      const context = createContext();
      const reference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 1024,
      };

      const generator = context.load(reference);
      const request = expectRequest(generator.next(), 'load');

      expect(request.reference).toBe(reference);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached value without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, { large: 'data' });
      const context = createContext({ accumulatedResults });

      const reference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 1024,
      };
      const generator = context.load(reference);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toEqual({ large: 'data' });
    });
  });

  describe('ctx.archive', () => {
    it('yields an archive operation request', () => {
      const context = createContext();
      const data = { order: 'completed', total: 99.99 };

      const generator = context.archive('order-snapshot', data);
      const request = expectRequest(generator.next(), 'archive');

      expect(request.key).toBe('order-snapshot');
      expect(request.data).toBe(data);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery skips without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, undefined);
      const context = createContext({ accumulatedResults });

      const generator = context.archive('order-snapshot', { some: 'data' });
      const result = generator.next();

      expect(result.done).toBe(true);
    });
  });

  describe('ctx.runAll', () => {
    it('yields a run-all operation request with named branches', () => {
      const context = createContext();
      const branches = {
        charge: [taskA, 'arg1'] as [Function, ...unknown[]],
        notify: [taskB] as [Function, ...unknown[]],
      };

      const generator = context.runAll(branches);
      const request = expectRequest(generator.next(), 'run-all');

      expect(request.branches).toBe(branches);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached result without yielding', () => {
      const cached = { charge: 'paid', notify: 'sent' };
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, cached);
      const context = createContext({ accumulatedResults });

      const generator = context.runAll({
        charge: [taskA] as [Function, ...unknown[]],
        notify: [taskB] as [Function, ...unknown[]],
      });
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe(cached);
    });
  });

  describe('ctx.agent', () => {
    const mockProvider: LLMProvider = {
      name: 'mock',
      async chat() {
        return {
          content: 'mock response',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          model: 'test-model',
          stopReason: 'end_turn' as const,
        };
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens() {
        return 100;
      },
    };

    function createAgentOptions(overrides?: Partial<AgentContextOptions>): AgentContextOptions {
      return {
        model: 'test-model',
        prompt: 'Hello agent',
        provider: mockProvider,
        ...overrides,
      };
    }

    it('yields an agent operation request', () => {
      const context = createContext();
      const agentOptions = createAgentOptions();

      const generator = context.agent(agentOptions);
      const request = expectRequest(generator.next(), 'agent');

      expect(request.operationId).toMatch(UUID_PATTERN);
      expect(request.options).toBe(agentOptions);
      expect(request.options.model).toBe('test-model');
      expect(request.options.prompt).toBe('Hello agent');
    });

    it('on recovery returns cached result without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'cached-agent-result');
      const context = createContext({ accumulatedResults });

      const generator = context.agent(createAgentOptions());
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-agent-result');
    });

    it('returns the fed-back result', () => {
      const context = createContext();

      const generator = context.agent(createAgentOptions());
      generator.next(); // yield

      const result = generator.next('agent-response-content');
      expect(result.done).toBe(true);
      expect(result.value).toBe('agent-response-content');
    });

    it('increments step index', () => {
      const context = createContext();

      const generator = context.agent(createAgentOptions());
      generator.next();
      generator.next('result');

      expect(context.stepIndex).toBe(1);
    });
  });

  describe('ctx.runAll fed-back result', () => {
    it('returns the fed-back result', () => {
      const context = createContext();
      const branches = {
        charge: [taskA] as [Function, ...unknown[]],
        notify: [taskB] as [Function, ...unknown[]],
      };

      const generator = context.runAll(branches);
      generator.next(); // yield

      const result = generator.next({ charge: 'ok', notify: 'done' });
      expect(result.done).toBe(true);
      expect(result.value).toEqual({ charge: 'ok', notify: 'done' });
    });
  });

  describe('ctx.stream', () => {
    it('yields a stream operation request', () => {
      const context = createContext();
      const fn = async function* (sink: StreamSink) {
        yield { batch: 1 };
        sink.heartbeat({ processed: 1 });
        yield { batch: 2 };
      };

      const generator = context.stream('export-data', fn);
      const request = expectRequest(generator.next(), 'stream');

      expect(request.key).toBe('export-data');
      expect(request.fn).toBe(fn);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached StreamReference without yielding', () => {
      const cachedReference: StreamReference = {
        key: 'export-data',
        workflowId: 'wf-test-123',
        chunkCount: 5,
        totalSizeBytes: 2048,
      };
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, cachedReference);
      const context = createContext({ accumulatedResults });

      const generator = context.stream('export-data', async function* () {});
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe(cachedReference);
    });

    it('returns the fed-back StreamReference', () => {
      const context = createContext();
      const reference: StreamReference = {
        key: 'export-data',
        workflowId: 'wf-test-123',
        chunkCount: 3,
        totalSizeBytes: 4096,
      };

      const generator = context.stream('export-data', async function* () {});
      generator.next(); // yield
      const result = generator.next(reference);

      expect(result.done).toBe(true);
      expect(result.value).toBe(reference);
    });

    it('increments step index', () => {
      const context = createContext();
      const generator = context.stream('key', async function* () {});
      generator.next();
      generator.next({});
      expect(context.stepIndex).toBe(1);
    });
  });

  describe('ctx.streamUrl', () => {
    it('constructs a URL path from a StreamReference', () => {
      const context = createContext();
      const reference: StreamReference = {
        key: 'export-data',
        workflowId: 'wf-test-123',
        chunkCount: 5,
        totalSizeBytes: 2048,
      };

      const url = context.streamUrl(reference);
      expect(url).toBe('/v1/workflows/wf-test-123/streams/export-data');
    });

    it('encodes special characters in key and workflowId', () => {
      const context = createContext();
      const reference: StreamReference = {
        key: 'data/export',
        workflowId: 'wf:special',
        chunkCount: 1,
        totalSizeBytes: 100,
      };

      const url = context.streamUrl(reference);
      expect(url).toBe('/v1/workflows/wf%3Aspecial/streams/data%2Fexport');
    });
  });

  describe('ctx.explain', () => {
    afterEach(() => {
      mock.restore();
    });

    it('enables explain mode', () => {
      const context = createContext();

      // Should not throw
      context.explain();
      expect(context.explainEnabled).toBe(true);
    });

    it('can disable explain mode', () => {
      const context = createContext();

      context.explain(true);
      expect(context.explainEnabled).toBe(true);

      context.explain(false);
      expect(context.explainEnabled).toBe(false);
    });

    it('logs stream operation details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.stream('export-data', async function* () {});
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('stream');
    });

    it('logs operation details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.run(greet, 'Alice');
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('run');
    });
  });

  describe('callerStack', () => {
    it('ctx.run yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.startChild yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.startChild('child-type', { key: 'value' });
      const request = expectRequest(generator.next(), 'child-workflow');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.offload yields a request with callerStack', () => {
      const context = createContext();
      const fn = async () => ({ large: 'data' });
      const generator = context.offload('key', fn);
      const request = expectRequest(generator.next(), 'offload');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
    });

    it('ctx.stream yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.stream('key', async function* () {});
      const request = expectRequest(generator.next(), 'stream');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
    });

    it('ctx.runAll yields a request with callerStack', () => {
      const context = createContext();
      const branches = {
        a: [taskA] as [Function, ...unknown[]],
        b: [taskB] as [Function, ...unknown[]],
      };
      const generator = context.runAll(branches);
      const request = expectRequest(generator.next(), 'run-all');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
    });
  });

  describe('ctx.setBudget', () => {
    it('creates a budget tracker', () => {
      const context = createContext();
      expect(context.budgetRemaining()).toBeUndefined();

      context.setBudget({
        maxTokens: 10000,
        maxCost: 5.0,
        models: {
          'gpt-4': { inputCostPer1K: 0.03, outputCostPer1K: 0.06 },
        },
      });

      const state = context.budgetRemaining();
      expect(state).toBeDefined();
      expect(state!.tokensUsed).toBe(0);
      expect(state!.tokensRemaining).toBe(10000);
      expect(state!.costRemaining).toBe(5.0);
    });
  });

  describe('ctx.budgetRemaining', () => {
    it('returns undefined when no budget is set', () => {
      const context = createContext();
      expect(context.budgetRemaining()).toBeUndefined();
    });

    it('returns state after setBudget', () => {
      const context = createContext();
      context.setBudget({
        maxTokens: 50000,
        maxCost: 10.0,
        models: {
          'gpt-4': { inputCostPer1K: 0.03, outputCostPer1K: 0.06 },
        },
      });

      const state = context.budgetRemaining();
      expect(state).toBeDefined();
      expect(state!.tokensUsed).toBe(0);
      expect(state!.costUsed).toBe(0);
      expect(state!.tokensRemaining).toBe(50000);
      expect(state!.costRemaining).toBe(10.0);
      expect(state!.breakdown).toEqual([]);
    });
  });

  describe('ctx.budgetProjection', () => {
    it('returns undefined when no budget is set', () => {
      const context = createContext();
      expect(context.budgetProjection()).toBeUndefined();
    });

    it('returns zero estimates before any usage', () => {
      const context = createContext();
      context.setBudget({
        maxCost: 10.0,
        models: { 'gpt-4': { inputCostPer1K: 0.03, outputCostPer1K: 0.06 } },
      });

      const projection = context.budgetProjection();
      expect(projection).toBeDefined();
      expect(projection!.estimatedTurnsRemaining).toBe(0);
      expect(projection!.estimatedCostAtCompletion).toBe(0);
    });
  });
});
