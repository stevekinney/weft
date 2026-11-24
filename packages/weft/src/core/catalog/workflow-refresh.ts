import { parseWorkflowRevisionManifest } from '../contract/manifest-parse.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowCatalog } from './workflow-catalog.ts';
import {
  failureReason,
  hostFailure,
  stoppedError,
  WorkflowRefreshError,
} from './workflow-refresh-failure.ts';
import type {
  WorkflowRefreshArtifact,
  WorkflowRefreshCoordinatorOptions,
  WorkflowRefreshDiagnostics,
  WorkflowRefreshOptions,
  WorkflowRefreshResponse,
  WorkflowRefreshResult,
  WorkflowRefreshSource,
  WorkflowRefreshStatus,
} from './workflow-refresh-types.ts';

type RefreshResult = WorkflowRefreshResult;

const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Opt-in, single-flight workflow refresh. Fetching is deliberately supplied by
 * the host so this class remains usable with fetch, a registry client, or a
 * test transport without embedding a network policy in the catalog.
 */
export class WorkflowRefreshCoordinator implements AsyncDisposable {
  readonly #catalog: WorkflowCatalog;
  readonly #sources = new Map<string, WorkflowRefreshSource>();
  readonly #maxArtifactBytes: number;
  readonly #pollIntervalMs: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
  readonly #etags = new Map<string, string>();
  readonly #artifacts = new Map<string, WorkflowRefreshArtifact>();
  readonly #lastValidatedArtifact = new Map<string, WorkflowRefreshArtifact>();
  readonly #diagnostics = new Map<string, WorkflowRefreshDiagnostics>();
  readonly #inFlight = new Map<string, Promise<RefreshResult>>();
  readonly #signalIds = new WeakMap<AbortSignal, number>();
  readonly #abortControllers = new Set<AbortController>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #polling = false;
  #nextPollAt: number | undefined;
  #stopped = false;
  #backoffMs: number;
  #nextSignalId = 0;

