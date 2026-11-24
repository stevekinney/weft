import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";

import { KEYS } from '../storage/keys.ts';
import { encode } from './codec.ts';
import * as debugOutput from './debug-output.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import {
  DEFAULT_MAXIMUM_LOG_LINES_PER_RUN,
  MAXIMUM_LOG_LINES_PER_RUN_LIMIT,
  WORKFLOW_LOG_TRUNCATION_MARKER,
  type WorkflowLogLine,
  type WorkflowLogsResult,
} from './workflow-log-codec.ts';
import { createWorkflowLogStore } from './workflow-log-store.ts';

const ENCODER = new TextEncoder();

function record(overrides: Partial<WorkflowLogRecord> = {}): WorkflowLogRecord {
  return {
    level: 'info',
    message: 'hello',
    workflowId: 'run-1',
    workflowType: 'demo',
    timestamp: 1_000,
    step: 0,
    ...overrides,
  };
}

function linesOf(result: WorkflowLogsResult): WorkflowLogLine[] {
  return result.lines;
}
function droppedOf(result: WorkflowLogsResult): number {
  return result.dropped;
}
function messagesOf(result: WorkflowLogsResult): string[] {
  return result.lines.map((line) => line.message);
}
function sequencesOf(result: WorkflowLogsResult): number[] {
  return result.lines.map((line) => line.sequence);
}
function sequencedMessagesOf(result: WorkflowLogsResult): Array<[number, string]> {
  return result.lines.map((line) => [line.sequence, line.message]);
}

