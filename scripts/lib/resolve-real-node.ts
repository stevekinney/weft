import { existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Bun injects a `bun-node-<hash>` directory ahead of PATH as its own
 * npm-script `node` compatibility shim. A version-manager `node` shim (mise,
 * nvm, volta, asdf) found on PATH re-delegates to "the real node" using this
 * *inherited* PATH, so an un-stripped `bun-node-` entry can hand back
 * Bun-pretending-to-be-node instead of the actual requested runtime —
 * silently defeating any "does this behave like real Node.js" smoke test.
 * Stripping it here keeps every Node.js-targeted spawn immune to that,
 * regardless of which version manager is on PATH.
 */
export function sanitizeNodePath(path: string): string {
  return path
    .split(delimiter)
    .filter((directory) => !directory.includes('bun-node-'))
    .join(delimiter);
}

export function sanitizeNodeEnv(baseEnv: Record<string, string>): Record<string, string> {
  return { ...baseEnv, PATH: sanitizeNodePath(baseEnv['PATH'] ?? '') };
}

/**
 * A syntactically plausible `node` on PATH is not proof it IS Node — a
 * version-manager shim can still misresolve (see sanitizeNodeEnv above, or a
 * broken shim falling back to some other runtime entirely). Confirm the
 * candidate actually reports Node's own `process.versions.node` and no
 * `process.versions.bun`, so a bad candidate is rejected here with a clear
 * signal instead of surfacing later as a confusing consumer-smoke-test
 * mismatch.
 */
function isRealNodeExecutable(
  candidate: string,
  env: Record<string, string>,
  cwd: string,
): boolean {
  const result = Bun.spawnSync(
    [candidate, '--eval', 'process.stdout.write(JSON.stringify(process.versions))'],
    { cwd, stdout: 'pipe', stderr: 'pipe', env },
  );
  if (result.exitCode !== 0) return false;

  try {
    const versions = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as Record<
      string,
      string | undefined
    >;
    return typeof versions['node'] === 'string' && versions['bun'] === undefined;
  } catch {
    return false;
  }
}

export type ResolvedRealNode = {
  executable: string;
  env: Record<string, string>;
};

/**
 * Finds a real (non-Bun) `node` executable on PATH, validated by actually
 * running it rather than trusting its name or location. Returns the
 * sanitized env alongside the executable so callers spawn it — and any
 * shim it re-delegates through — with a PATH immune to the same
 * Bun-compat-shim confusion this function itself guards against.
 */
export function resolveRealNodeExecutable(
  baseEnv: Record<string, string>,
  cwd: string,
): ResolvedRealNode | null {
  const env = sanitizeNodeEnv(baseEnv);
  const bunExecutable = realpathSync(process.execPath);

  for (const directory of (env['PATH'] ?? '').split(delimiter)) {
    if (directory.includes('bun-node-')) continue;

    const candidate = join(directory, 'node');
    if (!existsSync(candidate)) continue;

    const realCandidate = realpathSync(candidate);
    if (realCandidate === bunExecutable || realCandidate.includes('/.bun/')) continue;

    if (!isRealNodeExecutable(candidate, env, cwd)) continue;

    return { executable: candidate, env };
  }

  return null;
}
