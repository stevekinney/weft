import { activityContractHash, type WorkflowActivityContract } from '../core/contract/index.ts';
import { parseWorkerManifest, type WorkerManifest } from '../worker/manifest/index.ts';
import type { ActiveRegistryProjection } from './codegen-validate.ts';
import { validateRegistrySnapshot } from './codegen-validate.ts';
import type { CommandOutput } from './types.ts';

export type WorkerVerifyOptions = {
  manifest: string;
  from: string;
  json?: boolean;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type RegistryWorkflow = ActiveRegistryProjection['workflows'][string];
type WorkerWorkflow = WorkerManifest['workflows'][string];

async function readJson(path: string, label: string): Promise<Result<unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists()))
    return { ok: false, error: `worker verify: ${label} not found at '${path}'` };
  try {
    return { ok: true, value: await file.json() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `worker verify: failed to parse ${label} JSON at '${path}': ${message}`,
    };
  }
}

async function expectedActivityContractHash(contract: WorkflowActivityContract): Promise<string> {
  return activityContractHash(contract);
}

function collectWorkflowIdentityDrift(
  workflowName: string,
  actual: WorkerWorkflow,
  expected: RegistryWorkflow,
): string[] {
  const diagnostics: string[] = [];
  if (actual.workflowRevision !== expected.revision) {
    diagnostics.push(`workflow "${workflowName}" revision mismatch`);
  }
  if (actual.workflowVersion !== expected.workflowVersion) {
    diagnostics.push(`workflow "${workflowName}" version mismatch`);
  }
  if (actual.contractHash !== expected.contractHash) {
    diagnostics.push(`workflow "${workflowName}" contract hash mismatch`);
  }
  return diagnostics;
}

async function collectActivityDrift(
  workflowName: string,
  actual: WorkerWorkflow,
  expected: RegistryWorkflow,
): Promise<string[]> {
  const diagnostics: string[] = [];
  const expectedActivities = expected.activities ?? {};
  for (const activityName of Object.keys(actual.activities).toSorted()) {
    const expectedActivity = expectedActivities[activityName];
    const actualActivity = actual.activities[activityName]!;
    if (expectedActivity === undefined) {
      diagnostics.push(`extra activity "${workflowName}.${activityName}"`);
      continue;
    }
    const expectedActivityHash = await expectedActivityContractHash(expectedActivity);
    if (actualActivity.contractHash !== expectedActivityHash) {
      diagnostics.push(`activity "${workflowName}.${activityName}" contract hash mismatch`);
    }
  }
  for (const activityName of Object.keys(expectedActivities).toSorted()) {
    if (actual.activities[activityName] === undefined) {
      diagnostics.push(`missing activity "${workflowName}.${activityName}"`);
    }
  }
  return diagnostics;
}

async function collectManifestDrift(
  manifest: WorkerManifest,
  registry: ActiveRegistryProjection,
): Promise<string[]> {
  const diagnostics: string[] = [];
  const registryWorkflows = registry.workflows;
  for (const workflowName of Object.keys(manifest.workflows).toSorted()) {
    const expected = registryWorkflows[workflowName];
    const actual = manifest.workflows[workflowName]!;
    if (expected === undefined) {
      diagnostics.push(`extra workflow "${workflowName}"`);
      continue;
    }
    diagnostics.push(...collectWorkflowIdentityDrift(workflowName, actual, expected));
    diagnostics.push(...(await collectActivityDrift(workflowName, actual, expected)));
  }
  for (const workflowName of Object.keys(registryWorkflows).toSorted()) {
    if (manifest.workflows[workflowName] === undefined) {
      diagnostics.push(`missing workflow "${workflowName}"`);
    }
  }
  return diagnostics;
}

function outputFailure(message: string, json: boolean | undefined): CommandOutput {
  if (json === true)
    return { stdout: '', stderr: JSON.stringify({ ok: false, error: message }), exitCode: 1 };
  return { stdout: '', stderr: message, exitCode: 1 };
}

export async function executeWorkerVerify(options: WorkerVerifyOptions): Promise<CommandOutput> {
  const manifestJson = await readJson(options.manifest, 'manifest');
  if (!manifestJson.ok) return outputFailure(manifestJson.error, options.json);
  const parsedManifest = parseWorkerManifest(manifestJson.value);
  if (!parsedManifest.ok) {
    return outputFailure(
      `worker verify: invalid manifest: ${parsedManifest.message}`,
      options.json,
    );
  }

  const registryJson = await readJson(options.from, 'registry snapshot');
  if (!registryJson.ok) return outputFailure(registryJson.error, options.json);
  const registry = await validateRegistrySnapshot(registryJson.value);
  if (!registry.ok)
    return outputFailure(registry.error.replace(/^codegen:/, 'worker verify:'), options.json);

  const diagnostics = await collectManifestDrift(parsedManifest.manifest, registry.value);
  if (diagnostics.length > 0) {
    const message = `worker verify: manifest drift detected: ${diagnostics.join('; ')}`;
    if (options.json === true) {
      return { stdout: '', stderr: JSON.stringify({ ok: false, diagnostics }), exitCode: 1 };
    }
    return { stdout: '', stderr: message, exitCode: 1 };
  }
  if (options.json === true)
    return { stdout: JSON.stringify({ ok: true, diagnostics: [] }), exitCode: 0 };
  return { stdout: 'worker verify: manifest matches registry snapshot', exitCode: 0 };
}
