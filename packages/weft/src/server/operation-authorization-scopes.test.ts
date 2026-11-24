import { AUTHORIZATION_SCOPES } from '../authorization-scopes.ts';
/**
 * Authorization scopes on Weft's catalog operations (COR-1466).
 *
 * Every operation except `weft.system.principal` requires a scope. These tests
 * pin the scope each operation requires, prove each is refused without it and
 * allowed with it, and fail the suite when a new operation is declared
 * `public`.
 */

import { describe, expect, it } from 'bun:test';

import {
  anonymousPrincipal,
  principalFromApiKey,
  type AuthorizationScope,
  type Principal,
} from "../embedded/backchannel/src/index.ts";
import { evaluateAccess } from "../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from './local-user-request.test-support.ts';
import { workflowEventsSseOperation } from './operations/workflow-events-sse.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

/** The scope table from COR-1466: operation name → the scope it requires. */
const REQUIRED_SCOPE_BY_OPERATION: Readonly<Record<string, AuthorizationScope>> = {
  'weft.workflows.get': 'workflows:read',
  'weft.workflows.list': 'workflows:read',
  'weft.workflows.aggregate': 'workflows:read',
  'weft.workflows.timeline.get': 'workflows:read',
  'weft.workflows.result.get': 'workflows:read',
  'weft.workflows.checkpoints.get': 'workflows:read',
  'weft.workflows.checkpoints.list': 'workflows:read',
  'weft.workflows.compare': 'workflows:read',
  'weft.workflows.scheduleprovenance.get': 'workflows:read',
  'weft.workflows.finalizer.get': 'workflows:read',
  'weft.updates.result.get': 'workflows:read',
  'weft.workflows.updates.list': 'workflows:read',
  'weft.workflows.logs.list': 'workflows:read',
  'weft.workflows.start': 'workflows:write',
  'weft.workflows.fork': 'workflows:write',
  'weft.workflows.cancel': 'workflows:write',
  'weft.workflows.suspend': 'workflows:write',
  'weft.workflows.resume': 'workflows:write',
  'weft.workflows.timeout': 'workflows:write',
  'weft.workflows.signal': 'signals:write',
  'weft.workflows.tags.add': 'tags:write',
  'weft.workflows.tags.remove': 'tags:write',
  'weft.workflows.purge': 'workflows:admin',
  'weft.recover.all': 'workflows:admin',
  'weft.workflows.update': 'updates:write',
  'weft.workflows.query': 'queries:read',
  'weft.workflows.events.list': 'events:read',
  'weft.workflows.attributes.get': 'attributes:read',
  'weft.workflows.attributes.set': 'attributes:write',
  'weft.workflows.streams.chunks': 'streams:read',
  'weft.workflows.streams.sse': 'streams:read',
  'weft.schedules.create': 'schedules:write',
  'weft.schedules.update': 'schedules:write',
  'weft.schedules.pause': 'schedules:write',
  'weft.schedules.resume': 'schedules:write',
  'weft.schedules.skipnext': 'schedules:write',
  'weft.schedules.unskip': 'schedules:write',
  'weft.schedules.runnow': 'schedules:write',
  'weft.schedules.missed': 'schedules:read',
  'weft.schedules.cancel': 'schedules:write',
  'weft.reviews.get': 'reviews:read',
  'weft.reviews.decision.submit': 'reviews:write',
  'weft.retention.get': 'system:read',
  'weft.schedules.list': 'schedules:read',
  'weft.schedules.get': 'schedules:read',
};

/**
 * Operations in the same families that already required a scope, so they are
 * not part of the COR-1466 table. Listed so the completeness test below sees
 * every `weft.workflows.*`, `weft.schedules.*`, `weft.reviews.*`, and
 * `weft.retention.*` operation and fails when a new one is added unclassified.
 */
const ALREADY_SCOPED_OPERATIONS: Readonly<Record<string, AuthorizationScope>> = {
  'weft.workflows.bulk.cancel': 'workflows:admin',
  'weft.workflows.bulk.signal': 'workflows:admin',
  'weft.workflows.bulk.retryfailed': 'workflows:admin',
  'weft.workflows.bulk.delete': 'workflows:admin',
  'weft.workflows.bulk.tags': 'workflows:admin',
  'weft.workflows.activities.pending.list': 'workflows:read',
  'weft.workflows.revisions.install': 'workflows:admin',
  'weft.workflows.revisions.activate': 'workflows:admin',
  'weft.workflows.revisions.preload': 'workflows:admin',
  'weft.workflows.refresh': 'workflows:admin',
  'weft.workflows.refresh.diagnostics': 'workflows:read',
  'weft.workflows.revisions.get': 'workflows:read',
  'weft.workflows.revisions.list': 'workflows:read',
  'weft.workflows.active.get': 'workflows:read',
  'weft.reviews.list': 'reviews:read',
  'weft.workflows.replay': 'workflows:read',
};

