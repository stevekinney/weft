/**
 * How long Bun lets a connection stay silent before it closes it, for the server `serve()` starts.
 */
import { DEFAULT_SSE_HEARTBEAT_INTERVAL_MS } from "../embedded/backchannel/src/internals.ts";
import { MAX_POLL_TIMEOUT } from './runtime/task-polling.ts';

/** Seconds Bun waits past the longest silence a connection must survive. @internal Test export. */
export const SERVER_IDLE_TIMEOUT_MARGIN_SECONDS = 30;

/**
 * Seconds a connection may stay silent before Bun closes it. Bun's default of 10 is shorter than
 * the 15 second SSE heartbeat, which cut quiet streams (`ERR_INCOMPLETE_CHUNKED_ENCODING`), and a
 * maximum-length long poll is silent for its whole wait: so the longer of the two plus a margin.
 * Bun caps it at 255. @internal Test export.
 */
export const SERVER_IDLE_TIMEOUT_SECONDS =
  Math.ceil(Math.max(DEFAULT_SSE_HEARTBEAT_INTERVAL_MS, MAX_POLL_TIMEOUT) / 1000) +
  SERVER_IDLE_TIMEOUT_MARGIN_SECONDS;
