/**
 * A held connection: the transport that opened it calls `release` once, when the connection ends.
 * Declared apart from the server's connection counting so the transports that hold one need not
 * import the server's runtime context.
 *
 * @module server/connection-lease
 */

export type ConnectionLease = Readonly<{ release(): void }>;
