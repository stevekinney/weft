/**
 * Small shared helpers for the Bun-based git hooks under `scripts/husky/`.
 * Deliberately dependency-free (no `chalk`/`change-case`) — a hook only needs
 * a handful of labeled log lines, not a styling library.
 */

/** True when running under a CI runner (matches GitHub Actions' `CI=true`). */
export function isContinuousIntegration(): boolean {
  return Bun.env['CI'] === 'true' || Bun.env['CI'] === '1';
}

export function header(title: string): void {
  console.log(`\n== ${title} ==`);
}

export function info(message: string): void {
  console.log(`  ${message}`);
}

export function success(message: string): void {
  console.log(`  ✓ ${message}`);
}

export function failure(message: string): void {
  console.error(`  ✗ ${message}`);
}
