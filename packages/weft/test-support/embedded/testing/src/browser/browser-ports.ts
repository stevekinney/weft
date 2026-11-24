/**
 * Select run-local ports and propagate them to Playwright workers and servers.
 * Hold all new sockets until selection finishes so one run cannot select the
 * same port twice. An inherited selection is authoritative, even when held:
 * Playwright must reject a foreign server rather than silently change targets.
 */
export function browserPorts<const Names extends readonly string[]>(
  names: Names,
  environment: NodeJS.ProcessEnv = process.env,
): Record<Names[number], number> {
  const ports: Record<string, number> = {};
  const listeners: Array<{ stop(): void }> = [];
  try {
    for (const name of names) {
      const value = environment[name];
      if (value === undefined) continue;
      const port = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid browser port ${name}: ${value}`);
      }
      ports[name] = port;
    }
    if (new Set(Object.values(ports)).size !== Object.keys(ports).length) {
      throw new Error('Browser server ports must be distinct.');
    }
    for (const name of names) {
      if (ports[name] !== undefined) continue;
      const listener = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data() {} },
      });
      listeners.push(listener);
      if (Object.values(ports).includes(listener.port)) {
        throw new Error(`Allocated browser port ${listener.port} duplicates an inherited port.`);
      }
      ports[name] = listener.port;
    }
    for (const [name, port] of Object.entries(ports)) environment[name] = String(port);
    return ports;
  } finally {
    // The actual webServer owns its socket. If another process takes a selected
    // port before startup, strict binding/reuseExistingServer:false fails loudly.
    for (const listener of listeners) listener.stop();
  }
}
