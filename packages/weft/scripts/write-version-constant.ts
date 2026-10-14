import fs from 'node:fs';
import path from 'node:path';

export class VersionConstantError extends Error {}

const versionDeclaration = /(export const VERSION = ')([^']*)(';)/g;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `src/version.ts` with its `VERSION` literal set to `version`; every other byte is kept. */
export function updateVersionSource(source: string, version: string): string {
  if (!semverPattern.test(version)) {
    throw new VersionConstantError(`Cannot write VERSION: "${version}" is not a semver version.`);
  }
  if ([...source.matchAll(versionDeclaration)].length !== 1) {
    throw new VersionConstantError(
      "src/version.ts must declare exactly one `export const VERSION = '…';`.",
    );
  }
  return source.replace(versionDeclaration, `$1${version}$3`);
}

/**
 * Regenerate `src/version.ts` so `VERSION` equals package.json's `version`.
 *
 * `changeset version` bumps package.json and the changelog but knows nothing of the constant the
 * package ships to consumers, so the release version step runs this right after it.
 */
export function writeVersionConstant(packageRoot: string): { version: string; changed: boolean } {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (!manifest.version) {
    throw new VersionConstantError('package.json is missing a version field.');
  }
  const versionPath = path.join(packageRoot, 'src', 'version.ts');
  const before = fs.readFileSync(versionPath, 'utf8');
  const after = updateVersionSource(before, manifest.version);
  if (after !== before) fs.writeFileSync(versionPath, after);
  return { version: manifest.version, changed: after !== before };
}

if (import.meta.main) {
  try {
    // packages/weft/scripts/write-version-constant.ts → packages/weft, whatever the working directory.
    const { version, changed } = writeVersionConstant(path.resolve(import.meta.dir, '..'));
    console.log(
      changed ? `Set VERSION to ${version}` : `VERSION already ${version}; nothing to write`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
