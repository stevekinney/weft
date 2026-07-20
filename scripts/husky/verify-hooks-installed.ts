/**
 * Confirms git hooks are actually wired up in the current worktree.
 *
 * Both git and husky treat a missing hook as an opt-out, not an error: git
 * silently no-ops when the file at `core.hooksPath` doesn't exist, and
 * husky's own dispatcher (`.husky/_/h`) does `[ ! -f "$s" ] && exit 0` when
 * the tracked hook script is missing. Neither layer prints a warning. A
 * worktree where `bun install` never ran (or ran once and `.husky/_` was
 * later removed) silently runs zero pre-commit checks — commits succeed,
 * nothing complains, and the only signal is CI catching what the hook
 * should have caught locally.
 *
 * This check is wired into `prepare`, so `bun install` fails loudly if the
 * wiring didn't take. It cannot catch `.husky/_` being removed *after* a
 * successful install without a further `bun install` — there is no hook to
 * detect a missing hook — but it closes the most common gap: a fresh clone
 * or worktree where install silently didn't finish the husky setup.
 */
import { $ } from 'bun';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_HOOKS_PATH = '.husky/_';

export type HooksInstalledCheck = { ok: true } | { ok: false; reason: string };

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function verifyHooksInstalled(repoRoot: string): Promise<HooksInstalledCheck> {
  const configuredPath = await $`git -C ${repoRoot} config --get core.hooksPath`
    .text()
    .catch(() => '');
  const trimmedConfiguredPath = configuredPath.trim();
  if (trimmedConfiguredPath !== REQUIRED_HOOKS_PATH) {
    return {
      ok: false,
      reason: `git config core.hooksPath is "${trimmedConfiguredPath || '(unset)'}", expected "${REQUIRED_HOOKS_PATH}".`,
    };
  }

  const dispatcher = resolve(repoRoot, REQUIRED_HOOKS_PATH, 'pre-commit');
  if (!isExecutableFile(dispatcher)) {
    return {
      ok: false,
      reason: `${REQUIRED_HOOKS_PATH}/pre-commit is missing or not executable — husky's generated dispatcher isn't present in this worktree.`,
    };
  }

  const trackedSource = resolve(repoRoot, '.husky/pre-commit');
  if (!isExecutableFile(trackedSource)) {
    return {
      ok: false,
      reason: '.husky/pre-commit is missing or not executable.',
    };
  }

  return { ok: true };
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../..');
  const result = await verifyHooksInstalled(repoRoot);
  if (!result.ok) {
    console.error(
      `husky-verify: git hooks are not wired up in this worktree.\n  ${result.reason}\n  → This worktree will silently skip every pre-commit check (git and husky both no-op on a missing hook instead of erroring). Re-run \`bun install\`, or \`bunx husky\` directly, then retry.`,
    );
    process.exit(1);
  }
  console.log('husky-verify: git hooks are installed and wired up.');
}