  constructor(options: WorkflowRefreshCoordinatorOptions) {
    this.#catalog = options.catalog;
    for (const [name, source] of options.sources) this.#sources.set(name, source);
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#now = options.now ?? Date.now;
    assertRefreshLimits(this.#maxArtifactBytes, this.#pollIntervalMs, this.#maxBackoffMs);
    this.#backoffMs = this.#pollIntervalMs;
  }

  async refresh(name: string, options?: WorkflowRefreshOptions): Promise<RefreshResult> {
    if (this.#stopped) throw stoppedError();
    const signalKey =
      options?.signal === undefined ? '' : this.#signalId(options.signal).toString();
    const key = `${name}\u0000${options?.activate ?? 'never'}\u0000${options?.expectedGeneration ?? ''}\u0000${signalKey}`;
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing;
    const promise = this.#refresh(name, options).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, promise);
    return promise;
  }

  registerSource(name: string, source: WorkflowRefreshSource): void {
    if (this.#stopped) throw stoppedError();
    this.#sources.set(name, source);
  }

  #signalId(signal: AbortSignal): number {
    const existing = this.#signalIds.get(signal);
    if (existing !== undefined) return existing;
    const id = ++this.#nextSignalId;
    this.#signalIds.set(signal, id);
    return id;
  }

  dispose(): void {
    this.#stopped = true;
    this.stopPolling();
    for (const controller of this.#abortControllers) controller.abort();
  }

  assertSynchronousDisposeSafe(): void {
    if (this.#inFlight.size > 0) {
      throw new Error(
        'Cannot synchronously dispose while workflow refresh is in flight; use async disposal',
      );
    }
  }

  diagnostics(name?: string): readonly WorkflowRefreshDiagnostics[] {
    if (name !== undefined) {
      const diagnostic = this.#diagnostics.get(name);
      return diagnostic === undefined ? [] : [diagnostic];
    }
    return [...this.#diagnostics.values()];
  }

  /**
   * Every registered source (a never-checked one reads `idle`), sorted by name,
   * plus the polling policy and next check while polling runs. `diagnostics()`
   * keeps listing only sources that have been checked.
   */
  status(): WorkflowRefreshStatus {
    const sources = [...this.#sources.keys()]
      .toSorted()
      .map((name) => this.#diagnostics.get(name) ?? { name, state: 'idle' as const });
    return {
      sources,
      polling: this.#polling
        ? {
            intervalMilliseconds: this.#pollIntervalMs,
            maxBackoffMilliseconds: this.#maxBackoffMs,
            backoffMilliseconds: this.#backoffMs,
            nextCheckAt: this.#nextPollAt,
          }
        : undefined,
    };
  }

  /** Start opt-in polling. Polling failures back off and never activate stale data. */
  startPolling(): void {
    if (this.#stopped || this.#polling) return;
    this.#polling = true;
    this.#schedulePoll(this.#pollIntervalMs);
  }

  /** Run one bounded maintenance cycle for hosts using `backgroundTasks: 'manual'`. */
  async runMaintenance(): Promise<readonly RefreshResult[]> {
    if (this.#stopped) return [];
    const results: RefreshResult[] = [];
    for (const name of this.#sources.keys()) {
      results.push(await this.refresh(name));
    }
    return results;
  }

  stopPolling(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#polling = false;
    this.#nextPollAt = undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.dispose();
    await Promise.allSettled(this.#inFlight.values());
    this.#inFlight.clear();
    this.#artifacts.clear();
    this.#lastValidatedArtifact.clear();
  }

  async #refresh(name: string, options?: WorkflowRefreshOptions): Promise<RefreshResult> {
    const source = this.#sources.get(name);
    if (source === undefined)
      throw new WorkflowRefreshError(
        'not-registered',
        `No workflow refresh source registered for "${name}"`,
      );
    this.#record(name, { state: 'checking', error: undefined, reason: undefined });
    const controller = new AbortController();
    this.#abortControllers.add(controller);
    try {
      const signal = mergeSignals(controller.signal, options?.signal);
      const response = await this.#fetch(name, source, signal);
      if (response.status === 304) return this.#notModified(name);
      const artifact = await this.#prepare(name, source, response, signal);
      this.#record(name, { state: 'warming' });
      const activation = await this.#install(
        name,
        source,
        artifact,
        response.etag ?? artifact.digest,
        options,
        signal,
      );
      const result = this.#result(name, artifact.manifest, activation);
      this.#record(name, {
        state: result.status,
        ...(activation?.applied === true
          ? {
              generation: activation.pointer.generation,
              activatedRevision: artifact.manifest.revision,
              activatedDigest: artifact.digest,
            }
          : {}),
        checkedAt: this.#now(),
      });
      this.#backoffMs = this.#pollIntervalMs;
      return result;
    } catch (error) {
      this.#record(name, {
        state: 'failed',
        checkedAt: this.#now(),
        error: error instanceof Error ? error.message : String(error),
        reason: failureReason(error, options?.signal, this.#stopped),
      });
      this.#backoffMs = Math.min(
        this.#maxBackoffMs,
        Math.max(this.#pollIntervalMs, this.#backoffMs * 2),
      );
      throw error;
    } finally {
      this.#abortControllers.delete(controller);
    }
  }

  async #fetch(
    name: string,
    source: WorkflowRefreshSource,
    signal: AbortSignal,
  ): Promise<WorkflowRefreshResponse> {
    try {
      return await source.fetch({
        ...(this.#etags.has(name) ? { etag: this.#etags.get(name) } : {}),
        signal,
      });
    } catch (error) {
      throw hostFailure('source', error, signal);
    }
  }

  #notModified(name: string): RefreshResult {
    this.#assertActive();
    if (!this.#etags.has(name) || !this.#lastValidatedArtifact.has(name)) {
      throw new WorkflowRefreshError(
        'source',
        '304 Not Modified requires a prior validated ETag and artifact',
      );
    }
    this.#record(name, { state: 'not-modified', checkedAt: this.#now() });
    this.#backoffMs = this.#pollIntervalMs;
    const etag = this.#etags.get(name);
    return etag === undefined ? { status: 'not-modified' } : { status: 'not-modified', etag };
  }

  async #prepare(
    name: string,
    source: WorkflowRefreshSource,
    response: WorkflowRefreshResponse,
    signal: AbortSignal,
  ): Promise<WorkflowRefreshArtifact> {
    const artifact = response.artifact;
    if (artifact === undefined)
      throw new WorkflowRefreshError('source', 'Refresh response status 200 omitted artifact');
    const digest = await digestBytes(artifact.bytes);
    this.#assertActive();
    this.#validateArtifact(name, artifact, digest);
    validateArtifactBinding(artifact);
    const parsed = await parseWorkflowRevisionManifest(artifact.manifest);
    if (!parsed.ok)
      throw new WorkflowRefreshError(
        'contract',
        `Workflow artifact manifest is invalid: ${parsed.reason}`,
      );
    try {
      await source.validateRuntime(artifact.runtime, signal);
    } catch (error) {
      throw hostFailure('runtime', error, signal);
    }
    this.#assertActive();
    return artifact;
  }

  /**
   * Record `artifact` as the candidate. Called only once the catalog has
   * installed it, so the revision, digest, contract hash, last validated
   * artifact, and ETag always describe one installed artifact, and a check that
   * fails before this point leaves the previous installed candidate whole.
   */
  #commitCandidate(name: string, artifact: WorkflowRefreshArtifact, etag: string): void {
    this.#artifacts.set(artifact.digest, artifact);
    this.#lastValidatedArtifact.set(name, artifact);
    this.#etags.set(name, etag);
    this.#record(name, {
      etag,
      revision: artifact.manifest.revision,
      digest: artifact.digest,
      contractHash: artifact.manifest.contractHash,
    });
  }

  async #install(
    name: string,
    source: WorkflowRefreshSource,
    artifact: WorkflowRefreshArtifact,
    etag: string,
    options: WorkflowRefreshOptions | undefined,
    signal: AbortSignal,
  ) {
    let definition: RegisteredWorkflowDefinition;
    try {
      definition = await source.warm(artifact, signal);
    } catch (error) {
      throw hostFailure('warming', error, signal);
    }
    this.#assertActive();
    await this.#catalog.install(artifact.manifest, definition);
    this.#commitCandidate(name, artifact, etag);
    this.#assertActive();
    if (options?.activate !== 'if-compatible') return undefined;
    const activationOptions =
      options.expectedGeneration === undefined
        ? undefined
        : { expectedGeneration: options.expectedGeneration };
    return this.#catalog.activateCandidate(name, artifact.manifest, activationOptions);
  }

  #result(
    name: string,
    manifest: WorkflowRevisionManifest,
    activation: Awaited<ReturnType<WorkflowCatalog['activateCandidate']>> | undefined,
  ): RefreshResult {
    const etag = this.#etags.get(name);
    if (activation?.applied === true)
      return {
        status: 'activated',
        ...(etag === undefined ? {} : { etag }),
        manifest,
        pointer: activation.pointer,
        activation,
      };
    return {
      status: 'installed',
      ...(etag === undefined ? {} : { etag }),
      manifest,
      ...(activation === undefined ? {} : { activation }),
    };
  }

  #validateArtifact(name: string, artifact: WorkflowRefreshArtifact, digest: string): void {
    if (artifact.bytes.byteLength > this.#maxArtifactBytes)
      throw new WorkflowRefreshError(
        'integrity',
        `Workflow artifact exceeds ${this.#maxArtifactBytes} bytes`,
      );
    if (artifact.digest !== digest)
      throw new WorkflowRefreshError(
        'integrity',
        'Workflow artifact digest does not match its bytes',
      );
    if (
      artifact.identity.name !== name ||
      artifact.identity.revision !== artifact.manifest.revision
    ) {
      throw new WorkflowRefreshError(
        'identity',
        'Workflow artifact identity does not match its requested catalog identity',
      );
    }
    if (artifact.manifest.name !== name)
      throw new WorkflowRefreshError(
        'identity',
        'Workflow artifact manifest name does not match its requested catalog identity',
      );
    if (!artifact.manifest.revision || artifact.runtime.length === 0)
      throw new WorkflowRefreshError(
        'integrity',
        'Workflow artifact manifest/runtime proof is incomplete',
      );
  }

  #record(name: string, patch: Partial<WorkflowRefreshDiagnostics>): void {
    const previous = this.#diagnostics.get(name);
    this.#diagnostics.set(name, { name, state: previous?.state ?? 'idle', ...previous, ...patch });
  }

  #assertActive(): void {
    if (this.#stopped) throw stoppedError();
  }

  #schedulePoll(delay: number): void {
    if (this.#stopped) return;
    this.#nextPollAt = this.#now() + delay;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#nextPollAt = undefined;
      if (this.#stopped) return;
      void this.runMaintenance()
        .then(() => this.#schedulePoll(this.#pollIntervalMs))
        .catch(() => this.#schedulePoll(this.#backoffMs));
    }, delay);
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function mergeSignals(internal: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  if (caller === undefined) return internal;
  const controller = new AbortController();
  const abort = (): void => controller.abort(caller.reason ?? internal.reason);
  if (internal.aborted || caller.aborted) abort();
  internal.addEventListener('abort', abort, { once: true });
  caller.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function validateArtifactBinding(artifact: WorkflowRefreshArtifact): void {
  let encoded: unknown;
  try {
    encoded = JSON.parse(new TextDecoder().decode(artifact.bytes));
  } catch {
    throw new WorkflowRefreshError(
      'integrity',
      'Workflow artifact bytes are not a complete JSON artifact',
    );
  }
  if (typeof encoded !== 'object' || encoded === null)
    throw new WorkflowRefreshError(
      'integrity',
      'Workflow artifact bytes are not a complete artifact envelope',
    );
  const envelope = encoded as Record<string, unknown>;
  if (JSON.stringify(envelope['manifest']) !== JSON.stringify(artifact.manifest))
    throw new WorkflowRefreshError(
      'integrity',
      'Workflow artifact manifest is not bound to its bytes',
    );
  if (JSON.stringify(envelope['identity']) !== JSON.stringify(artifact.identity))
    throw new WorkflowRefreshError(
      'integrity',
      'Workflow artifact identity is not bound to its bytes',
    );
  if (envelope['runtime'] !== artifact.runtime)
    throw new WorkflowRefreshError(
      'integrity',
      'Workflow artifact runtime proof is not bound to its bytes',
    );
}

function assertRefreshLimits(
  maxArtifactBytes: number,
  pollIntervalMs: number,
  maxBackoffMs: number,
): void {
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new RangeError('maxArtifactBytes must be a positive safe integer');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError('pollIntervalMs must be positive');
  }
  if (!Number.isFinite(maxBackoffMs) || maxBackoffMs <= 0) {
    throw new RangeError('maxBackoffMs must be positive');
  }
}
