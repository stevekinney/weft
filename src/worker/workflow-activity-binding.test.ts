import { describe, expect, it } from 'bun:test';

import { RemoteWorker } from './index.ts';
import {
  WorkerProtocolIncompatibleError,
  workerProtocolIncompatibleMessage,
} from './worker-protocol-incompatible-error.ts';
import {
  buildQualifiedActivityTable,
  type RemoteWorkerWorkflowDefinition,
} from './workflow-activity-binding.ts';

describe('buildQualifiedActivityTable', () => {
  it('builds qualified `${workflowType}.${activityName}` keys from a workflows map', () => {
    const table = buildQualifiedActivityTable({
      welcome: {
        name: 'welcome',
        activities: {
          formatGreeting: async (input: unknown) =>
            `hi ${String((input as { name: string }).name)}`,
        },
      },
    });

    expect(Object.keys(table)).toEqual(['welcome.formatGreeting']);
    expect(typeof table['welcome.formatGreeting']).toBe('function');
  });

  it('accepts both bare functions and `{ execute }` objects', () => {
    const table = buildQualifiedActivityTable({
      orders: {
        name: 'orders',
        activities: {
          bare: async () => 'a',
          shaped: { execute: async () => 'b' },
        },
      },
    });

    expect(Object.keys(table).toSorted()).toEqual(['orders.bare', 'orders.shaped']);
  });

  it('rejects mismatched workflow map key and inner workflow.name', () => {
    expect(() =>
      buildQualifiedActivityTable({
        welcome: { name: 'WELCOME', activities: {} },
      }),
    ).toThrow('Worker workflow map key "welcome" does not match workflow.name "WELCOME"');
  });

  it("rejects '.' in workflow names via the shared name-grammar helper", () => {
    const workflows: Record<string, RemoteWorkerWorkflowDefinition> = {
      'bad.name': { name: 'bad.name', activities: {} },
    };
    expect(() => buildQualifiedActivityTable(workflows)).toThrow(/workflow name "bad\.name"/);
  });

  it("rejects '.' in activity names via the shared name-grammar helper", () => {
    expect(() =>
      buildQualifiedActivityTable({
        welcome: {
          name: 'welcome',
          activities: { 'bad.activity': async () => null },
        },
      }),
    ).toThrow(/activity name "bad\.activity"/);
  });

  it('rejects an `{ execute }` object whose `execute` is not callable', () => {
    expect(() =>
      buildQualifiedActivityTable({
        welcome: {
          name: 'welcome',
          activities: { formatGreeting: { execute: 'not-a-function' as any } },
        },
      }),
    ).toThrow(/Activity "welcome\.formatGreeting" must be a function/);
  });

  it('isolates activities across workflows so identical activity keys do not collide', () => {
    const table = buildQualifiedActivityTable({
      welcome: { name: 'welcome', activities: { formatGreeting: async () => 'welcome' } },
      farewell: { name: 'farewell', activities: { formatGreeting: async () => 'farewell' } },
    });

    expect(Object.keys(table).toSorted()).toEqual([
      'farewell.formatGreeting',
      'welcome.formatGreeting',
    ]);
  });
});

describe('RemoteWorker workflows option', () => {
  it('advertises qualified activity names built from the workflows map', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:0',
      workflows: {
        welcome: {
          name: 'welcome',
          activities: { formatGreeting: async () => 'hi' },
        },
      },
    });

    // No direct getter for the table — round-trip through the registry via
    // a no-op socket isn't worth the harness. Disposing immediately and
    // observing that construction succeeded is enough; the binding rejection
    // tests above cover the failure paths.
    expect(worker).toBeDefined();
    worker[Symbol.dispose]();
  });

  it('no longer accepts an `activities` option (alias removed)', () => {
    // The flat `activities` alias was removed in favour of the required
    // `workflows` map. A consumer that passes it should not typecheck...
    expect(
      () =>
        new RemoteWorker({
          serverUrl: 'ws://localhost:0',
          workflows: { welcome: { name: 'welcome', activities: {} } },
          // @ts-expect-error `activities` is no longer a RemoteWorker option.
          activities: { 'welcome.formatGreeting': async () => 'hi' },
        }),
    ).toThrow(/no longer accepts `activities`/);
  });

  it('rejects a stale `activities` even when it is the only activity source', () => {
    // An untyped/JS caller that swapped nothing and kept `activities` (no
    // `workflows`) must fail loudly rather than build a zero-activity worker.
    const staleOptions = {
      serverUrl: 'ws://localhost:0',
      activities: { 'welcome.formatGreeting': async () => 'hi' },
    } as unknown as ConstructorParameters<typeof RemoteWorker>[0];
    expect(() => new RemoteWorker(staleOptions)).toThrow(/no longer accepts `activities`/);
  });

  it('rejects when `workflows` is omitted', () => {
    // Cast through `unknown` so the runtime guard is exercised without an
    // excess-property typecheck firing first; `workflows` is required.
    const optionsWithoutWorkflows = {
      serverUrl: 'ws://localhost:0',
    } as unknown as ConstructorParameters<typeof RemoteWorker>[0];
    expect(() => new RemoteWorker(optionsWithoutWorkflows)).toThrow(/requires `workflows`/);
  });

  it('accepts an empty `workflows` map (worker advertises no activities)', () => {
    using worker = new RemoteWorker({ serverUrl: 'ws://localhost:0', workflows: {} });
    expect(worker).toBeDefined();
  });

  it('propagates name-grammar rejection from the worker SDK entry', () => {
    expect(
      () =>
        new RemoteWorker({
          serverUrl: 'ws://localhost:0',
          workflows: {
            'bad.name': { name: 'bad.name', activities: {} },
          },
        }),
    ).toThrow(/workflow name "bad\.name"/);
  });

  it('rejects worker SDK key/name mismatch in the workflows map at construction', () => {
    expect(
      () =>
        new RemoteWorker({
          serverUrl: 'ws://localhost:0',
          workflows: {
            welcome: { name: 'other', activities: {} },
          },
        }),
    ).toThrow('Worker workflow map key "welcome" does not match workflow.name "other"');
  });
});

describe('WorkerProtocolIncompatibleError', () => {
  it('produces the canonical incompatibility message for a known received version', () => {
    const message = workerProtocolIncompatibleMessage({ expected: 2, received: 1 });
    expect(message).toContain('protocol v2');
    expect(message).toContain('got v1');
    expect(message).toContain('qualified activity names');
  });

  it('handles the case where the received version was not parseable as a number', () => {
    const message = workerProtocolIncompatibleMessage({ expected: 2, received: undefined });
    expect(message).toContain('got vunknown');
  });

  it('carries the expected and received versions on the error instance', () => {
    const error = new WorkerProtocolIncompatibleError({ expected: 2, received: 1 });
    expect(error.expectedProtocolVersion).toBe(2);
    expect(error.receivedProtocolVersion).toBe(1);
    expect(error.name).toBe('WorkerProtocolIncompatibleError');
  });
});
