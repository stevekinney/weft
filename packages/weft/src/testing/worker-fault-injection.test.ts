import { rejectionOf, throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { ServerToWorkerMessage } from '../worker/protocol.ts';
import { computeHandshakeAccept } from './worker-fault-injection-frames.test-support.ts';
import {
  connectFaultInjectingWorker,
  type FaultInjectingWorker,
} from './worker-fault-injection.test-support.ts';

type ServerSocket = { send(data: string): void; close(code?: number, reason?: string): void };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Close the worker before stopping the server, the order every other suite
  // using this harness tears down in.
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const LOOPBACK = '127.0.0.1';

const SHUTDOWN = { type: 'shutdown' } as const;

function protocolError(message: string): ServerToWorkerMessage {
  return { type: 'protocolError', code: 'unknown_message_type', message };
}

/**
 * Serve one WebSocket endpoint and connect a fault-injecting worker to it. The
 * server sends nothing until the test says so: a frame sent from `open` can
 * arrive in the same TCP chunk as the handshake response, which is a different
 * (and nondeterministic) path through the harness than the one under test.
 */
async function connectToScriptedServer(): Promise<{
  worker: FaultInjectingWorker;
  serverSocket: ServerSocket;
  /** The loopback port the scripted server listens on. */
  port: number;
  /** Resolves once one more frame has been parsed and buffered. */
  nextArrival: () => Promise<void>;
}> {
  let resolveSocket: (socket: ServerSocket) => void = () => undefined;
  const socketReady = new Promise<ServerSocket>((resolve) => {
    resolveSocket = resolve;
  });
  // Bind the exact address the worker dials. A wildcard listener can share its
  // port with a later 127.0.0.1 listener from another process (a close-then-
  // rebind port picker, for one) and the kernel routes loopback connections to
  // the more specific one, so the handshake would come back from a stranger.
  const server = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    fetch(request, running) {
      return running.upgrade(request)
        ? undefined
        : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open() {},
      // The worker's first frame tells us the connection is established.
      message(socket) {
        resolveSocket(socket);
      },
    },
  });
  cleanups.push(() => server.stop(true));

  const waiters: Array<() => void> = [];
  const worker = await connectFaultInjectingWorker({
    url: `ws://${LOOPBACK}:${String(server.port)}/`,
    workerId: 'scripted',
    onAnyInbound() {
      for (const waiter of waiters.splice(0)) waiter();
    },
  });
  cleanups.push(() => worker.hardClose());
  worker.send({ type: 'heartbeat', workerId: 'scripted' });
  return {
    worker,
    serverSocket: await socketReady,
    port: Number(server.port),
    // `onAnyInbound` runs just before the frame is buffered; the promise
    // continuation runs after the synchronous frame handler has returned.
    nextArrival: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
  };
}

describe('nextServerMessage buffer scan', () => {
  // Regression test for the flaky `worker-fault-injection.test-support.ts:286`
  // coverage allowance: passing over a buffered, non-matching message is the
  // only thing that executes that closing brace, and only a timing race in
  // other suites used to reach it. This test reaches it on every run.
  it('passes over a buffered non-matching message and leaves it for a later waiter', async () => {
    const { worker, serverSocket, nextArrival } = await connectToScriptedServer();

    let arrived = nextArrival();
    serverSocket.send(JSON.stringify(SHUTDOWN));
    await arrived;

    // SHUTDOWN is buffered and does not match, so the scan passes over it,
    // finds nothing, and installs a live listener for the next frame.
    arrived = nextArrival();
    const pending = worker.nextServerMessage((message) => message.type === 'protocolError');
    serverSocket.send(JSON.stringify(protocolError('first')));
    await arrived;
    expect(await pending).toEqual(protocolError('first'));

    // The passed-over message stayed buffered...
    expect(await worker.nextServerMessage((message) => message.type === 'shutdown')).toEqual(
      SHUTDOWN,
    );

    // ...and the matched one was removed, so a second waiter sees the next frame.
    arrived = nextArrival();
    serverSocket.send(JSON.stringify(protocolError('second')));
    await arrived;
    expect(await worker.nextServerMessage((message) => message.type === 'protocolError')).toEqual(
      protocolError('second'),
    );
  });

  it('skips a non-matching buffered message ahead of a buffered match', async () => {
    const { worker, serverSocket, nextArrival } = await connectToScriptedServer();

    for (const frame of [SHUTDOWN, protocolError('behind')]) {
      const arrived = nextArrival();
      serverSocket.send(JSON.stringify(frame));
      await arrived;
    }
    // Buffer is [shutdown, protocolError]: the scan passes over the first
    // entry and splices out the second.
    const match = await worker.nextServerMessage((message) => message.type === 'protocolError');
    expect(match).toEqual(protocolError('behind'));
    expect(await worker.nextServerMessage((message) => message.type === 'shutdown')).toEqual(
      SHUTDOWN,
    );
  });
});

