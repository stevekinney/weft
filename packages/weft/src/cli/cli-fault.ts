/**
 * The structured failure every server-facing and schedule CLI command reports: the same fields as
 * a fault on the wire (`code`, `message`, `retryable`, `remediation`), so an agent that reads
 * `weft workflow ... --json` gets a code and a next step instead of prose.
 *
 * @module cli/cli-fault
 */

import { isFaultCode, type FaultCode } from "../embedded/backchannel/src/index.ts";
import {
  FAULT_CODE_RETRYABLE,
  classifyEngineError,
  remediationProblem,
} from "../embedded/backchannel/src/internals.ts";
import { ConnectionConfigurationError } from '../connection.ts';
import { weftFaultPolicy } from '../server/weft-fault-policy.ts';
import { prettyJson } from './output.ts';
import type { CommandOutput } from './types.ts';

/** What a failed command reports: a fault code, a message, whether a retry can help, and the next step. */
export type CliFault = {
  /** The server's {@link FaultCode}, or the code of the same meaning for a failure the CLI found itself. */
  readonly code: FaultCode;
  readonly message: string;
  /** Whether repeating the identical command later can succeed. */
  readonly retryable: boolean;
  /** One line saying what to do next, when there is something to say. */
  readonly remediation?: string;
};

/** A fault of `code`, with `retryable` from the code's single table in the operation layer. */
export function cliFault(code: FaultCode, message: string, remediation?: string): CliFault {
  return {
    code,
    message,
    retryable: FAULT_CODE_RETRYABLE[code],
    ...(remediation === undefined ? {} : { remediation }),
  };
}

/**
 * The fault a server's JSON-RPC `error` carries: `data.weftCode` is the coarse fault code, and
 * `data.retryable` and `data.remediation` the advice. A server that predates the fields (or an
 * answer that is not a fault at all) is read as `EngineFailure`, with `retryable` from the table.
 */
export function faultFromWireError(message: string, data: unknown): CliFault {
  const record = typeof data === 'object' && data !== null ? data : undefined;
  const weftCode: unknown = record === undefined ? undefined : Reflect.get(record, 'weftCode');
  const code: FaultCode = isFaultCode(weftCode) ? weftCode : 'EngineFailure';
  const retryable: unknown = record === undefined ? undefined : Reflect.get(record, 'retryable');
  const remediation: unknown =
    record === undefined ? undefined : Reflect.get(record, 'remediation');
  return {
    code,
    message,
    retryable: typeof retryable === 'boolean' ? retryable : FAULT_CODE_RETRYABLE[code],
    ...(typeof remediation === 'string' && remediationProblem(remediation) === undefined
      ? { remediation }
      : {}),
  };
}

/**
 * The fault of an error thrown by the embedded engine a local command runs. The code comes from
 * the same classification the server applies to a thrown error (Weft's fault policy for its own
 * classes, then the generic message heuristics: `NotFound`, `Conflict`, `Timeout`); an error that
 * classification leaves as `EngineFailure` takes `fallback`, the code of the command's own caller
 * mistake (`InvalidParams` for a schedule spec it was asked to create). The message is the
 * error's own, because the operator who ran the command is the one who reads it.
 */
export function faultFromLocalError(
  error: unknown,
  fallback: FaultCode = 'EngineFailure',
): CliFault {
  const message = error instanceof Error ? error.message : String(error);
  const classified = classifyEngineError(error, undefined, weftFaultPolicy).code;
  return cliFault(classified === 'EngineFailure' ? fallback : classified, message);
}

/** Why a request never produced a JSON-RPC answer, as far as the CLI can tell. */
export type TransportFailure = {
  readonly error: unknown;
  /** The status of the last HTTP response, when the server answered at all. */
  readonly httpStatus: number | undefined;
};

/**
 * The fault of a call that failed before a JSON-RPC answer: a server URL that cannot be used is a
 * caller mistake (`InvalidParams`), a refused credential is `Unauthorized` or `Forbidden`, and
 * anything else (nothing listening, a dropped connection, a proxy error) is `Unavailable`, the one
 * code whose repair is to try again.
 */
export function faultFromTransportFailure({ error, httpStatus }: TransportFailure): CliFault {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ConnectionConfigurationError) {
    return cliFault(
      'InvalidParams',
      `connection failed: ${detail}`,
      'Pass a full server URL such as http://localhost:7233 with --server, WEFT_ADDR or --profile',
    );
  }
  if (httpStatus === 401) {
    return cliFault(
      'Unauthorized',
      'connection failed: the server refused the credentials (HTTP 401)',
      'Pass a valid token with --token, WEFT_TOKEN or --profile',
    );
  }
  if (httpStatus === 403) {
    return cliFault(
      'Forbidden',
      'connection failed: the server refused this credential (HTTP 403)',
      'Use a token that holds the scope this command needs',
    );
  }
  return cliFault(
    'Unavailable',
    `connection failed: ${detail}`,
    "Start a server with 'weft serve', or point --server, WEFT_ADDR or --profile at one that is running",
  );
}

/**
 * Render a failed command. With `json`, stdout holds `{ ok: false, error }` and stderr stays empty,
 * as `weft api --json` does. Otherwise stderr holds the message (after `prefix`), then a `Try:`
 * line when the fault has a remediation. The exit code is the caller's, never derived here.
 */
export function renderFault(
  fault: CliFault,
  options: { readonly json: boolean; readonly exitCode: number; readonly prefix?: string },
): CommandOutput {
  if (options.json) {
    // Only the four fault fields: `fault` may be a larger object (a call result with its `kind`).
    const { code, message, retryable, remediation } = fault;
    const error = {
      code,
      message,
      retryable,
      ...(remediation === undefined ? {} : { remediation }),
    };
    return { stdout: prettyJson({ ok: false, error }), exitCode: options.exitCode };
  }
  const lines = [`${options.prefix ?? ''}${fault.message}`];
  if (fault.remediation !== undefined) lines.push(`Try: ${fault.remediation}`);
  return { stdout: '', stderr: lines.join('\n'), exitCode: options.exitCode };
}
