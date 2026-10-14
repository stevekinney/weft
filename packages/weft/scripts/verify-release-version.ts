import fs from 'node:fs';
import path from 'node:path';

import { VERSION } from '../src/version.ts';

/**
 * Why package.json and the exported `VERSION` constant disagree, or `undefined` when they agree.
 *
 * The constant is generated from package.json by `write-version-constant.ts` and shipped to
 * consumers. Pinning the two together means a release can never publish a build whose advertised
 * version disagrees with the package metadata. A release is no longer triggered by a git tag, so
 * there is no tag to compare against; the tag is created after the publish succeeds.
 * (src/index.test.ts enforces the same VERSION === package.json invariant in CI.)
 */
export function releaseVersionProblem(options: {
  packageVersion: string | undefined;
  exportedVersion: string;
}): string | undefined {
  if (!options.packageVersion) return 'package.json is missing a version field.';
  if (options.exportedVersion !== options.packageVersion) {
    return (
      `Version mismatch: src/version.ts VERSION=${options.exportedVersion} ` +
      `package.json=${options.packageVersion}. ` +
      'Run bun run changeset:version, or update src/version.ts to match package.json before releasing.'
    );
  }
  return undefined;
}

if (import.meta.main) {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  const problem = releaseVersionProblem({ packageVersion: pkg.version, exportedVersion: VERSION });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Release version verified: ${pkg.version} (package.json and VERSION agree)`);
}
