/**
 * `weft codegen` subcommand executor. Reads a registry snapshot from
 * either a live Weft server or a vendored JSON file, validates the
 * envelope, and emits a deterministic `.d.ts` augmenting the public
 * `'weft'` module.
 *
 * All user-caused failures (missing file, bad JSON, version mismatch,
 * HTTP errors, network timeout, missing parent directory, filesystem
 * errors) return a {@link CommandOutput} with `exitCode: 1` and a
 * single-line stderr diagnostic. Thrown errors are reserved for
 * programmer bugs.
 *
 * @module cli/codegen
 */

import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';

import { z } from 'zod';

import { ConnectionConfigurationError, resolveConnection } from '../connection.ts';
import {
  REGISTRY_VERSION,
  type RegistryActivityEntry,
  type RegistrySnapshot,
  type RegistryWorkflowEntry,
} from '../core/registry-snapshot.ts';
import { CodegenEmitError, emitRegistryDeclaration } from './codegen-emit.ts';
import type { CommandOutput } from './types.ts';

// JSON Schema permits a boolean at any schema position (`true` →
// accept anything, `false` → accept nothing). The emitter handles
// both, so the validator must accept them too at the
// `inputSchema`/`outputSchema` slots.
const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);

const workflowEntrySchema = z
  .object({
    inputSchema: jsonSchema.optional(),
    outputSchema: jsonSchema.optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const activityEntrySchema = z
  .object({
    inputSchema: jsonSchema.optional(),
    outputSchema: jsonSchema.optional(),
    queue: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const registrySnapshotSchema = z
  .object({
    registryVersion: z.literal(REGISTRY_VERSION),
    workflows: z.record(z.string(), workflowEntrySchema),
    activities: z.record(z.string(), activityEntrySchema),
  })
  .passthrough();

/** Parsed options accepted by {@link executeCodegen}. */
export type CodegenOptions = {
  server?: string;
  from?: string;
  token?: string;
  out: string;
  timeoutMs: number;
  /** When true, emit a single JSON object on stdout for machine consumers. */
  json?: boolean;
};

type CodegenConnection = { baseUrl: string; token: string | undefined };

/**
 * Run the codegen pipeline end-to-end. Returns a {@link CommandOutput}
 * describing the result. Never rejects for user-caused failures.
 */
export async function executeCodegen(options: CodegenOptions): Promise<CommandOutput> {
  const snapshotResult = await loadSnapshot(options);
  if (!snapshotResult.ok) return formatFailure(snapshotResult.error, options);

  const validation = validateSnapshot(snapshotResult.value);
  if (!validation.ok) return formatFailure(validation.error, options);

  const snapshot = validation.value;
  let content: string;
  try {
    content = emitRegistryDeclaration(snapshot);
  } catch (error) {
    if (error instanceof CodegenEmitError) {
      return formatFailure(`codegen: ${error.message}`, options);
    }
    const message = error instanceof Error ? error.message : String(error);
    return formatFailure(`codegen: unexpected emitter failure: ${message}`, options);
  }

  const writeResult = await writeOutput(options.out, content);
  if (!writeResult.ok) return formatFailure(writeResult.error, options);

  const workflowCount = Object.keys(snapshot.workflows).length;
  const activityCount = Object.keys(snapshot.activities).length;

  return formatSuccess(options, writeResult.action, workflowCount, activityCount);
}

function formatFailure(message: string, options: CodegenOptions): CommandOutput {
  if (options.json) {
    return {
      stdout: '',
      stderr: JSON.stringify({ ok: false, error: message }),
      exitCode: 1,
    };
  }
  return { stdout: '', stderr: message, exitCode: 1 };
}

function formatSuccess(
  options: CodegenOptions,
  action: 'wrote' | 'unchanged',
  workflows: number,
  activities: number,
): CommandOutput {
  if (options.json) {
    // Include workflow/activity counts in both `wrote` and `unchanged`
    // payloads so machine consumers get a stable shape. The counts
    // reflect what the snapshot contains either way.
    const payload = { ok: true, action, out: options.out, workflows, activities };
    return { stdout: JSON.stringify(payload), exitCode: 0 };
  }
  if (action === 'unchanged') {
    return { stdout: `codegen: ${options.out} is up to date`, exitCode: 0 };
  }
  return {
    stdout: `codegen: wrote ${options.out} (${workflows} workflows, ${activities} activities)`,
    exitCode: 0,
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function loadSnapshot(options: CodegenOptions): Promise<Result<unknown>> {
  // Re-guard the source XOR even though the parser already rejects this
  // combination, because `executeCodegen` is exported and may be called
  // programmatically from tests or future tooling that bypasses the
  // parser.
  if (options.from !== undefined && options.server !== undefined) {
    return { ok: false, error: 'codegen: --server and --from cannot be used together' };
  }
  if (options.from !== undefined) {
    return loadSnapshotFromFile(options.from);
  }

  const connectionResult = resolveCodegenConnection(options);
  if (!connectionResult.ok) return connectionResult;
  return loadSnapshotFromServer(
    connectionResult.value.baseUrl,
    connectionResult.value.token,
    options.timeoutMs,
  );
}

function resolveCodegenConnection(options: CodegenOptions): Result<CodegenConnection> {
  try {
    const connection = resolveConnection({
      ...(options.server !== undefined ? { server: options.server } : {}),
      ...(options.token !== undefined ? { token: options.token } : {}),
    });
    return {
      ok: true,
      value: { baseUrl: connection.server.toString(), token: connection.token },
    };
  } catch (error) {
    if (error instanceof ConnectionConfigurationError) {
      return { ok: false, error: `codegen: ${error.message}` };
    }
    throw error;
  }
}

async function loadSnapshotFromFile(path: string): Promise<Result<unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { ok: false, error: `codegen: --from file not found at '${path}'` };
  }
  try {
    const value: unknown = await file.json();
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `codegen: failed to parse JSON at '${path}': ${message}` };
  }
}

/**
 * Compose the registry URL from a user-supplied base. Appends
 * `/api/v1/registry` to whatever path is present, so
 * `--server http://host/base` reaches `http://host/base/api/v1/registry`.
 * If the supplied URL already ends with `/api/v1/registry` (with or
 * without a trailing slash), the path is preserved as-is.
 */
export function composeRegistryUrl(serverUrl: string): URL {
  const url = new URL(serverUrl);
  const trimmedPath = url.pathname.replace(/\/+$/, '');
  if (trimmedPath.endsWith('/api/v1/registry')) {
    url.pathname = trimmedPath;
    return url;
  }
  url.pathname = `${trimmedPath}/api/v1/registry`;
  return url;
}

function buildRequestHeaders(token: string | undefined): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  if (token !== undefined && token !== '') {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

function describeFetchError(error: unknown, timeoutMs: number, resolvedUrl: URL): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `codegen: timed out after ${timeoutMs}ms fetching ${resolvedUrl.toString()}`;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `codegen: request aborted after ${timeoutMs}ms fetching ${resolvedUrl.toString()}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `codegen: failed to fetch ${resolvedUrl.toString()}: ${message}`;
}

async function parseRegistryResponse(
  response: Response,
  resolvedUrl: URL,
): Promise<Result<unknown>> {
  if (!response.ok) {
    return {
      ok: false,
      error: `codegen: ${resolvedUrl.toString()} returned ${response.status} ${response.statusText}`,
    };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/\bjson\b/i.test(contentType)) {
    return {
      ok: false,
      error: `codegen: ${resolvedUrl.toString()} returned non-JSON content-type '${contentType}'`,
    };
  }

  try {
    const value: unknown = await response.json();
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `codegen: failed to parse response body from ${resolvedUrl.toString()}: ${message}`,
    };
  }
}

async function loadSnapshotFromServer(
  serverUrl: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<Result<unknown>> {
  let resolvedUrl: URL;
  try {
    resolvedUrl = composeRegistryUrl(serverUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `codegen: invalid server URL '${serverUrl}': ${message}` };
  }

  let response: Response;
  try {
    response = await fetch(resolvedUrl, {
      headers: buildRequestHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: describeFetchError(error, timeoutMs, resolvedUrl) };
  }

  return parseRegistryResponse(response, resolvedUrl);
}

function validateSnapshot(value: unknown): Result<RegistrySnapshot> {
  // Surface a clear version-mismatch diagnostic before delegating to
  // the full Zod schema, since the version check is the most likely
  // failure when consumers vendor a snapshot from an older or newer
  // server.
  if (value !== null && typeof value === 'object' && 'registryVersion' in value) {
    const { registryVersion: actual } = value as { registryVersion?: unknown };
    if (actual !== REGISTRY_VERSION) {
      return {
        ok: false,
        error: `codegen: registryVersion ${String(actual)} is not supported (expected ${REGISTRY_VERSION}); upgrade or regenerate the snapshot`,
      };
    }
  }

  const parsed = registrySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `codegen: invalid registry snapshot: ${formatZodError(parsed.error)}`,
    };
  }
  // Zod's `passthrough` keeps unknown top-level keys (forward-compat),
  // but that pulls in an `[x: string]: unknown` index signature on the
  // inferred type. We only care about the known fields downstream, so
  // project the parsed value onto the `RegistrySnapshot` shape by
  // copying just the documented keys. This preserves forward-compat
  // (unknown keys are accepted by the validator) without leaking the
  // index signature into the emitter's type domain.
  const snapshot: RegistrySnapshot = {
    registryVersion: parsed.data.registryVersion,
    workflows: projectWorkflows(parsed.data.workflows),
    activities: projectActivities(parsed.data.activities),
  };
  return { ok: true, value: snapshot };
}

/**
 * JSON Schema permits a boolean at any schema position. The
 * canonical `RegistryWorkflowEntry`/`RegistryActivityEntry` types in
 * `core/registry-snapshot.ts` constrain schemas to `Record<string,
 * unknown>` because the in-process builder
 * (`buildRegistrySnapshot`) only produces object schemas. Vendored
 * snapshots from elsewhere may still use boolean roots — normalize
 * them to an object form so the projection stays compatible with the
 * canonical types.
 *
 * `true` → `{}` (accept anything → emitter produces `unknown`).
 * `false` → `{ const: '__never__' }` — a const literal we can encode
 * structurally, but for simplicity and to avoid a magic value, we
 * map `false` to `{}` as well and accept the loss of `never`
 * precision. In practice Zod/Valibot never emit boolean root
 * schemas, so this only affects hand-vendored snapshots, and the
 * conservative `unknown` is harmless (the only downside is that the
 * generated TypeScript becomes wider than strictly necessary).
 */
function normalizeRootSchema(
  schema: boolean | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema === 'boolean') return {};
  return schema;
}

function projectWorkflows(
  raw: Record<string, z.infer<typeof workflowEntrySchema>>,
): Record<string, RegistryWorkflowEntry> {
  const projected: Record<string, RegistryWorkflowEntry> = Object.create(null);
  for (const [name, entry] of Object.entries(raw)) {
    const projection: RegistryWorkflowEntry = {};
    const input = normalizeRootSchema(entry.inputSchema);
    const output = normalizeRootSchema(entry.outputSchema);
    if (input !== undefined) projection.inputSchema = input;
    if (output !== undefined) projection.outputSchema = output;
    if (entry.description !== undefined) projection.description = entry.description;
    if (entry.tags !== undefined) projection.tags = entry.tags;
    projected[name] = projection;
  }
  return projected;
}

function projectActivities(
  raw: Record<string, z.infer<typeof activityEntrySchema>>,
): Record<string, RegistryActivityEntry> {
  const projected: Record<string, RegistryActivityEntry> = Object.create(null);
  for (const [name, entry] of Object.entries(raw)) {
    const projection: RegistryActivityEntry = { queue: entry.queue };
    const input = normalizeRootSchema(entry.inputSchema);
    const output = normalizeRootSchema(entry.outputSchema);
    if (input !== undefined) projection.inputSchema = input;
    if (output !== undefined) projection.outputSchema = output;
    if (entry.description !== undefined) projection.description = entry.description;
    projected[name] = projection;
  }
  return projected;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

type WriteResult = { ok: true; action: 'wrote' | 'unchanged' } | { ok: false; error: string };

async function writeOutput(outPath: string, content: string): Promise<WriteResult> {
  const parent = dirname(outPath);
  try {
    const stats = await fs.stat(parent);
    if (!stats.isDirectory()) {
      return { ok: false, error: `codegen: parent path '${parent}' is not a directory` };
    }
  } catch {
    return { ok: false, error: `codegen: parent directory '${parent}' does not exist` };
  }

  // Idempotent skip: if the existing file already matches byte-for-
  // byte, do not rewrite. Avoids touching mtime and satisfies the
  // "second run does not rewrite" acceptance bullet.
  try {
    const existing = await Bun.file(outPath).text();
    if (existing === content) {
      return { ok: true, action: 'unchanged' };
    }
  } catch {
    // File does not exist yet; fall through to the write path.
  }

  const tempPath = `${outPath}.codegen-${process.pid}-${randomSuffix()}.tmp`;
  try {
    await Bun.write(tempPath, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `codegen: failed to write temp file '${basename(tempPath)}' in '${dirname(outPath)}': ${message}`,
    };
  }

  try {
    await fs.rename(tempPath, outPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.unlink(tempPath).catch(() => {
      // Best-effort cleanup; surface the original rename error.
    });
    return {
      ok: false,
      error: `codegen: failed to rename '${basename(tempPath)}' to '${outPath}': ${message}`,
    };
  }

  return { ok: true, action: 'wrote' };
}

function randomSuffix(): string {
  // 12 hex chars are plenty to avoid collisions for a single CLI
  // invocation; `crypto.randomUUID` would work too but pulls in more
  // characters than we need.
  return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
}
