import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { captureWorkflowLogConsoleWithMethods } from '../../testing/workflow-log-capture.test-support.ts';
import { Context } from '../context.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';
import { getInternals } from './internals.ts';
import { createWorkflowLogger, type WorkflowLoggerBindings } from './workflow-logger.ts';

describe('createWorkflowLogger (shared factory)', () => {
  let captured: ReturnType<typeof captureWorkflowLogConsoleWithMethods>;
  beforeEach(() => {
    captured = captureWorkflowLogConsoleWithMethods();
  });
  afterEach(() => {
    captured.restore();
  });

  function bindings(overrides: Partial<WorkflowLoggerBindings> = {}): WorkflowLoggerBindings {
    return {
      workflowId: 'wf-1',
      workflowType: 'demo',
      isReplaying: () => false,
      now: () => 1_700_000_000_000,
      ...overrides,
    };
  }

  it('emits a structured record with the envelope auto-fields on each level', () => {
    const logger = createWorkflowLogger(bindings());
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(captured.records.map((r) => r.method)).toEqual(['debug', 'info', 'warn', 'error']);
    for (const { record } of captured.records) {
      expect(record.workflowId).toBe('wf-1');
      expect(record.workflowType).toBe('demo');
      expect(record.timestamp).toBe(1_700_000_000_000);
    }
    expect(captured.records[0]!.record).toMatchObject({ level: 'debug', message: 'd' });
    expect(captured.records[3]!.record).toMatchObject({ level: 'error', message: 'e' });
  });

  it('nests caller attributes so they cannot shadow envelope fields', () => {
    const logger = createWorkflowLogger(bindings());
    logger.error('boom', { workflowId: 'attacker', workflowType: 'attacker', detail: 42 });

    const { record } = captured.records[0]!;
    // Envelope keeps the real identity; the attacker values are quarantined.
    expect(record.workflowId).toBe('wf-1');
    expect(record.workflowType).toBe('demo');
    expect(record.attributes).toEqual({
      workflowId: 'attacker',
      workflowType: 'attacker',
      detail: 42,
    });
  });

  it('omits the attributes key entirely when no attributes are supplied', () => {
    const logger = createWorkflowLogger(bindings());
    logger.info('plain');
    expect('attributes' in captured.records[0]!.record).toBe(false);
  });

  it('suppresses emission while isReplaying() is true', () => {
    let replaying = true;
    const logger = createWorkflowLogger(bindings({ isReplaying: () => replaying }));
    logger.info('during replay');
    expect(captured.records).toHaveLength(0);

    replaying = false;
    logger.info('live');
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]!.record.message).toBe('live');
  });

  it('re-evaluates isReplaying() per call (not captured once)', () => {
    const flags = [true, false, true];
    let i = 0;
    const logger = createWorkflowLogger(bindings({ isReplaying: () => flags[i++]! }));
    logger.info('a'); // replaying → suppressed
    logger.info('b'); // live → emitted
    logger.info('c'); // replaying → suppressed
    expect(captured.records.map((r) => r.record.message)).toEqual(['b']);
  });

  describe('host sink (EngineOptions.onLog)', () => {
    it('routes records to the sink INSTEAD of the console when a sink is installed', () => {
      const sunk: WorkflowLogRecord[] = [];
      const logger = createWorkflowLogger(bindings({ sink: (r) => sunk.push(r) }));
      logger.info('to-sink', { k: 1 });

      // The host sink received the full structured record...
      expect(sunk).toHaveLength(1);
      expect(sunk[0]).toMatchObject({
        level: 'info',
        message: 'to-sink',
        workflowId: 'wf-1',
        workflowType: 'demo',
        attributes: { k: 1 },
      });
      // ...and the console was NOT also called (opt-out, no duplicate noise).
      expect(captured.records).toHaveLength(0);
    });

    it('falls back to the console when no sink is installed (default behavior preserved)', () => {
      const logger = createWorkflowLogger(bindings());
      logger.warn('to-console');
      expect(captured.records.map((r) => r.record.message)).toEqual(['to-console']);
    });

    it('does not call the sink for records suppressed during replay', () => {
      const sunk: WorkflowLogRecord[] = [];
      const logger = createWorkflowLogger(
        bindings({ isReplaying: () => true, sink: (r) => sunk.push(r) }),
      );
      logger.error('replayed');
      expect(sunk).toHaveLength(0);
      expect(captured.records).toHaveLength(0);
    });
  });
});

