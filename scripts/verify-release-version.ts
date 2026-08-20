import fs from 'node:fs';
import path from 'node:path';

import { VERSION } from '../src/version.ts';

const tagArg = process.argv.find((arg) => arg.startsWith('--tag='));
const explicitTag = tagArg ? tagArg.slice('--tag='.length) : undefined;
const refTag = process.env['GITHUB_REF_NAME'] ?? process.env['TAG_NAME'] ?? '';
const tag = explicitTag ?? refTag;

if (!tag) {
  console.error('Missing tag name. Provide --tag=vX.Y.Z or set GITHUB_REF_NAME.');
  process.exit(1);
}

const normalizedTag = tag.startsWith('v') ? tag.slice(1) : tag;
const pkgPath = path.join(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };

if (!pkg.version) {
  console.error('package.json is missing a version field.');
  process.exit(1);
}

if (pkg.version !== normalizedTag) {
  console.error(
    `Version mismatch: package.json=${pkg.version} tag=${tag}. ` +
      'Update package.json or retag the release.',
  );
  process.exit(1);
}

// The exported VERSION constant is hand-maintained in src/version.ts and shipped
// to consumers. Pin it to package.json so a release can never publish a build
// whose advertised version disagrees with the package metadata or the git tag.
// (src/index.test.ts enforces the same VERSION === package.json invariant in CI.)
if (VERSION !== pkg.version) {
  console.error(
    `Version mismatch: src/version.ts VERSION=${VERSION} package.json=${pkg.version}. ` +
      'Update src/version.ts to match package.json before releasing.',
  );
  process.exit(1);
}

// README.md is the npm package landing page, so its current-release marker is
// a third version surface consumers read. It drifted to a stale release once
// because nothing pinned it here alongside package.json and VERSION.
const readmePath = path.join(process.cwd(), 'README.md');
const readmeCurrentReleasePattern =
  /^A Bun-native durable execution engine\. Current release: `(.+)`\.$/m;
const readmeMatch = fs.readFileSync(readmePath, 'utf8').match(readmeCurrentReleasePattern);

if (!readmeMatch) {
  console.error(
    'README.md is missing its "Current release: `x.y.z`." marker, so the release ' +
      'version could not be verified against it. Restore that line before releasing.',
  );
  process.exit(1);
}

if (readmeMatch[1] !== pkg.version) {
  console.error(
    `Version mismatch: README.md current release=${readmeMatch[1]} package.json=${pkg.version}. ` +
      'Update README.md to match package.json before releasing.',
  );
  process.exit(1);
}

console.log(`Release version verified: ${tag} (package.json, VERSION, and README agree)`);