describe('createWorkflowLogStore', () => {
  it('reads lines per run and per step, oldest first, and keeps them for a new store over the same storage', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: 'a', step: 0, attributes: { tenant: 'acme' } }));
    store.sink(record({ message: 'b', step: 1, level: 'warn' }));
    store.sink(record({ message: 'c', step: 1 }));
    store.sink(record({ message: 'other run', workflowId: 'run-2' }));
    await store.flush();

    const all = await store.read('run-1');
    expect(all.dropped).toBe(0);
    expect(all.lines.map((line) => [line.sequence, line.step, line.message])).toEqual([
      [0, 0, 'a'],
      [1, 1, 'b'],
      [2, 1, 'c'],
    ]);
    expect(all.lines[0]).toMatchObject({
      level: 'info',
      timestamp: 1_000,
      workflowType: 'demo',
      attributes: { tenant: 'acme' },
      truncated: false,
    });
    expect(all.lines[1]?.level).toBe('warn');
    expect(messagesOf(await store.read('run-1', { step: 1 }))).toEqual(['b', 'c']);
    expect(linesOf(await store.read('run-1', { step: 7 }))).toEqual([]);

    // A restart: nothing of the first store survives, only the storage.
    const restarted = createWorkflowLogStore(storage);
    expect(messagesOf(await restarted.read('run-1'))).toEqual(['a', 'b', 'c']);
    // The restarted store continues the sequence rather than reusing it.
    restarted.sink(record({ message: 'd' }));
    expect(sequencesOf(await restarted.read('run-1'))).toEqual([0, 1, 2, 3]);
  });

  it('reads the lines still buffered, so a read right after a sink sees them', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: 'buffered' }));

    expect(messagesOf(await store.read('run-1'))).toEqual(['buffered']);
  });

  it('evicts the oldest line at line 501 and counts it as dropped', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    expect(DEFAULT_MAXIMUM_LOG_LINES_PER_RUN).toBe(500);
    for (let index = 0; index < 500; index++) store.sink(record({ message: `line ${index}` }));
    await store.flush();
    expect(droppedOf(await store.read('run-1'))).toBe(0);
    expect(linesOf(await store.read('run-1'))).toHaveLength(500);

    store.sink(record({ message: 'line 500' }));
    await store.flush();
    const result = await store.read('run-1');
    expect(result.dropped).toBe(1);
    expect(result.lines).toHaveLength(500);
    expect(result.lines[0]?.message).toBe('line 1');
    expect(result.lines.at(-1)?.message).toBe('line 500');
    expect(result.lines[0]?.sequence).toBe(1);
  });

  it('counts the lines of a burst longer than the cap that never reached storage', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage, { maximumLinesPerRun: 3 });
    for (let index = 0; index < 10; index++) store.sink(record({ message: `line ${index}` }));
    const result = await store.read('run-1');

    expect(result.lines.map((line) => line.message)).toEqual(['line 7', 'line 8', 'line 9']);
    expect(result.dropped).toBe(7);
  });

  it('applies a cap that changes between writes', async () => {
    await using storage = new MemoryStorage();
    let cap = 5;
    const store = createWorkflowLogStore(storage, { maximumLinesPerRun: () => cap });
    for (let index = 0; index < 5; index++) store.sink(record({ message: `line ${index}` }));
    await store.flush();
    cap = 2;
    store.sink(record({ message: 'line 5' }));
    const result = await store.read('run-1');

    expect(result.lines.map((line) => line.message)).toEqual(['line 4', 'line 5']);
    expect(result.dropped).toBe(4);
  });

  it('clamps the cap to the limit and evicts a large backlog when the cap drops', async () => {
    await using storage = new MemoryStorage();
    let cap = MAXIMUM_LOG_LINES_PER_RUN_LIMIT + 10;
    const store = createWorkflowLogStore(storage, { maximumLinesPerRun: () => cap });
    for (let index = 0; index < MAXIMUM_LOG_LINES_PER_RUN_LIMIT + 5; index++) {
      store.sink(record({ message: `line ${index}` }));
    }
    await store.flush();
    const clamped = await store.read('run-1');
    expect(clamped.lines).toHaveLength(MAXIMUM_LOG_LINES_PER_RUN_LIMIT);
    expect(clamped.dropped).toBe(5);

    cap = 10;
    store.sink(record({ message: 'last' }));
    const lowered = await store.read('run-1');
    expect(lowered.lines).toHaveLength(10);
    expect(lowered.lines.at(-1)?.message).toBe('last');
    expect(lowered.dropped).toBe(MAXIMUM_LOG_LINES_PER_RUN_LIMIT + 6 - 10);
    const stored: string[] = [];
    for await (const [key] of storage.scan('log:')) stored.push(key);
    expect(stored).toHaveLength(10);
  });

  it('cuts a message over 2 KiB on a character boundary and marks the line', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: 'x'.repeat(2048) }));
    store.sink(record({ message: 'é'.repeat(2000) }));
    store.sink(record({ message: 'y'.repeat(5000) }));
    const { lines } = await store.read('run-1');

    expect(lines[0]?.message).toBe('x'.repeat(2048));
    expect(lines[0]?.truncated).toBe(false);
    for (const line of lines.slice(1)) {
      expect(line.truncated).toBe(true);
      expect(line.message.endsWith(WORKFLOW_LOG_TRUNCATION_MARKER)).toBe(true);
      expect(ENCODER.encode(line.message).byteLength).toBeLessThanOrEqual(2048);
      expect(line.message).not.toContain('�');
    }
  });

  it('drops attributes that are too large or cannot be stored, and marks the line', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    class NotARecord {
      [key: string]: unknown;
      kind = 'instance';
    }
    store.sink(record({ message: 'big', attributes: { blob: 'z'.repeat(4000) } }));
    // A class instance is not a record once redacted, so there is nothing to store.
    store.sink(record({ message: 'instance', attributes: new NotARecord() }));
    store.sink(record({ message: 'fine', attributes: { count: 1 } }));
    const { lines } = await store.read('run-1');

    expect(lines.map((line) => [line.message, line.truncated, line.attributes])).toEqual([
      ['big', true, undefined],
      ['instance', true, undefined],
      ['fine', false, { count: 1 }],
    ]);
  });

  it('redacts attributes before they are stored, and keeps the line when a value is hostile', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    store.sink(
      record({
        message: 'redacted',
        attributes: {
          apiKey: 'x',
          cvv: 123,
          ssn: 123456789,
          when: new Date('x'),
          inputTokens: 5,
          passed: true,
        },
      }),
    );
    await store.flush();

    const { lines } = await store.read('run-1');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      message: 'redacted',
      truncated: false,
      attributes: {
        apiKey: '[REDACTED]',
        cvv: '[REDACTED]',
        ssn: '[REDACTED]',
        when: '[Invalid Date]',
        inputTokens: 5,
        passed: true,
      },
    });
    const raw: string[] = [];
    for await (const [, bytes] of storage.scan(KEYS.workflowLogPrefix('run-1'))) {
      raw.push(new TextDecoder().decode(bytes));
    }
    expect(raw.join('')).not.toContain('"x"');
  });

  it('redacts nested and value-shaped secrets, and a cyclic attribute is stored as a marker', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    store.sink(
      record({
        message: 'nested',
        attributes: {
          request: { headers: { authorization: 'Bearer abc.def' }, attempts: 2 },
          note: 'Bearer abc123',
          cyclic,
        },
      }),
    );
    const { lines } = await store.read('run-1');

    expect(lines[0]?.attributes).toEqual({
      request: { headers: { authorization: '[REDACTED]' }, attempts: 2 },
      note: '[REDACTED]',
      cyclic: { self: '[Circular]' },
    });
    expect(lines[0]?.truncated).toBe(false);
  });

  it('leaves the message and the host record untouched, and redacts attributes before the byte cap', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage, { maximumLineBytes: 100 });
    const attributes = { apiKey: 'k'.repeat(500), count: 3 };
    store.sink(record({ message: 'token=visible', attributes }));
    const { lines } = await store.read('run-1');

    // The secret's length does not count against the cap: what is stored is the redacted value.
    expect(lines[0]).toMatchObject({
      message: 'token=visible',
      truncated: false,
      attributes: { apiKey: '[REDACTED]', count: 3 },
    });
    expect(attributes.apiKey).toBe('k'.repeat(500));
  });

  it('drops the attributes and marks the line when redaction itself fails', async () => {
    await using storage = new MemoryStorage();
    const failures: unknown[] = [];
    const store = createWorkflowLogStore(storage, { onError: (error) => failures.push(error) });
    const spy = spyOn(debugOutput, 'sanitizeDebugValueForDisplay').mockImplementation(() => {
      throw new Error('redactor exploded');
    });
    try {
      store.sink(record({ message: 'guarded', attributes: { apiKey: 'x' } }));
    } finally {
      spy.mockRestore();
    }
    const { lines } = await store.read('run-1');

    expect(lines.map((line) => [line.message, line.truncated, line.attributes])).toEqual([
      ['guarded', true, undefined],
    ]);
    expect(failures).toEqual([]);
  });

  it('reads a line stored without a step as step null, and skips a line it cannot decode', async () => {
    await using storage = new MemoryStorage();
    await storage.put(
      KEYS.workflowLog('run-1', 0),
      ENCODER.encode(
        JSON.stringify({ level: 'info', message: 'old', timestamp: 5, workflowType: 'demo' }),
      ),
    );
    await storage.put(KEYS.workflowLog('run-1', 1), ENCODER.encode('{not json'));
    await storage.put(KEYS.workflowLog('run-1', 2), ENCODER.encode(JSON.stringify({ level: 1 })));
    const store = createWorkflowLogStore(storage);
    const { lines, dropped } = await store.read('run-1');

    expect(dropped).toBe(0);
    expect(lines).toEqual([
      {
        sequence: 0,
        step: null,
        level: 'info',
        message: 'old',
        timestamp: 5,
        workflowType: 'demo',
        truncated: false,
      },
    ]);
  });

  it('keeps the sequence going from a counter written before a restart', async () => {
    await using storage = new MemoryStorage();
    await storage.put(
      KEYS.workflowLogCounter('run-1'),
      ENCODER.encode(JSON.stringify({ next: 40, first: 30, dropped: 30, updatedAt: 1 })),
    );
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: 'after restart' }));
    const result = await store.read('run-1');

    expect(result.lines.map((line) => line.sequence)).toEqual([40]);
    expect(result.dropped).toBe(30);
  });

  it('prunes the runs whose last line is older than the window and keeps the others', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, { getNow: () => now });
    store.sink(record({ workflowId: 'old' }));
    await store.flush();
    now = 6 * 24 * 60 * 60 * 1000;
    store.sink(record({ workflowId: 'recent' }));
    await store.flush();
    now = 8 * 24 * 60 * 60 * 1000;

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 1 });
    expect(linesOf(await store.read('old'))).toEqual([]);
    expect(await storage.get(KEYS.workflowLogCounter('old'))).toBeNull();
    expect(linesOf(await store.read('recent'))).toHaveLength(1);

    now = 14 * 24 * 60 * 60 * 1000;
    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 1 });
    expect(linesOf(await store.read('recent'))).toEqual([]);
  });

  it('counts the lines an earlier eviction batch removed when the batch that follows it fails', async () => {
    await using storage = new MemoryStorage();
    const errors: unknown[] = [];
    const store = createWorkflowLogStore(storage, {
      maximumLinesPerRun: 3_000,
      onError: (error) => errors.push(error),
    });
    for (let line = 0; line < 3_000; line++) store.sink(record({ message: `old ${line}` }));
    await store.flush();

    // A burst of another 3000 lines evicts all 3000 old ones: 1000 in a batch of their own, then
    // the last 2000 with the new lines and the counter. That last batch fails.
    const batch = storage.batch.bind(storage);
    let calls = 0;
    const failure = new Error('disk full');
    storage.batch = async (operations) => {
      calls += 1;
      if (calls === 2) throw failure;
      return batch(operations);
    };
    for (let line = 0; line < 3_000; line++) store.sink(record({ message: `new ${line}` }));
    await store.flush();
    storage.batch = batch;

    expect(errors).toEqual([failure]);
    // What survives is the old lines the first batch did not remove, and the counter says so.
    const restarted = createWorkflowLogStore(storage, { maximumLinesPerRun: 3_000 });
    const after = await restarted.read('run-1');
    expect(after.lines).toHaveLength(2_000);
    expect(after.lines[0]?.sequence).toBe(1_000);
    expect(after.dropped).toBe(1_000);
  });

  it('prunes only the runs whose workflow record is over, and keeps the counter of the ones it empties', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, { getNow: () => now });
    const statuses = {
      running: false,
      pending: false,
      suspended: false,
      completed: true,
      failed: true,
      cancelled: true,
      'timed-out': true,
    } as const;
    for (const [status] of Object.entries(statuses)) {
      await storage.put(KEYS.workflow(status), encode({ id: status, status }));
      store.sink(record({ workflowId: status, message: 'one' }));
      store.sink(record({ workflowId: status, message: 'two' }));
    }
    await store.flush();
    now = 8 * 24 * 60 * 60 * 1000;

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 4 });
    for (const [status, over] of Object.entries(statuses)) {
      const result = await store.read(status);
      expect(messagesOf(result)).toEqual(over ? [] : ['one', 'two']);
      expect(droppedOf(result)).toBe(over ? 2 : 0);
    }

    // A run that is over keeps its counter, so a line it writes later takes the next sequence.
    store.sink(record({ workflowId: 'completed', message: 'three' }));
    expect(sequencedMessagesOf(await store.read('completed'))).toEqual([[2, 'three']]);
    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 0 });
  });

  it('leaves a run alone when another host writes to it between the pass reading its counter and removing its lines', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, { getNow: () => now });
    const otherHost = createWorkflowLogStore(storage, { getNow: () => now });
    await storage.put(KEYS.workflow('run-1'), encode({ id: 'run-1', status: 'completed' }));
    store.sink(record({ message: 'old life' }));
    await store.flush();
    now = 8 * 24 * 60 * 60 * 1000;

    // The finished id is started anew on another host, which logs its first line after this pass
    // read the expired counter and before it removes anything.
    const scan = storage.scan.bind(storage);
    let injected = false;
    storage.scan = (prefix, options) => {
      if (!injected && prefix === KEYS.workflowLogPrefix('run-1')) {
        injected = true;
        return (async function* () {
          otherHost.sink(record({ message: 'new life' }));
          await otherHost.flush();
          yield* scan(prefix, options);
        })();
      }
      return scan(prefix, options);
    };

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 0 });
    storage.scan = scan;
    expect(messagesOf(await store.read('run-1'))).toEqual(['old life', 'new life']);
  });

  it('prunes a finished run on a backend that cannot make a batch conditional', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const capabilities = storage.capabilities.bind(storage);
    storage.capabilities = () => ({ ...capabilities(), conditionalBatch: false });
    const store = createWorkflowLogStore(storage, { getNow: () => now });
    await storage.put(KEYS.workflow('run-1'), encode({ id: 'run-1', status: 'failed' }));
    store.sink(record({ message: 'old life' }));
    await store.flush();
    now = 8 * 24 * 60 * 60 * 1000;

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 1 });
    const after = await store.read('run-1');
    expect(after.lines).toEqual([]);
    expect(after.dropped).toBe(1);
  });

  it('leaves a run with more than one batch of lines alone when it is written to after the pass read its counter', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, { getNow: () => now, maximumLinesPerRun: 4_500 });
    const otherHost = createWorkflowLogStore(storage, {
      getNow: () => now,
      maximumLinesPerRun: 4_500,
    });
    await storage.put(KEYS.workflow('run-1'), encode({ id: 'run-1', status: 'completed' }));
    for (let line = 0; line < 4_500; line++) store.sink(record({ message: `line ${line}` }));
    await store.flush();
    now = 8 * 24 * 60 * 60 * 1000;

    const scan = storage.scan.bind(storage);
    let injected = false;
    storage.scan = (prefix, options) => {
      if (!injected && prefix === KEYS.workflowLogPrefix('run-1')) {
        injected = true;
        return (async function* () {
          otherHost.sink(record({ message: 'new life' }));
          await otherHost.flush();
          yield* scan(prefix, options);
        })();
      }
      return scan(prefix, options);
    };

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 0 });
    storage.scan = scan;
    const after = await store.read('run-1');
    // Nothing of the old life was removed before the guard stopped the pass.
    expect(after.lines.length).toBeGreaterThanOrEqual(4_500);
    expect(after.lines.at(-1)?.message).toBe('new life');
  });

  it('keeps the lines of a run whose workflow record cannot be read', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, { getNow: () => now });
    await storage.put(KEYS.workflow('run-1'), ENCODER.encode('not a workflow record'));
    store.sink(record({ message: 'kept' }));
    await store.flush();
    now = 8 * 24 * 60 * 60 * 1000;

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 0 });
    expect(messagesOf(await store.read('run-1'))).toEqual(['kept']);
  });

  it('removes a finished run’s lines in several batches when it kept more than one batch of them', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, {
      getNow: () => now,
      maximumLinesPerRun: 4_500,
    });
    await storage.put(KEYS.workflow('run-1'), encode({ id: 'run-1', status: 'completed' }));
    for (let line = 0; line < 4_500; line++) store.sink(record({ message: `line ${line}` }));
    await store.flush();
    expect(linesOf(await store.read('run-1'))).toHaveLength(4_500);
    now = 8 * 24 * 60 * 60 * 1000;

    expect(await store.prune({ olderThan: 7 * 24 * 60 * 60 * 1000 })).toEqual({ runs: 1 });

    const after = await store.read('run-1');
    expect(after.lines).toEqual([]);
    expect(after.dropped).toBe(4_500);
    store.sink(record({ message: 'next' }));
    expect(sequencedMessagesOf(await store.read('run-1'))).toEqual([[4_500, 'next']]);
  });

  it('writes a run afresh from sequence zero once its workflow record is gone and its lines were pruned', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const store = createWorkflowLogStore(storage, { getNow: () => now });
    store.sink(record({ message: 'first life' }));
    await store.flush();
    now = 100;
    await store.prune({ olderThan: 10 });
    store.sink(record({ message: 'second life' }));

    expect(sequencedMessagesOf(await store.read('run-1'))).toEqual([[0, 'second life']]);
  });

  it('reports a failed write, drops that batch, and keeps writing afterwards', async () => {
    await using storage = new MemoryStorage();
    const errors: unknown[] = [];
    const store = createWorkflowLogStore(storage, { onError: (error) => errors.push(error) });
    const failure = new Error('disk full');
    const batch = storage.batch.bind(storage);
    let failing = true;
    storage.batch = async (operations) => {
      if (failing) throw failure;
      return batch(operations);
    };
    store.sink(record({ message: 'lost' }));
    await store.flush();
    expect(errors).toEqual([failure]);

    failing = false;
    store.sink(record({ message: 'kept' }));
    expect(messagesOf(await store.read('run-1'))).toEqual(['kept']);
  });

  it('settles a flush while a workflow keeps logging during every write, and loses no line', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    const batch = storage.batch.bind(storage);
    let writes = 0;
    // A workflow that logs once per durable step logs again while the write of its last line is in
    // flight. That line belongs to the next drain: joining the one in flight would keep it, and every
    // flush and prune queued behind it, going for as long as the workflow logs.
    storage.batch = async (operations) => {
      writes += 1;
      if (writes <= 20) store.sink(record({ message: `during write ${writes}` }));
      return batch(operations);
    };
    store.sink(record({ message: 'first' }));
    const writesWhenFirstFlushSettled = store.flush().then(() => writes);

    expect(await writesWhenFirstFlushSettled).toBe(1);
    // Each later drain writes what the one before it left behind, until the last write has logged.
    // load-proof: each flush awaits the whole drain chain, so the count of drains is fixed by the writes and no timing is involved
    for (let drain = 0; drain < 25; drain++) await store.flush();
    const messages = messagesOf(await store.read('run-1'));
    expect(messages).toHaveLength(21);
    expect(messages[0]).toBe('first');
    expect(messages.at(-1)).toBe('during write 20');
  });

  it('cuts on the width of a character: three-byte and four-byte characters stay whole', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: '€'.repeat(1000) }));
    store.sink(record({ message: '😀'.repeat(600) }));
    const { lines } = await store.read('run-1');

    for (const line of lines) {
      expect(line.truncated).toBe(true);
      expect(ENCODER.encode(line.message).byteLength).toBeLessThanOrEqual(2048);
      expect(line.message).not.toContain('\uFFFD');
    }
  });

  it('honors a smaller line budget and falls back to the default for one that is not a positive integer', async () => {
    await using storage = new MemoryStorage();
    const small = createWorkflowLogStore(storage, { maximumLineBytes: 64 });
    small.sink(record({ workflowId: 'small', message: 'x'.repeat(200) }));
    const { lines: cut } = await small.read('small');
    expect(ENCODER.encode(cut[0]?.message ?? '').byteLength).toBeLessThanOrEqual(64);
    expect(cut[0]?.truncated).toBe(true);

    const fallback = createWorkflowLogStore(storage, { maximumLineBytes: -5 });
    fallback.sink(record({ workflowId: 'fallback', message: 'x'.repeat(2048) }));
    const { lines: kept } = await fallback.read('fallback');
    expect(kept[0]?.truncated).toBe(false);
  });

  it('reads a counter it cannot decode as a run that has written nothing', async () => {
    await using storage = new MemoryStorage();
    await storage.put(
      KEYS.workflowLogCounter('run-1'),
      ENCODER.encode(JSON.stringify({ next: 3, first: 0, dropped: 0, updatedAt: 'yesterday' })),
    );
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: 'fresh' }));

    expect(sequencesOf(await store.read('run-1'))).toEqual([0]);
  });

  it('survives an error reporter that throws, and a prune that fails', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage, {
      onError: () => {
        throw new Error('reporter');
      },
    });
    const batch = storage.batch.bind(storage);
    storage.batch = async () => {
      throw new Error('disk full');
    };
    store.sink(record({ message: 'lost' }));
    await store.flush();
    storage.batch = batch;
    store.sink(record({ message: 'kept' }));
    await store.flush();

    const scan = storage.scan.bind(storage);
    const failure = new Error('scan failed');
    storage.scan = () => {
      throw failure;
    };
    const outcome = await store.prune({ olderThan: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBe(failure);

    // The failed prune did not wedge the queue behind it.
    storage.scan = scan;
    expect(messagesOf(await store.read('run-1'))).toEqual(['kept']);
  });

  it('reports a run whose lines could not be removed and prunes the others', async () => {
    await using storage = new MemoryStorage();
    let now = 0;
    const errors: unknown[] = [];
    const store = createWorkflowLogStore(storage, {
      getNow: () => now,
      onError: (error) => errors.push(error),
    });
    store.sink(record({ workflowId: 'stuck' }));
    store.sink(record({ workflowId: 'gone' }));
    await store.flush();
    now = 1_000;
    const commit = storage.conditionalBatch.bind(storage);
    const failure = new Error('delete failed');
    storage.conditionalBatch = async (conditions, operations) => {
      if (operations.some((operation) => operation.key === KEYS.workflowLogCounter('stuck'))) {
        throw failure;
      }
      return commit(conditions, operations);
    };

    expect(await store.prune({ olderThan: 10 })).toEqual({ runs: 1 });
    expect(errors).toEqual([failure]);
    expect(linesOf(await store.read('gone'))).toEqual([]);
  });

  it('stores nothing for a record marked as a repeat of an earlier execution', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    store.sink(record({ message: 'once' }));
    store.sink(record({ message: 'once', replayed: true }));
    store.sink(record({ message: 'next' }));
    await store.flush();

    expect(sequencedMessagesOf(await store.read('run-1'))).toEqual([
      [0, 'once'],
      [1, 'next'],
    ]);
  });

  it('holds a line, its message and attributes together, to the byte cap', async () => {
    await using storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage, { maximumLineBytes: 200 });
    // Each part fits alone; together they would be 300 bytes.
    store.sink(record({ message: 'm'.repeat(150), attributes: { note: 'n'.repeat(130) } }));
    // Together they fit.
    store.sink(record({ message: 'short', attributes: { note: 'n'.repeat(100) } }));
    await store.flush();

    const stored = await store.read('run-1');
    const [crowded, fitting] = stored.lines;
    expect(crowded?.attributes).toBeUndefined();
    expect(crowded?.truncated).toBe(true);
    expect(crowded?.message).toBe('m'.repeat(150));
    expect(fitting?.attributes).toEqual({ note: 'n'.repeat(100) });
    expect(fitting?.truncated).toBe(false);
    for (const line of stored.lines) {
      const size =
        ENCODER.encode(line.message).byteLength +
        (line.attributes === undefined
          ? 0
          : ENCODER.encode(JSON.stringify(line.attributes)).byteLength);
      expect(size).toBeLessThanOrEqual(200);
    }
  });

  it('never throws from the sink, whatever the record holds', async () => {
    await using storage = new MemoryStorage();
    const errors: unknown[] = [];
    const store = createWorkflowLogStore(storage, { onError: (error) => errors.push(error) });
    const hostile = {
      ...record(),
      get message(): string {
        throw new Error('getter');
      },
    } as WorkflowLogRecord;

    expect(() => store.sink(hostile)).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
