/**
 * `weft.realms.diagnostics` operation + REST binding — unit tests (COR-243).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  getRealmDiagnosticsOperation,
  getRealmDiagnosticsRestBinding,
  toGetRealmDiagnosticsOutput,
} from './get-realm-diagnostics.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

// The "real realm pool populated" case is proven at the engine-integration
// level in `core/engine/revision-realm-execution.test.ts` (see
// "weft.realms.diagnostics reports realms mid-execution (COR-243)"), not
// here: this package's `check-internal-imports.ts` lint gate only allows
// `core/engine/internals.ts` to be imported from within `src/core/engine/**`,
// and driving a real, mid-execution realm needs that seam (setting
// `EngineInternals.revisionRealmRegistry`) or the full public
// `workflowExecutionMode: 'realm'` construction path with real Worker
// fixtures — both already exercised there. This file proves the operation's
// own wiring: the empty-pools default and its authorization gates.
const registry = createOperationRegistry([getRealmDiagnosticsOperation]);

describe('weft.realms.diagnostics — REST GET /v1/realms/diagnostics', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns an empty pools array for an engine that never opted into realm mode', async () => {
    engine = createOperationTestEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/realms/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getRealmDiagnosticsRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [] });
  });

  it('rejects an unauthenticated caller', async () => {
    engine = createOperationTestEngine();
    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.realms.diagnostics',
      engine,
      liveRegistry: registry,
    });
  });

  it('rejects a caller missing system:read', async () => {
    engine = createOperationTestEngine();
    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.realms.diagnostics',
      engine,
      liveRegistry: registry,
    });
  });

  it('throws when invoked directly with a context whose engine is not a concrete Engine instance', async () => {
    await expect(
      getRealmDiagnosticsOperation.invoke({
        engine: {},
        principal: { method: 'unauthenticated' },
        transport: 'jsonRpcStdio',
        input: {},
      }),
    ).rejects.toThrow('Realm diagnostics requires a concrete Engine instance.');
  });
});

describe('toGetRealmDiagnosticsOutput', () => {
  it('projects readonly pool/realm arrays into the mutable output shape, unchanged in content', () => {
    const pools = [
      {
        name: 'checkout',
        revision: 'revision-a',
        revisionActive: true,
        realms: [
          {
            state: 'active' as const,
            realmGeneration: 'gen-1',
            restartCount: 0,
            pendingTurnCount: 2,
          },
        ],
      },
      { name: 'checkout', revision: 'revision-b', revisionActive: false, realms: [] },
    ];

    expect(toGetRealmDiagnosticsOutput(pools)).toEqual({ pools });
  });

  it('returns an empty pools array for no pools', () => {
    expect(toGetRealmDiagnosticsOutput([])).toEqual({ pools: [] });
  });
});