describe('Context.log (inline replay-safety)', () => {
  let captured: ReturnType<typeof captureWorkflowLogConsoleWithMethods>;
  beforeEach(() => {
    captured = captureWorkflowLogConsoleWithMethods();
  });
  afterEach(() => {
    captured.restore();
  });

  function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
    return new Context({
      workflowId: 'wf-inline',
      workflowType: 'inline-demo',
      startedAt: 1000,
      abortController: new AbortController(),
      getNow: () => 555,
      ...overrides,
    });
  }

  it('emits at the live frontier (no cached step at the current stepIndex)', () => {
    const context = createContext();
    // Fresh run: raw accumulatedResults is undefined → not replaying.
    expect(getInternals(context).accumulatedResults).toBeUndefined();
    context.log.info('hello', { k: 'v' });
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]!.record).toMatchObject({
      level: 'info',
      message: 'hello',
      workflowId: 'wf-inline',
      workflowType: 'inline-demo',
      timestamp: 555,
      attributes: { k: 'v' },
    });
  });

  it('suppresses when the current stepIndex is an already-cached (replaying) step', () => {
    const context = createContext();
    // Simulate a recovered run replaying step 0: cache holds step 0 and the
    // frontier (stepIndex) still points at 0.
    context.accumulatedResults.set(0, 'cached');
    getInternals(context).stepIndex = 0;
    context.log.warn('should be suppressed');
    expect(captured.records).toHaveLength(0);
  });

  it('emits once the frontier advances past the cached prefix', () => {
    const context = createContext();
    context.accumulatedResults.set(0, 'cached');
    // Frontier moved to step 1, which is NOT cached → live.
    getInternals(context).stepIndex = 1;
    context.log.info('live again');
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]!.record.message).toBe('live again');
  });

  it('reads the RAW accumulatedResults field — a fresh context never allocates a map via the probe', () => {
    const context = createContext();
    context.log.info('probe');
    // The replay probe must not have allocated an empty map (which would change
    // the undefined-means-not-replaying sentinel for downstream readers).
    expect(getInternals(context).accumulatedResults).toBeUndefined();
  });

  it('is replay-safe across a ctx.all step boundary (advisor-required)', () => {
    // After a fully-cached ctx.all at step 0 (3 sub-ops), replay reconciles the
    // frontier to step 1 + 3 = 4 (see parallel-operations.ts line 91). A log
    // placed right after the ctx.all must observe the reconciled frontier: if
    // step 4 is cached it suppresses, if step 4 is the live edge it emits.
    const replayingContext = createContext();
    // Cache the ctx.all parent entry at 0 and the next real step at 4.
    replayingContext.accumulatedResults.set(0, 'all-entry');
    replayingContext.accumulatedResults.set(4, 'next-step');
    getInternals(replayingContext).stepIndex = 4; // frontier after ctx.all reconciliation
    replayingContext.log.info('after ctx.all — replaying');
    expect(captured.records).toHaveLength(0);

    // Same shape, but step 4 is the live frontier (not cached) → emits.
    captured.restore();
    captured = captureWorkflowLogConsoleWithMethods();
    const liveContext = createContext();
    liveContext.accumulatedResults.set(0, 'all-entry');
    getInternals(liveContext).stepIndex = 4;
    liveContext.log.info('after ctx.all — live');
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]!.record.message).toBe('after ctx.all — live');
  });

  it('does not advance stepIndex (ctx.log consumes no durable position)', () => {
    const context = createContext();
    const before = getInternals(context).stepIndex;
    context.log.info('one');
    context.log.warn('two');
    context.log.error('three');
    expect(getInternals(context).stepIndex).toBe(before);
  });
});
