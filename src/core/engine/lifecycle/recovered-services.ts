import { KEYS } from '../../../storage/interface.ts';
import { DevelopmentWarningEvent } from '../../events.ts';
import type {
  WorkflowServicesResolverInfo,
  WorkflowServicesResolverLaunchOptions,
  WorkflowServicesResolverScheduleInfo,
  WorkflowState,
} from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { decodeScheduleRunMetadata } from '../schedule-run-metadata.ts';
import { loadScheduleState } from '../storage-io.ts';

const RESOLVE_WORKFLOW_SERVICES_OPTION_PATH = 'EngineOptions.resolveWorkflowServices';

/**
 * Re-provide a recovered inline workflow's non-serialized `services` before its
 * generator is driven forward, and decide whether execution should proceed.
 *
 * Both recovery entry points use this: `resumeWorkflowFromStorage` (for a run
 * left `running`) and the delayed-start timer handler (for a `startAfter`/
 * `startAt` run that crashed `pending` before its timer fired). On a fresh
 * process the in-memory `workflowServices` map is empty, so without this a
 * recovered run that originally had services would silently execute with
 * `ctx.services === undefined`.
 *
 * The resolver is only consulted for runs launched WITH services, detected by
 * the durable `KEYS.workflowHasServices` marker. A run that never had services
 * has no marker and proceeds without touching the resolver — so a fail-closed
 * resolver does not fail healthy no-services runs.
 *
 * Returns `false` to proceed (services available or none expected). Returns
 * `true` to STOP — the run was terminally
 * failed (services unavailable), or the terminal commit faulted and the run was
 * left for a later boot to retry. Either way the generator must not advance:
 * driving it without services would crash the body and that throw would escape
 * into the recovery loop, aborting sibling runs.
 *
 * Worker mode skips this (services are inline-only, rejected at `engine.start()`).
 * A resolver throw is treated as `unavailable` with the error as the reason,
 * for the same sibling-isolation reason.
 *
 * @param failRun - Terminally fails just this run with `reason`. Supplied by the
 *   caller because the two entry points reach the termination machinery through
 *   different callback bundles. It receives the canonical terminal error built
 *   by {@link unavailableServicesError}, so both recovery paths fail the run
 *   with an identical message and (via `failWorkflow`'s default) the `system`
 *   failure category.
 * @param onCommitError - Records a fail-warn when `failRun` itself throws, so the
 *   swallowed terminal-commit fault is still observable.
 */
export async function reprovideRecoveredServices(
  internals: EngineInternals,
  state: WorkflowState,
  failRun: (workflowId: string, error: Error) => Promise<void>,
  onCommitError: (source: string, error: unknown, workflowId: string) => void,
  dispatchDiagnostic: (event: Event) => void = () => {},
  resolverInfo?: WorkflowServicesResolverInfo,
): Promise<boolean> {
  const resolver = internals.options.resolveWorkflowServices;
  if (internals.inlineStrategy === null) {
    return false;
  }
  // Same-process case: services are still live in the map (the run was launched
  // in this process and is being resumed/started here). Nothing to re-provide.
  if (internals.workflowServices.has(state.id)) {
    return false;
  }
  // Fresh-process case: only runs that were launched WITH services left a durable
  // "expects services" marker. A run that never had services has no marker, so
  // the resolver must not be consulted — consulting it would fail a healthy
  // no-services run whenever the engine has a fail-closed resolver configured.
  if ((await internals.storage.get(KEYS.workflowHasServices(state.id))) === null) {
    return false;
  }

  if (!resolver) {
    const reason = missingServicesResolverReason(state.id);
    dispatchDiagnostic(
      new DevelopmentWarningEvent(state.id, reason, [RESOLVE_WORKFLOW_SERVICES_OPTION_PATH]),
    );
    try {
      await failRun(state.id, unavailableServicesError(state.id, reason));
    } catch (error) {
      onCommitError('reprovideRecoveredServices', error, state.id);
    }
    return true;
  }

  let reason: string;
  const info = resolverInfo ?? (await workflowServicesResolverInfoFromState(internals, state));
  try {
    const resolution = await resolver(info);
    if (resolution.status === 'available') {
      internals.workflowServices.set(state.id, resolution.services);
      return false;
    }
    reason = resolution.reason;
  } catch (error) {
    // A resolver that throws (e.g. a network-client rebuild rejecting) must not
    // abort recovery of sibling runs — treat it as unavailable.
    reason = error instanceof Error ? error.message : String(error);
  }

  try {
    await failRun(state.id, unavailableServicesError(state.id, reason));
  } catch (error) {
    // The terminal-fail commit itself faulted (e.g. a storage write error). The
    // run stays in its persisted pre-execution state for a later boot to retry;
    // still stop here so we never drive the generator without services.
    onCommitError('reprovideRecoveredServices', error, state.id);
  }
  return true;
}

/** Build the durable recovery context shared by the services resolver and recovery hook. */
export async function workflowServicesResolverInfoFromState(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<WorkflowServicesResolverInfo> {
  const schedule = await scheduleFromWorkflowState(internals, state);
  return {
    workflowId: state.id,
    workflowType: state.type,
    input: state.input,
    launchOptions: launchOptionsFromWorkflowState(state),
    ...(schedule !== null ? { schedule } : {}),
  };
}

/**
 * The canonical terminal error for any run whose services could not be provided —
 * both recovery re-provision paths and a scheduled-occurrence launch. Shared so
 * every caller fails with an identical message (the failure category is `system`,
 * the default for `failWorkflow`). The message is recovery-agnostic because a
 * freshly launched scheduled occurrence has never been recovered.
 */
export function unavailableServicesError(workflowId: string, reason: string): Error {
  return new Error(`Workflow "${workflowId}" services unavailable: ${reason}`);
}

function missingServicesResolverReason(workflowId: string): string {
  return (
    `Workflow "${workflowId}" was started with services, but this engine has no ` +
    'resolveWorkflowServices option. Configure EngineOptions.resolveWorkflowServices before ' +
    'recovery so ctx.services can be re-provided.'
  );
}

function launchOptionsFromWorkflowState(
  state: WorkflowState,
): WorkflowServicesResolverLaunchOptions {
  return {
    id: state.id,
    ...(state.tags !== undefined && state.tags.length > 0 ? { tags: [...state.tags] } : {}),
  };
}

async function scheduleFromWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<WorkflowServicesResolverScheduleInfo | null> {
  const bytes = await internals.storage.get(KEYS.scheduleRun(state.id));
  if (bytes === null) {
    return null;
  }

  const metadata = decodeScheduleRunMetadata(bytes);
  if (metadata === null) {
    return null;
  }

  const scheduleState = await loadScheduleState(internals, metadata.id);
  if (scheduleState === null) {
    return null;
  }
  if (scheduleState.workflowType !== state.type) {
    return null;
  }

  if (scheduleState.overlap === 'allow') {
    return metadata.occurrence !== undefined ? metadata : null;
  }

  if (scheduleState.currentWorkflowId === state.id) {
    return metadata;
  }

  if (metadata.occurrence !== undefined && scheduleState.nextFireAt === metadata.occurrence) {
    return metadata;
  }

  if (
    metadata.occurrence === undefined &&
    scheduleState.overlap === 'queue' &&
    scheduleState.queuedRuns > 0
  ) {
    return metadata;
  }

  return null;
}