/**
 * The definitions catalog is readable under either of two scopes: it describes
 * what the engine can run, which both the system-level and workflow-level
 * readers already see in pieces (COR-1554).
 */
const DEFINITION_CATALOG_OPERATIONS: readonly string[] = [
  'weft.workflows.definitions.list',
  'weft.workflows.definitions.get',
];

/**
 * Operations that need an authenticated caller and no particular scope. None of
 * the families this test classifies is in this group today; it stays so a new
 * authenticated-only operation is a deliberate, reviewed addition.
 */
const AUTHENTICATED_ONLY_OPERATIONS: readonly string[] = [];

/**
 * The two workflow event feeds keep `access: { kind: 'authenticated' }`, but
 * their `authorize` hooks require a scope that depends on the selector, so they
 * are not authenticated-only in practice. `workflow-event-feed-authorization.test.ts`
 * covers each selector on both transports; this bucket pins the static policy
 * and that the hook refuses a principal with no scopes.
 */
const SELECTOR_AUTHORIZED_OPERATIONS: readonly string[] = [
  'weft.workflows.events',
  'weft.workflows.events.sse',
];

const registry = createLiveOperationRegistry();

function accessOf(operationName: string) {
  const operation = registry.get(operationName);
  if (operation === undefined) throw new Error(`operation ${operationName} is not registered`);
  return operation.access;
}

function principalHolding(scopes: readonly AuthorizationScope[]) {
  return principalFromApiKey({ subject: 'scope-table-test', scopes });
}

describe('the scope an operation requires', () => {
  const everyScopedOperation = { ...REQUIRED_SCOPE_BY_OPERATION, ...ALREADY_SCOPED_OPERATIONS };
  for (const [operationName, scope] of Object.entries(everyScopedOperation)) {
    describe(`${operationName} requires ${scope}`, () => {
      it('declares the scope', () => {
        expect(accessOf(operationName)).toEqual({
          kind: 'scoped',
          scopes: { kind: 'anyOf', scopes: [scope] },
        });
      });

      it('is allowed with the scope', () => {
        expect(evaluateAccess(accessOf(operationName), principalHolding([scope]))).toEqual({
          allowed: true,
        });
      });

      it('is refused with every other scope', () => {
        const others = AUTHORIZATION_SCOPES.filter((candidate) => candidate !== scope);
        const result = evaluateAccess(accessOf(operationName), principalHolding(others));
        expect(result).toMatchObject({ allowed: false, classification: 'forbidden' });
      });

      it('is refused to an anonymous caller', () => {
        expect(evaluateAccess(accessOf(operationName), anonymousPrincipal())).toMatchObject({
          allowed: false,
          classification: 'unauthorized',
        });
      });

      if (operationName in REQUIRED_SCOPE_BY_OPERATION) {
        it('is discoverable although it is no longer public', () => {
          expect(registry.get(operationName)?.discoverable).toBe(true);
        });
      }
    });
  }

  for (const operationName of AUTHENTICATED_ONLY_OPERATIONS) {
    it(`${operationName} needs an authenticated caller and no particular scope`, () => {
      const access = accessOf(operationName);
      expect(access).toEqual({ kind: 'authenticated' });
      expect(evaluateAccess(access, principalHolding([]))).toEqual({ allowed: true });
      expect(evaluateAccess(access, anonymousPrincipal())).toMatchObject({ allowed: false });
    });
  }
});

describe('the definitions catalog requires system:read or workflows:read', () => {
  for (const operationName of DEFINITION_CATALOG_OPERATIONS) {
    describe(operationName, () => {
      it('declares an anyOf of both read scopes', () => {
        expect(accessOf(operationName)).toEqual({
          kind: 'scoped',
          scopes: { kind: 'anyOf', scopes: ['system:read', 'workflows:read'] },
        });
        expect(registry.get(operationName)?.discoverable).toBe(true);
      });

      it.each(['system:read', 'workflows:read'] as const)('is allowed with %s alone', (scope) => {
        expect(evaluateAccess(accessOf(operationName), principalHolding([scope]))).toEqual({
          allowed: true,
        });
      });

      it('is refused with every other scope', () => {
        const others = AUTHORIZATION_SCOPES.filter(
          (candidate) => candidate !== 'system:read' && candidate !== 'workflows:read',
        );
        expect(evaluateAccess(accessOf(operationName), principalHolding(others))).toMatchObject({
          allowed: false,
          classification: 'forbidden',
        });
      });

      it('is refused to an anonymous caller', () => {
        expect(evaluateAccess(accessOf(operationName), anonymousPrincipal())).toMatchObject({
          allowed: false,
          classification: 'unauthorized',
        });
      });
    });
  }
});

