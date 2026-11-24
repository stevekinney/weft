/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. Each case names a workflow, activity, attribute, or option `constructor`, so a read
 * that skips `Object.hasOwn` finds `Object` and treats it as a declared entry.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { throwingRejectionOf } from "../test-support/embedded/testing/src/helpers/promise-outcome.ts";

import { parseWorkflowArguments } from './cli/noun-verb-arguments.ts';
import { collectDiffLines } from './cli/utilities.ts';
import { httpClientOperationTransport } from './client/http-operations.ts';
import { readActivityRetryAttempt } from './core/context/activity-retry-state.ts';
import { getAttribute, validateAttribute } from './core/context/attributes.ts';
import { Engine } from './core/engine.ts';
import { readEnvironmentVariableFromSources } from './core/engine/construction.ts';
import { buildIndexOperations } from './core/search-attributes.ts';
import { workflow } from './core/types.ts';
import { readEnvironmentVariable } from './runtime/environment-configuration.ts';
import { getRequiredRouteParameter } from './server/handler/route-matching.ts';
import { executionRequirementFromWorkflowWorkerBinding } from './worker/binding-helpers.ts';
import { buildWorkerExecutionIdentity } from './worker/manifest/execution-identity.ts';
import { singleWorkflowManifest } from './worker/manifest/fixtures.test-support.ts';
import { workerMatchesRequirement } from './worker/registry/routing.ts';
import type { WorkerInfo } from './worker/registry/types.ts';
import type { WorkflowWorkerBinding } from './worker/versioning-policy.ts';

afterEach(() => {
  mock.restore();
});

describe('names that every object inherits', () => {
  it('is not a workflow subcommand', () => {
    expect(() => parseWorkflowArguments(['constructor'])).toThrow(/expected a subcommand/);
    expect(() => parseWorkflowArguments(['toString'])).toThrow(/expected a subcommand/);
  });

  it('is a missing key, not a changed value, when two documents are compared', () => {
    const before = { shared: 1 };
    const after = JSON.parse('{"shared":1,"constructor":2}') as unknown;
    const lines: string[] = [];
    collectDiffLines(before, after, '', lines);
    expect(lines).toEqual(['constructor: undefined -> 2']);
  });

  it('is a missing route parameter', () => {
    expect(() => getRequiredRouteParameter({}, 'constructor', 'GET /v1/things/:id')).toThrow(
      'Missing route parameter "constructor"',
    );
  });

  it('is not an environment variable the runtime has set', () => {
    expect(readEnvironmentVariable('constructor')).toBeUndefined();
    expect(readEnvironmentVariableFromSources('constructor', { processEnv: {} })).toBeUndefined();
    expect(readEnvironmentVariableFromSources('constructor', { bunEnv: {} })).toBeUndefined();
  });

  it('is not a search attribute the context declared', () => {
    const internals = {
      searchAttributeSchema: { region: { type: 'string' } },
      searchAttributes: { region: 'eu' },
    } as unknown as Parameters<typeof validateAttribute>[0];
    expect(() => validateAttribute(internals, 'constructor', 'x')).toThrow(
      /Unknown search attribute "constructor"/,
    );
    expect(getAttribute(internals, 'constructor')).toBeUndefined();
    expect(getAttribute(internals, 'region')).toBe('eu');
  });

  it('is an attribute that appeared, not one that was always there', () => {
    const current = JSON.parse('{"constructor":"x"}') as Record<string, string>;
    const withInherited = buildIndexOperations('wf-1', {}, current);
    const withOwn = buildIndexOperations('wf-1', { constructor: 'x' }, current);
    expect(withInherited.map((operation) => operation.type)).toEqual(['put']);
    expect(withOwn).toEqual([]);
  });

  it('has no checkpointed retry attempt', () => {
    const internals = {
      checkpointLocals: {
        __weftActivityRetryState: { version: 1, attempts: {}, completedRetrySleeps: {} },
      },
    } as unknown as Parameters<typeof readActivityRetryAttempt>[0];
    expect(readActivityRetryAttempt(internals, 'constructor')).toBeUndefined();
  });
});

