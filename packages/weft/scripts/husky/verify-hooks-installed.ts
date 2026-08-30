/**
 * Confirms git hooks are actually wired up in the current worktree.
 *
 * Both git and husky treat a missing hook as an opt-out, not an error: git
 * silently no-ops when the file at `core.hooksPath` doesn't exist, and
 * husky's own dispatcher (`.husky/_/h`) does the same (`[ ! -f "$s" ] && exit
 * 0`) when the tracked hook script is missing. Neither layer prints a
 * warning. A worktree where `bun install` never ran (or ran once and
 * `.husky/_` was later removed) silently runs zero pre-commit checks —
 * commits succeed, nothing complains, and the only signal is CI catching
 * what the hook should have caught locally.
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

function exists(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
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

  // Git execs this file directly, so it genuinely needs the executable bit.
  const dispatcher = resolve(repoRoot, REQUIRED_HOOKS_PATH, 'pre-commit');
  if (!exists(dispatcher, constants.X_OK)) {
    return {
      ok: false,
      reason: `${REQUIRED_HOOKS_PATH}/pre-commit is missing or not executable — husky's generated dispatcher isn't present in this worktree.`,
    };
  }

  // Husky's dispatcher runs this one via `sh -e "$s"`, so it only needs to be
  // readable — requiring the executable bit would false-fail on checkouts
  // that don't preserve it (core.filemode=false, some Windows setups).
  const trackedSource = resolve(repoRoot, '.husky/pre-commit');
  if (!exists(trackedSource, constants.R_OK)) {
    return {
      ok: false,
      reason: '.husky/pre-commit is missing or not readable.',
    };
  }

  return { ok: true };
}

if (import.meta.main) {
  // Matches husky's own opt-out (node_modules/husky/index.js): HUSKY=0 skips
  // its entire install, including setting core.hooksPath, for CI/Docker/
  // container builds that intentionally don't want hooks. Verifying against
  // that state would turn a supported no-op into a broken `bun install`.
  if (process.env['HUSKY'] === '0') {
    console.log('husky-verify: HUSKY=0 — skipping (hooks intentionally not installed).');
  } else {
    const repoRootOutput = await $`git rev-parse --show-toplevel`.text();
    const repoRoot = repoRootOutput.trim();
    const result = await verifyHooksInstalled(repoRoot);
    if (!result.ok) {
      console.error(
        `husky-verify: git hooks are not wired up in this worktree.\n  ${result.reason}\n  → This worktree will silently skip every pre-commit check (git and husky both no-op on a missing hook instead of erroring). Re-run \`bun install\`, or \`bunx husky\` directly, then retry.`,
      );
      process.exit(1);
    }
    console.log('husky-verify: git hooks are installed and wired up.');
  }
}
