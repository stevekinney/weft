import { describe, expect, it } from 'bun:test';

import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import type { WorkflowContext } from '../index.ts';
import { Engine, serve, workflow } from '../index.ts';
import { isParkedOn, statusOf } from '../testing/run-observation.test-support.ts';
import { NOT_FOUND_EXIT_CODE } from './server-client.ts';
import type { WorkflowCommand } from './types.ts';
import { executeWorkflow } from './workflow-commands.ts';

function createJsonRpcFixtureServer(resultFor: (method: string) => unknown) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return Response.json({ jsonrpc: '2.0', id: null, result: resultFor('') });
      }
      const id = 'id' in body && typeof body.id === 'string' ? body.id : '';
      const method = 'method' in body && typeof body.method === 'string' ? body.method : '';
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: resultFor(method),
      });
    },
  });
  return { url: server.url.toString(), stop: () => server.stop() };
}

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  yield* [];
  return input;
});

function createServedEngine(): { engine: Engine; url: string; stop: () => Promise<void> } {
  const engine = new Engine();
  engine.register(echoWorkflow);
  const server = serve({ engine, port: 0 });
  return {
    engine,
    url: server.url,
    stop: async () => {
      await server.stop();
      engine[Symbol.dispose]();
    },
  };
}

const base = {
  command: 'workflow' as const,
  help: false,
  json: false,
  quiet: false,
};

describe('weft workflow cancel (destructive gate)', () => {
  it('cancels when --yes bypasses the prompt', async () => {
    const served = createServedEngine();
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-cancel-1',
      } satisfies WorkflowCommand);

      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-cancel-1',
        yes: true,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cancelled workflow wf-cancel-1');
    } finally {
      await served.stop();
    }
  });

  it('refuses on a non-TTY without --yes and takes no action', async () => {
    const served = createServedEngine();
    const priorIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-cancel-guard',
      } satisfies WorkflowCommand);

      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-cancel-guard',
        yes: false,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('without confirmation');

      // The workflow must still exist (not cancelled).
      const state = await served.engine.get('wf-cancel-guard');
      expect(state?.status).not.toBe('cancelled');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: priorIsTty,
        configurable: true,
      });
      await served.stop();
    }
  });

  it('returns a denied result when an interactive confirmation is declined', async () => {
    const server = createJsonRpcFixtureServer(() => ({ ok: true }));
    const priorIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const priorStream = Bun.stdin.stream;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Bun.stdin.stream = () =>
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          const input = new Uint8Array(new ArrayBuffer(2));
          input.set([110, 10]);
          controller.enqueue(input);
          controller.close();
        },
      });
    try {
      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: server.url,
        workflowId: 'wf-denied',
        yes: false,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result).toEqual({ stdout: 'Cancelled (no action taken).', exitCode: 1 });
    } finally {
      Bun.stdin.stream = priorStream;
      if (priorIsTtyDescriptor === undefined) {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      } else {
        Object.defineProperty(process.stdin, 'isTTY', priorIsTtyDescriptor);
      }
      await server.stop();
    }
  });
});

describe('weft workflow cancel --dry-run', () => {
  async function startParkedWorkflow(served: { engine: Engine; url: string }, id: string) {
    await served.engine.start('parked', null, { id });
    await waitForCondition(() => isParkedOn(served.engine, id, 'go'), {
      label: `"${id}" to park on the go signal`,
    });
  }

  function createParkedServedEngine() {
    const served = createServedEngine();
    served.engine.register(
      workflow({ name: 'parked' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal('go');
      }),
    );
    return served;
  }

  it('asks the server and says a running workflow can be cancelled, cancelling nothing', async () => {
    const served = createParkedServedEngine();
    try {
      await startParkedWorkflow(served, 'wf-dry');
      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-dry',
        yes: false,
        dryRun: true,
      } satisfies WorkflowCommand);
      expect(result).toEqual({
        stdout: 'Would cancel workflow wf-dry (status: running)',
        exitCode: 0,
      });
      expect(await statusOf(served.engine, 'wf-dry')).toBe('running');
    } finally {
      await served.stop();
    }
  });

  it('prints the server answer as JSON, and says a finished workflow cannot be cancelled', async () => {
    const served = createServedEngine();
    try {
      const handle = await served.engine.start('echo', 'done', { id: 'wf-dry-json' });
      await handle.result();
      const json = await executeWorkflow({
        ...base,
        json: true,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-dry-json',
        yes: false,
        dryRun: true,
      } satisfies WorkflowCommand);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        dryRun: true,
        workflowId: 'wf-dry-json',
        status: 'completed',
        cancellable: false,
      });

      const text = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-dry-json',
        yes: false,
        dryRun: true,
      } satisfies WorkflowCommand);
      expect(text.stdout).toBe('Cannot cancel workflow wf-dry-json: it is already completed');
    } finally {
      await served.stop();
    }
  });

  it('exits with the not-found exit code for an unknown id', async () => {
    const served = createServedEngine();
    try {
      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-missing',
        yes: false,
        dryRun: true,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(NOT_FOUND_EXIT_CODE);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('not found');
    } finally {
      await served.stop();
    }
  });

  it('reports a connection failure as a connection error, not as a missing workflow', async () => {
    const result = await executeWorkflow({
      ...base,
      action: 'cancel',
      server: 'http://127.0.0.1:1',
      workflowId: 'wf-unreachable',
      yes: false,
      dryRun: true,
    } satisfies WorkflowCommand);
    expect(result.exitCode).toBe(2);
  });
});

describe('weft workflow signal', () => {
  it('signals a running workflow', async () => {
    const served = createServedEngine();
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-signal-1',
      } satisfies WorkflowCommand);

      const result = await executeWorkflow({
        ...base,
        action: 'signal',
        server: served.url,
        workflowId: 'wf-signal-1',
        signalName: 'wake',
        input: '"payload"',
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Signalled wake');
    } finally {
      await served.stop();
    }
  });

  it('surfaces local input errors for start and signal before calling the server', async () => {
    const served = createServedEngine();
    try {
      const start = await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        input: '{',
      } satisfies WorkflowCommand);
      expect(start.exitCode).toBe(3);
      expect(start.stderr).toContain('invalid JSON input');

      const signal = await executeWorkflow({
        ...base,
        action: 'signal',
        server: served.url,
        workflowId: 'wf-signal-1',
        signalName: 'wake',
        inputFile: '/definitely/missing.json',
      } satisfies WorkflowCommand);
      expect(signal.exitCode).toBe(3);
      expect(signal.stderr).toContain('input file not found');
    } finally {
      await served.stop();
    }
  });
});

describe('connection failures', () => {
  it('reports a connection error with exit code 2', async () => {
    const result = await executeWorkflow({
      ...base,
      action: 'signal',
      server: 'http://127.0.0.1:1/',
      workflowId: 'wf-connection-failure',
      signalName: 'wake',
      input: 'null',
    } satisfies WorkflowCommand);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('connection failed');
  });

  it('reports configuration errors before attempting a request', async () => {
    const result = await executeWorkflow({
      ...base,
      action: 'signal',
      server: 'not-a-url',
      workflowId: 'wf-invalid-configuration',
      signalName: 'wake',
      input: 'null',
    } satisfies WorkflowCommand);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('connection failed');
    expect(result.stderr).toContain('not-a-url');
  });
});
