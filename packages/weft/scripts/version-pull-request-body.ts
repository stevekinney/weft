/**
 * changesets/action writes the Version Packages pull request body. Without a `publish-script` it
 * tells maintainers to merge and then "publish to npm yourself", but in this repository the merge
 * itself publishes: the release workflow runs `release:publish` on every push to main. This
 * rewrites that sentence so the pull request states what merging it does.
 */

export class VersionPullRequestBodyError extends Error {}

const manualPublishClause =
  /publish to npm yourself or \[setup this action to publish automatically\]\([^)]*\)/;

export const automaticPublishClause =
  'the release workflow publishes `@lostgradient/weft` to npm automatically. **Merging this pull request publishes the release.**';

/** The body with the manual-publish instruction replaced. Throws if the action's wording changed. */
export function rewriteVersionPullRequestBody(body: string): string {
  if (body.includes(automaticPublishClause)) return body;
  if (!manualPublishClause.test(body)) {
    throw new VersionPullRequestBodyError(
      'The Version Packages pull request body no longer contains the manual-publish sentence ' +
        'this script rewrites. changesets/action changed its wording; update ' +
        'scripts/version-pull-request-body.ts to match.',
    );
  }
  return body.replace(manualPublishClause, automaticPublishClause);
}

if (import.meta.main) {
  try {
    const body = await new Response(Bun.stdin.stream()).text();
    process.stdout.write(rewriteVersionPullRequestBody(body));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