describe('weft.workflows.startorsignal requires workflows:write and signals:write', () => {
  const name = 'weft.workflows.startorsignal';

  it('declares an allOf of both scopes', () => {
    expect(accessOf(name)).toEqual({
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['workflows:write', 'signals:write'] },
    });
    expect(registry.get(name)?.discoverable).toBe(true);
  });

  it('is allowed with both scopes', () => {
    const principal = principalHolding(['workflows:write', 'signals:write']);
    expect(evaluateAccess(accessOf(name), principal)).toEqual({ allowed: true });
  });

  it('is forbidden with only workflows:write', () => {
    const principal = principalHolding(['workflows:write']);
    expect(evaluateAccess(accessOf(name), principal)).toMatchObject({
      allowed: false,
      classification: 'forbidden',
    });
  });

  it('is forbidden with only signals:write', () => {
    const principal = principalHolding(['signals:write']);
    expect(evaluateAccess(accessOf(name), principal)).toMatchObject({
      allowed: false,
      classification: 'forbidden',
    });
  });

  it('is forbidden with neither scope', () => {
    const principal = principalHolding(['workflows:read', 'workflows:admin']);
    expect(evaluateAccess(accessOf(name), principal)).toMatchObject({
      allowed: false,
      classification: 'forbidden',
    });
  });

  it('is unauthorized for an anonymous caller', () => {
    expect(evaluateAccess(accessOf(name), anonymousPrincipal())).toMatchObject({
      allowed: false,
      classification: 'unauthorized',
    });
  });

  it('delivers no signal to a running workflow when the caller lacks signals:write', async () => {
    const waiter = workflow({ name: 'start-or-signal-scope-waiter' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('release');
    });
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(waiter);
    const handle = await engine.start('start-or-signal-scope-waiter', {}, { id: 'scope-target' });

    const startOrSignal = (scopes: readonly AuthorizationScope[]) =>
      handleRequest(
        new Request('http://localhost/v1/workflows/start-or-signal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'start-or-signal-scope-waiter',
            id: handle.id,
            signalName: 'release',
            signalId: 'scope-test-signal',
            signalPayload: 'done',
          }),
        }),
        engine,
        { authContext: { method: 'api-key', principal: principalHolding(scopes) } },
      );

    const refused = await startOrSignal(['workflows:write']);
    expect(refused.status).toBe(403);
    const stateAfterRefusal = await engine.get(handle.id);
    const statusAfterRefusal = stateAfterRefusal?.status;
    expect(statusAfterRefusal === 'pending' || statusAfterRefusal === 'running').toBe(true);

    const admitted = await startOrSignal(['workflows:write', 'signals:write']);
    expect(admitted.status).toBeLessThan(300);
    expect(await handle.result()).toBe('done');
  });
});

describe('workflow event feeds, whose authorize hook decides by selector', () => {
  const feeds = [
    { name: 'weft.workflows.events', operation: workflowEventsSubscriptionOperation },
    { name: 'weft.workflows.events.sse', operation: workflowEventsSseOperation },
  ];
  expect(feeds.map((feed) => feed.name)).toEqual([...SELECTOR_AUTHORIZED_OPERATIONS]);

  for (const { name, operation } of feeds) {
    it(`${name} keeps the authenticated policy and refuses a principal with no scopes`, async () => {
      expect(registry.get(name)?.access).toEqual({ kind: 'authenticated' });
      expect(operation.access).toEqual({ kind: 'authenticated' });
      const authorize = operation.authorize;
      if (authorize === undefined) throw new Error(`${name} has no authorize hook`);

      for (const selector of ['events', 'tokens'] as const) {
        const context = (principal: Principal) =>
          ({ input: { workflowId: 'wf', selector }, principal, host: {} }) as never;
        expect(await authorize(context(principalHolding([])))).toMatchObject({
          allowed: false,
          classification: 'forbidden',
        });
        expect(await authorize(context(anonymousPrincipal()))).toMatchObject({
          allowed: false,
          classification: 'unauthorized',
        });
      }
    });
  }
});

describe('public operations', () => {
  it('are exactly weft.system.principal, so a new public operation fails the suite', () => {
    const publicOperations = registry
      .list()
      .filter((operation) => operation.access.kind === 'public')
      .map((operation) => operation.name)
      .toSorted();
    expect(publicOperations).toEqual(['weft.system.principal']);
  });

  it('leave no workflow, schedule, review, retention, update, or recovery operation outside the scope table', () => {
    const classified = new Set([
      ...Object.keys(REQUIRED_SCOPE_BY_OPERATION),
      'weft.workflows.startorsignal',
      ...Object.keys(ALREADY_SCOPED_OPERATIONS),
      ...DEFINITION_CATALOG_OPERATIONS,
      ...AUTHENTICATED_ONLY_OPERATIONS,
      ...SELECTOR_AUTHORIZED_OPERATIONS,
      'weft.system.principal',
    ]);
    const unclassified = registry
      .list()
      .map((operation) => operation.name)
      .filter((name) =>
        /^weft\.(workflows|schedules|reviews|retention|updates|recover)\./.test(name),
      )
      .filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
  });

  it('leave every operation in the scope table registered', () => {
    for (const operationName of Object.keys(REQUIRED_SCOPE_BY_OPERATION)) {
      expect(registry.get(operationName)).toBeDefined();
    }
  });
});