describe('scripted server address', () => {
  // Regression test for COR-1922: the server used to listen on the wildcard
  // address while the worker dialed 127.0.0.1, so another process could claim
  // 127.0.0.1 on the same port and answer the handshake (a 401 in the coverage
  // lane). Owning the loopback address itself makes that bind fail.
  it('owns the loopback address the worker dials, so no later listener can shadow it', async () => {
    const { port } = await connectToScriptedServer();

    expect(() =>
      Bun.serve({ hostname: LOOPBACK, port, fetch: () => new Response('shadow') }),
    ).toThrow();
  });
});

describe('server-driven frames', () => {
  it('reports a server close frame with its code and reason, and exposes the worker id', async () => {
    const { worker, serverSocket } = await connectToScriptedServer();
    expect(worker.workerId).toBe('scripted');
    expect(worker.closedState).toBe('open');

    serverSocket.close(4001, 'going away');

    expect(await worker.closed).toEqual({ code: 4001, reason: 'going away' });
    expect(worker.closedState).toBe('closed');
  });

  it('completes a clean close the worker starts', async () => {
    const { worker } = await connectToScriptedServer();

    await worker.cleanClose();

    expect(await worker.closed).toEqual({ code: 1000, reason: '' });
    // A second close on an already-closed stream is a no-op.
    await worker.cleanClose();
    await worker.hardClose();
  });

  it('fails the stream with 1002 when the server sends text that is not JSON', async () => {
    const { worker, serverSocket } = await connectToScriptedServer();

    serverSocket.send('this is not json');

    const info = await worker.closed;
    expect(info.code).toBe(1002);
    expect(info.reason).toBe('Server sent invalid JSON: this is not json');
  });

  it('drops frames while partitioned and delivers them again after healing', async () => {
    const { worker, serverSocket, nextArrival } = await connectToScriptedServer();
    const isProtocolError = (message: ServerToWorkerMessage): boolean =>
      message.type === 'protocolError';

    worker.partition();
    serverSocket.send(JSON.stringify(protocolError('dropped')));
    await worker.expectNoServerMessage(isProtocolError, { timeoutMs: 50 });

    worker.heal();
    const arrived = nextArrival();
    serverSocket.send(JSON.stringify(protocolError('delivered')));
    await arrived;
    expect(await worker.nextServerMessage(isProtocolError)).toEqual(protocolError('delivered'));
  });
});

describe('nextServerMessage and expectNoServerMessage waits', () => {
  it('rejects a wait whose budget elapses with no matching frame', async () => {
    const { worker } = await connectToScriptedServer();

    // load-proof: the predicate never matches and the server sends nothing, so a slower host only lengthens the wait before the budget elapses
    expect(
      await throwingRejectionOf(worker.nextServerMessage(() => false, { timeoutMs: 30 })),
    ).toThrow('nextServerMessage timed out after 30ms');
  });

  it('rejects an absence check when a matching frame arrives during the wait', async () => {
    const { worker, serverSocket } = await connectToScriptedServer();

    const absence = worker.expectNoServerMessage((message) => message.type === 'shutdown', {
      timeoutMs: 5_000,
    });
    serverSocket.send(JSON.stringify(SHUTDOWN));

    expect(await throwingRejectionOf(absence)).toThrow(
      'expectNoServerMessage received a matching message',
    );
  });

  it('rejects an absence check when a matching frame was already buffered', async () => {
    const { worker, serverSocket, nextArrival } = await connectToScriptedServer();
    const arrived = nextArrival();
    serverSocket.send(JSON.stringify(SHUTDOWN));
    await arrived;

    expect(
      await throwingRejectionOf(
        worker.expectNoServerMessage((message) => message.type === 'shutdown', { timeoutMs: 30 }),
      ),
    ).toThrow('buffered before wait');
  });

  it('rejects an absence check when the socket closes during the wait', async () => {
    const { worker, serverSocket } = await connectToScriptedServer();

    const absence = worker.expectNoServerMessage(() => false, { timeoutMs: 5_000 });
    serverSocket.close(4002, 'bye');

    expect(await throwingRejectionOf(absence)).toThrow(
      'expectNoServerMessage saw socket close (4002)',
    );
  });
});

type ConnectOptions = Parameters<typeof Bun.connect>[0];
type SocketHandlers = ConnectOptions['socket'];

/**
 * Make `Bun.connect` hand the harness a socket of the test's choosing and keep the socket
 * handlers the harness registered, so a test can drive an event Bun does not raise on demand: a
 * socket whose `end()` throws, and a transport `error` after the handshake. Bun emitted no
 * `error` event for a server reset or termination in repeated attempts, only `close`, and
 * `end()` on a closed socket does not throw on Bun 1.4.4.
 */
