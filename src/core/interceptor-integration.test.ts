import { afterEach, describe, expect, it } from 'bun:test';

import { storageBackends, teardown } from '../testing/storage-backends.test-support.ts';
import { Engine } from './engine.ts';
import type { WorkflowInterceptor, WorkflowStartInterception } from './interceptor.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';

// ---------------------------------------------------------------------------
// A4: Interceptor workflowStart hook invoked during engine.start()
//
// The composed workflowStart hook must be called when the engine starts a
// workflow, so interceptors can inject tracing headers, enforce policies, etc.
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`workflowStart interceptor integration [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('calls registered workflowStart interceptor on engine.start()', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const captured: WorkflowStartInterception[] = [];

      const interceptor: WorkflowInterceptor = {
        workflowStart(interception, next) {
          captured.push({ ...interception });
          next(interception);
        },
      };

      engine.addInterceptor(interceptor);

      const greeterWorkflow = workflow({ name: 'greeter' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'hello';
      });
      engine.register(greeterWorkflow);

      const handle = await engine.start('greeter', { name: 'world' });
      const handleResult = await handle.result();

      expect(handleResult).toBe('hello');
      expect(captured).toHaveLength(1);
      expect(captured[0]!.workflowId).toBe(handle.id);
      expect(captured[0]!.workflowType).toBe('greeter');
      expect(captured[0]!.input).toEqual({ name: 'world' });
    });

    it('throws when a workflowStart interceptor throws, and workflow is not started', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const interceptor: WorkflowInterceptor = {
        workflowStart(_interception, _next) {
          throw new Error('interceptor blocked start');
        },
      };

      engine.addInterceptor(interceptor);

      const blockedWorkflow = workflow({ name: 'blocked' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'should not reach';
      });
      engine.register(blockedWorkflow);

      try {
        await engine.start('blocked', undefined);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toBe('interceptor blocked start');
      }
    });

    it('multiple interceptors fire in registration order', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const order: string[] = [];

      const first: WorkflowInterceptor = {
        workflowStart(interception, next) {
          order.push('first');
          next(interception);
        },
      };

      const second: WorkflowInterceptor = {
        workflowStart(interception, next) {
          order.push('second');
          next(interception);
        },
      };

      engine.addInterceptor(first);
      engine.addInterceptor(second);

      const orderedWorkflow = workflow({ name: 'ordered' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'done';
      });
      engine.register(orderedWorkflow);

      const handle = await engine.start('ordered', undefined);
      await handle.result();

      expect(order).toEqual(['first', 'second']);
    });

    it('workflowStart interceptor can modify headers visible to the chain', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      let capturedHeaders: Map<string, string> | undefined;

      const headerSetter: WorkflowInterceptor = {
        workflowStart(interception, next) {
          interception.headers.set('x-trace-id', 'trace-abc-123');
          next(interception);
        },
      };

      const headerReader: WorkflowInterceptor = {
        workflowStart(interception, next) {
          capturedHeaders = new Map(interception.headers);
          next(interception);
        },
      };

      engine.addInterceptor(headerSetter);
      engine.addInterceptor(headerReader);

      const tracedWorkflow = workflow({ name: 'traced' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'traced';
      });
      engine.register(tracedWorkflow);

      const handle = await engine.start('traced', undefined);
      await handle.result();

      expect(capturedHeaders?.get('x-trace-id')).toBe('trace-abc-123');
    });

    it('workflow functions correctly when no interceptors are registered', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      // No interceptors added

      const noInterceptorsWorkflow = workflow({ name: 'no-interceptors' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 42;
      });
      engine.register(noInterceptorsWorkflow);

      const handle = await engine.start('no-interceptors', undefined);
      const handleResult = await handle.result();
      expect(handleResult).toBe(42);
    });

    it('silently not calling next() does not prevent start() from succeeding', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const interceptor: WorkflowInterceptor = {
        workflowStart(_interception, _next) {
          // Deliberately does not call next — silent block
          // The workflow should still proceed since the interceptor doesn't throw
        },
      };

      engine.addInterceptor(interceptor);

      const silentBlockWorkflow = workflow({ name: 'silent-block' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'done';
      });
      engine.register(silentBlockWorkflow);

      // When an interceptor silently blocks (doesn't call next), start() should
      // still succeed because the interceptor runs before execution begins
      const handle = await engine.start('silent-block', undefined);
      const handleResult = await handle.result();
      expect(handleResult).toBe('done');
    });
  });
}