describe('a manifest that advertises one workflow and one activity', () => {
  const source = {
    manifest: singleWorkflowManifest(),
    manifestDigest: 'sha256:deadbeef',
    workerId: 'worker-1',
    workflowType: 'checkout',
    activityName: 'charge',
  } as const;

  it('has no execution identity for a workflow or activity named constructor', () => {
    expect(buildWorkerExecutionIdentity(source)).toBeDefined();
    expect(
      buildWorkerExecutionIdentity({ ...source, workflowType: 'constructor' }),
    ).toBeUndefined();
    expect(
      buildWorkerExecutionIdentity({ ...source, activityName: 'constructor' }),
    ).toBeUndefined();
  });

  it('does not route an activity named constructor to the worker', () => {
    const worker = { manifest: source.manifest } as unknown as WorkerInfo;
    expect(workerMatchesRequirement(worker, {}, 'charge')).toBe(true);
    expect(workerMatchesRequirement(worker, {}, 'constructor')).toBe(false);
  });

  it('falls back to the binding hash for an activity named constructor', () => {
    const binding = {
      deploymentName: 'billing',
      buildId: 'b3',
      artifactDigest: 'sha256:41d0',
      workflowRevision: 'rev-8',
      activityContracts: { charge: 'sha256:bb' },
      activityName: 'charge',
      activityContractHash: 'sha256:fallback',
    } as unknown as WorkflowWorkerBinding;
    expect(
      executionRequirementFromWorkflowWorkerBinding(binding, 'charge').activityContractHash,
    ).toBe('sha256:bb');
    expect(
      executionRequirementFromWorkflowWorkerBinding(binding, 'constructor').activityContractHash,
    ).toBe('sha256:fallback');
  });
});

describe('an engine whose workflow declares one search attribute', () => {
  function engineWithSchema(): Engine {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'typed' })
        .searchAttributes({ region: { type: 'string' } })
        .execute(async function* () {
          return 'ok';
        }),
    );
    return engine;
  }

  it('refuses to start a workflow with an attribute named constructor', async () => {
    const engine = engineWithSchema();
    expect(
      await throwingRejectionOf(
        engine.start('typed', null, { id: 'wf-1', searchAttributes: { constructor: 'x' } }),
      ),
    ).toThrow(/Unknown search attribute "constructor"/);
    engine[Symbol.dispose]();
  });

  it('refuses to group by an attribute named constructor', async () => {
    const engine = engineWithSchema();
    const handle = await engine.start('typed', null, { id: 'wf-1' });
    await handle.result();
    expect(
      await throwingRejectionOf(
        engine.aggregate(undefined, { groupBy: { attribute: 'constructor' } }),
      ),
    ).toThrow(/Unknown search attribute/);
    engine[Symbol.dispose]();
  });

  it('refuses to set an attribute named constructor on a running workflow', async () => {
    const engine = engineWithSchema();
    const handle = await engine.start('typed', null, { id: 'wf-1' });
    await handle.result();
    expect(await throwingRejectionOf(engine.setAttributes('wf-1', { constructor: 'x' }))).toThrow(
      /Unknown search attribute "constructor"/,
    );
    engine[Symbol.dispose]();
  });
});

describe('a client whose REST bindings name one operation', () => {
  it('sends an operation named constructor over JSON-RPC, not through a REST binding', async () => {
    const calls: string[] = [];
    const fetchImplementation: typeof fetch = Object.assign(
      async (...arguments_: Parameters<typeof fetch>) => {
        const [input] = arguments_;
        calls.push(input instanceof Request ? input.url : input.toString());
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'rpc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
    const transport = httpClientOperationTransport('https://weft.example', {}, {});

    await transport('constructor', {});

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('/v1/');
  });
});