function interceptSockets(options: { endThrows: boolean }): { handlers: () => SocketHandlers } {
  const realConnect = Bun.connect.bind(Bun) as (options: ConnectOptions) => Promise<unknown>;
  let registered: SocketHandlers | undefined;
  const spy = spyOn(Bun, 'connect').mockImplementation(((connectOptions: ConnectOptions) => {
    const original = connectOptions.socket;
    registered = original;
    return realConnect({
      ...connectOptions,
      socket: {
        ...original,
        open(socket: Parameters<NonNullable<typeof original.open>>[0]) {
          const given = options.endThrows
            ? new Proxy(socket, {
                get(target, property) {
                  if (property === 'end') {
                    return () => {
                      throw new Error('The socket is already closed.');
                    };
                  }
                  const member: unknown = Reflect.get(target, property);
                  return typeof member === 'function' ? member.bind(target) : member;
                },
              })
            : socket;
          original.open?.(given);
        },
      },
    });
  }) as unknown as typeof Bun.connect);
  cleanups.push(() => spy.mockRestore());
  return {
    handlers: () => {
      if (registered === undefined) throw new Error('Bun.connect was not called.');
      return registered;
    },
  };
}

function servePlainHttp(): number {
  const server = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    fetch: () => new Response('no upgrade', { status: 200 }),
  });
  cleanups.push(() => server.stop(true));
  if (server.port === undefined) throw new Error('The plain HTTP fixture has no port.');
  return server.port;
}

describe('connection failures', () => {
  it('owns the loopback address for a plain HTTP handshake refusal', () => {
    const port = servePlainHttp();
    expect(() => {
      const shadow = Bun.serve({ hostname: LOOPBACK, port, fetch: () => new Response('shadow') });
      cleanups.push(() => shadow.stop(true));
    }).toThrow();
  });
  it('rejects a handshake the server never answers', async () => {
    const silent = Bun.listen({
      hostname: LOOPBACK,
      port: 0,
      socket: { data() {}, open() {} },
    });
    cleanups.push(() => silent.stop(true));

    expect(
      await throwingRejectionOf(
        connectFaultInjectingWorker({
          url: `ws://${LOOPBACK}:${String(silent.port)}/`,
          handshakeTimeoutMs: 30,
        }),
      ),
    ).toThrow('WebSocket handshake timeout');
  });

  it('rejects when the server answers the upgrade with a plain HTTP response', async () => {
    const port = servePlainHttp();

    expect(
      await throwingRejectionOf(
        connectFaultInjectingWorker({ url: `ws://${LOOPBACK}:${String(port)}/` }),
      ),
    ).toThrow('WebSocket handshake failed: HTTP/1.1 200');
  });

  it('still rejects a refused handshake when the socket cannot be ended', async () => {
    interceptSockets({ endThrows: true });
    const port = servePlainHttp();

    expect(
      await throwingRejectionOf(
        connectFaultInjectingWorker({ url: `ws://${LOOPBACK}:${String(port)}/` }),
      ),
    ).toThrow('WebSocket handshake failed: HTTP/1.1 200');
  });

  it('settles as closed with 1006 when the transport reports an error after the handshake', async () => {
    const intercepted = interceptSockets({ endThrows: false });
    const { worker } = await connectToScriptedServer();

    const handlers = intercepted.handlers();
    handlers.error?.(undefined as never, new Error('connection reset'));

    expect(await worker.closed).toEqual({ code: 1006, reason: '' });
    expect(worker.closedState).toBe('closed');
  });

  it('propagates a refused TCP connection', async () => {
    // A port released by a fixture can be claimed before the worker dials it.
    const refusal = new Error('connect ECONNREFUSED');
    const connect = spyOn(Bun, 'connect').mockRejectedValueOnce(refusal);
    cleanups.push(() => connect.mockRestore());

    expect(await rejectionOf(connectFaultInjectingWorker({ url: `ws://${LOOPBACK}:1/` }))).toBe(
      refusal,
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

/**
 * Serve one raw TCP connection that completes the WebSocket handshake and then writes the given
 * bytes unchanged, so a test can send frames a real WebSocket server never would.
 */
function serveRawFrames(frames: Uint8Array): number {
  const server = Bun.listen({
    hostname: LOOPBACK,
    port: 0,
    socket: {
      async data(socket, chunk) {
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(new TextDecoder().decode(chunk))?.[1];
        if (key === undefined) return;
        const accept = await computeHandshakeAccept(key);
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n'),
        );
        socket.write(frames);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return server.port;
}

describe('malformed server frames', () => {
  it.each([
    ['a text frame that is not valid UTF-8', new Uint8Array([0x81, 0x02, 0xff, 0xfe]), 'non-UTF-8'],
    [
      'a frame with an unsupported opcode',
      new Uint8Array([0x83, 0x00]),
      'Unsupported WebSocket opcode 0x3',
    ],
    ['a masked frame', new Uint8Array([0x81, 0x80, 0, 0, 0, 0]), 'masked frame'],
    ['a binary frame', new Uint8Array([0x82, 0x00]), 'Binary WebSocket frames'],
    ['a fragmented frame', new Uint8Array([0x01, 0x00]), 'Fragmented WebSocket frames'],
  ])('fails the stream with 1002 for %s', async (_label, frame, reason) => {
    const port = serveRawFrames(frame);
    const worker = await connectFaultInjectingWorker({ url: `ws://${LOOPBACK}:${String(port)}/` });

    const info = await worker.closed;

    expect(info.code).toBe(1002);
    expect(info.reason).toContain(reason);
  });
});
