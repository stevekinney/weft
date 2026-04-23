import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCPTransportError } from './transport';
import { StdioTransport } from './transport-stdio';

// ---------------------------------------------------------------------------
// Helper: create a temporary script that acts as a mock MCP server
// ---------------------------------------------------------------------------

/**
 * Write a small Node/Bun script to a temp file that reads JSON-RPC from stdin
 * and writes JSON-RPC responses to stdout. Returns the script path.
 */
async function createMockServer(
  behavior:
    | 'echo'
    | 'slow'
    | 'crash'
    | 'health'
    | 'malformed'
    | 'crlf'
    | 'chunked'
    | 'empty-lines'
    | 'no-trailing-newline'
    | 'oversize',
): Promise<string> {
  const scripts: Record<string, string> = {
    // Echoes back the method and params as the result
    echo: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          const response = { jsonrpc: '2.0', id: msg.id, result: { method: msg.method, params: msg.params } };
          process.stdout.write(JSON.stringify(response) + '\\n');
        } catch {}
      });
    `,
    // Responds after 200ms delay
    slow: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'slow-ok' }) + '\\n');
          }, 200);
        } catch {}
      });
    `,
    // Exits immediately
    crash: `process.exit(1);`,
    // Sends non-JSON garbage before a valid response
    malformed: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // Send garbage first, then valid response
          process.stdout.write('this is not json\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) + '\\n');
        } catch {}
      });
    `,
    // Responds to ping, then echoes
    health: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'ping') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.params } }) + '\\n');
          }
        } catch {}
      });
    `,
    // Framing regression: emits responses with CRLF line endings instead
    // of LF. The reader splits only on '\\n' — the '\\r' should be
    // trimmed as whitespace by the .trim() call, not rejected.
    crlf: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // Explicitly emit CRLF (\\r\\n) — if the reader rejects the \\r,
          // the client will time out.
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'crlf-ok' }) + '\\r\\n');
        } catch {}
      });
    `,
    // Framing regression: splits the response across multiple small
    // writes so the buffer must accumulate partial lines across reads.
    // Writes the response byte-by-byte with microtask gaps.
    chunked: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', async (line) => {
        try {
          const msg = JSON.parse(line);
          const response = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'chunked-ok' }) + '\\n';
          // Write one byte at a time with setImmediate delays so the
          // reader receives partial chunks.
          for (const ch of response) {
            process.stdout.write(ch);
            await new Promise((r) => setImmediate(r));
          }
        } catch {}
      });
    `,
    // Framing regression: emits blank lines between responses. The
    // reader must skip empty lines (after trim) rather than logging
    // them as malformed JSON warnings.
    'empty-lines': `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // Write a blank line, a whitespace-only line, then the real
          // response. All three trail a '\\n' so the reader loop splits
          // them as distinct frames.
          process.stdout.write('\\n');
          process.stdout.write('   \\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'empty-lines-ok' }) + '\\n');
        } catch {}
      });
    `,
    // Framing regression: emits a valid response WITHOUT a trailing
    // newline, then exits. The buffered line is never delivered to the
    // client (this is the known limitation — the test asserts it).
    'no-trailing-newline': `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // No trailing newline — the reader buffer will hold the whole
          // response forever because '\\n' never appears.
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'no-newline' }));
          // Keep the process alive so the client's timeout fires first.
        } catch {}
      });
      setInterval(() => {}, 60000); // prevent exit
    `,
    // Framing regression: emits a very large (multi-MB) single-frame
    // response to confirm the buffer can absorb oversize frames without
    // corruption. Exact size is bounded so the test completes in time.
    oversize: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // 1 MB of padding inside the result field — well above any
          // realistic JSON-RPC payload but small enough for a unit test.
          const padding = 'x'.repeat(1024 * 1024);
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { padding } }) + '\\n');
        } catch {}
      });
    `,
  };

  const scriptPath = join(tmpdir(), `mcp-mock-${behavior}-${Date.now()}.js`);
  await Bun.write(scriptPath, scripts[behavior]!);
  return scriptPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StdioTransport', () => {
  const transports: StdioTransport[] = [];

  afterEach(() => {
    for (const transport of transports) {
      transport[Symbol.dispose]();
    }
    transports.length = 0;
  });

  function track(transport: StdioTransport): StdioTransport {
    transports.push(transport);
    return transport;
  }

  it('sends a JSON-RPC request and receives a response', async () => {
    const script = await createMockServer('echo');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const response = await transport.send({
      method: 'tools/list',
      params: { filter: 'all' },
    });

    expect(response.result).toEqual({
      method: 'tools/list',
      params: { filter: 'all' },
    });
  });

  it('handles multiple sequential requests with correct correlation', async () => {
    const script = await createMockServer('echo');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const r1 = await transport.send({ method: 'first' });
    const r2 = await transport.send({ method: 'second' });
    const r3 = await transport.send({ method: 'third' });

    expect((r1.result as any).method).toBe('first');
    expect((r2.result as any).method).toBe('second');
    expect((r3.result as any).method).toBe('third');
  });

  it('handles concurrent requests with correct correlation', async () => {
    const script = await createMockServer('echo');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const [r1, r2, r3] = await Promise.all([
      transport.send({ method: 'a' }),
      transport.send({ method: 'b' }),
      transport.send({ method: 'c' }),
    ]);

    expect((r1.result as any).method).toBe('a');
    expect((r2.result as any).method).toBe('b');
    expect((r3.result as any).method).toBe('c');
  });

  it('times out when server is slow', async () => {
    const script = await createMockServer('slow');
    const transport = track(new StdioTransport({ command: 'bun', args: [script], timeout: 50 }));

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('respects external abort signal', async () => {
    const script = await createMockServer('slow');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const controller = new AbortController();

    const promise = transport.send({ method: 'test' }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow(DOMException);
  });

  it('throws when transport is disposed', async () => {
    const script = await createMockServer('echo');
    const transport = new StdioTransport({ command: 'bun', args: [script] });
    transport[Symbol.dispose]();

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('rejects pending requests on dispose', async () => {
    const script = await createMockServer('slow');
    const transport = new StdioTransport({ command: 'bun', args: [script] });

    const promise = transport.send({ method: 'test' });

    // send() populates #pending synchronously before its first await,
    // so yielding the microtask queue is sufficient
    await Promise.resolve();
    transport[Symbol.dispose]();

    await expect(promise).rejects.toThrow(MCPTransportError);
  });

  it('warns on malformed JSON but still processes valid responses', async () => {
    const script = await createMockServer('malformed');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const response = await transport.send({ method: 'test' });

      expect(response.result).toBe('ok');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[weft:mcp:stdio] Ignoring malformed JSON'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('handles double dispose without error', async () => {
    const script = await createMockServer('echo');
    const transport = new StdioTransport({ command: 'bun', args: [script] });
    // Send one request to start the process
    await transport.send({ method: 'test' });
    transport[Symbol.dispose]();
    expect(() => transport[Symbol.dispose]()).not.toThrow();
  });

  it('cleans up read loops after disposal without hanging', async () => {
    const script = await createMockServer('echo');
    const transport = new StdioTransport({ command: 'bun', args: [script] });

    // Drive a request so the process is spawned and both read loops are running
    await transport.send({ method: 'test' });

    // Dispose kills the child process; the read loops should observe the
    // stream close, run their finally blocks, cancel their readers, and exit.
    expect(() => transport[Symbol.dispose]()).not.toThrow();

    // Give the read loops a moment to observe the cancelled reads and run
    // their finally blocks. If the readers were not released, future runs
    // might leak file descriptors, but at minimum this test ensures the
    // disposal sequence completes without throwing and subsequent sends
    // reject cleanly.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('swallows stdout reader cancellation failures during read-loop cleanup', async () => {
    let responseSent = false;
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
      return {
        stdin: {
          async write() {
            return 1;
          },
        },
        stdout: {
          getReader() {
            return {
              async read() {
                if (!responseSent) {
                  responseSent = true;
                  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n';
                  return {
                    done: false,
                    value: new TextEncoder().encode(payload),
                  };
                }

                return { done: true, value: undefined };
              },
              cancel() {
                return Promise.reject(new Error('stdout cancel failed'));
              },
            };
          },
        },
        stderr: null,
        exited: new Promise<number>(() => {}),
        kill() {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    try {
      const transport = track(new StdioTransport({ command: 'bun' }));
      await expect(transport.send({ method: 'test' })).resolves.toEqual({ result: 'ok' });

      // Allow the read loop finally-block to run after stdout reports `done: true`.
      await Bun.sleep(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('swallows stderr reader cancellation failures during stderr-loop cleanup', async () => {
    let responseSent = false;
    let stderrSent = false;
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
      return {
        stdin: {
          async write() {
            return 1;
          },
        },
        stdout: {
          getReader() {
            return {
              async read() {
                if (!responseSent) {
                  responseSent = true;
                  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n';
                  return {
                    done: false,
                    value: new TextEncoder().encode(payload),
                  };
                }

                return { done: true, value: undefined };
              },
              cancel() {
                return Promise.resolve();
              },
            };
          },
        },
        stderr: {
          getReader() {
            return {
              async read() {
                if (!stderrSent) {
                  stderrSent = true;
                  return {
                    done: false,
                    value: new TextEncoder().encode('stderr line\n'),
                  };
                }

                return { done: true, value: undefined };
              },
              cancel() {
                return Promise.reject(new Error('stderr cancel failed'));
              },
            };
          },
        },
        exited: new Promise<number>(() => {}),
        kill() {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    try {
      const transport = track(new StdioTransport({ command: 'bun' }));
      await expect(transport.send({ method: 'test' })).resolves.toEqual({ result: 'ok' });

      // Allow the stderr loop to finish reading and run its cleanup path.
      await Bun.sleep(0);
      expect(warnSpy).toHaveBeenCalledWith('[weft:mcp:stdio:stderr] stderr line');
    } finally {
      spawnSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Framing regression gate (Track 8 — Phase 6)
  //
  // These tests lock in the current newline-delimited framing behavior of
  // `StdioTransport.#startReadLoop` against a character-table of
  // tricky-but-legal input patterns. They exist so that when Phase 7
  // deduplicates `splitNewlineDelimitedBuffer` into a shared
  // `json-rpc-framing.ts` helper consumed by both MCP stdio and the new
  // runtime-stdio subcommand, any drift from the pre-extraction contract
  // breaks tests here BEFORE it reaches production.
  //
  // The input patterns covered:
  //   - CRLF line endings instead of bare LF (current behavior: `\r`
  //     survives into `JSON.parse` if the trim() call doesn't catch it)
  //   - Response split across multiple chunk boundaries (buffer must
  //     accumulate partial lines across reads)
  //   - Interleaved blank / whitespace-only lines (must be skipped, not
  //     logged as malformed JSON)
  //   - Response without a trailing newline (known limitation: the
  //     buffered frame is never delivered until a newline appears)
  //   - Oversize single frame (~1 MB — confirm the buffer absorbs it
  //     without corruption)
  // ---------------------------------------------------------------------------
  describe('framing regression gate', () => {
    it('accepts CRLF-terminated responses (trim() handles the trailing \\r)', async () => {
      const script = await createMockServer('crlf');
      const transport = track(new StdioTransport({ command: 'bun', args: [script] }));
      const response = await transport.send({ method: 'test' });
      expect(response.result).toBe('crlf-ok');
    });

    it('reassembles responses split across many chunk boundaries', async () => {
      const script = await createMockServer('chunked');
      const transport = track(new StdioTransport({ command: 'bun', args: [script] }));
      const response = await transport.send({ method: 'test' });
      expect(response.result).toBe('chunked-ok');
    });

    it('skips blank and whitespace-only lines without logging malformed-JSON warnings', async () => {
      const script = await createMockServer('empty-lines');
      const transport = track(new StdioTransport({ command: 'bun', args: [script] }));
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const response = await transport.send({ method: 'test' });
        expect(response.result).toBe('empty-lines-ok');
        // Empty / whitespace-only lines must be dropped silently — they
        // are not malformed JSON, they are framing artifacts.
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('[weft:mcp:stdio] Ignoring malformed JSON'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('buffers a response with no trailing newline indefinitely (known framing limitation)', async () => {
      const script = await createMockServer('no-trailing-newline');
      const transport = track(new StdioTransport({ command: 'bun', args: [script], timeout: 300 }));
      // The response bytes arrive on stdout but the reader splits on
      // '\n' — so without a trailing newline the frame sits in the
      // buffer and the client times out. This asserts the existing
      // contract so any future change (e.g. flush on stream close) is
      // an intentional behavior change, not accidental.
      await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
    });

    it('absorbs an oversize single-frame response (~1 MB padding)', async () => {
      const script = await createMockServer('oversize');
      const transport = track(
        new StdioTransport({ command: 'bun', args: [script], timeout: 5000 }),
      );
      const response = await transport.send({ method: 'test' });
      const result = response.result as { padding: string } | undefined;
      expect(result?.padding.length).toBe(1024 * 1024);
    });
  });

  describe('healthCheck', () => {
    it('returns true when server responds to ping', async () => {
      const script = await createMockServer('health');
      const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

      expect(await transport.healthCheck()).toBe(true);
    });

    it('returns false when process crashes', async () => {
      const script = await createMockServer('crash');
      const transport = track(new StdioTransport({ command: 'bun', args: [script], timeout: 500 }));

      expect(await transport.healthCheck()).toBe(false);
    });
  });
});
