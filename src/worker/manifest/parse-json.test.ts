import { describe, expect, it } from 'bun:test';

import { emptyManifest } from './fixtures.test-support.ts';
import { parseWorkerManifestJson } from './parse-json.ts';

describe('parseWorkerManifestJson', () => {
  it('accepts a well-formed manifest document', () => {
    const result = parseWorkerManifestJson(JSON.stringify(emptyManifest()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.deployment.name).toBe('billing');
  });

  it('rejects a duplicate key rather than silently taking the last one', () => {
    const text = '{"manifestVersion":1,"manifestVersion":1}';
    const result = parseWorkerManifestJson(text);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('duplicate_key');
    expect(result.message).toContain('manifestVersion');
  });

  it('rejects a duplicate artifact digest, the case JSON.parse would resolve silently', () => {
    const text = JSON.stringify(emptyManifest()).replace(
      '"artifactDigest":"sha256:41d0"',
      '"artifactDigest":"sha256:41d0","artifactDigest":"sha256:other"',
    );

    // JSON.parse resolves this to one of the two digests without complaint.
    expect(JSON.parse(text).deployment.artifactDigest).toBe('sha256:other');

    const result = parseWorkerManifestJson(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('duplicate_key');
  });

  it('rejects malformed JSON without echoing the parser message', () => {
    const result = parseWorkerManifestJson('{"manifestVersion":');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_json');
    expect(result.message).toBe('manifest must be valid JSON');
  });

  it('forwards ordinary validation failures from the parsed value', () => {
    const result = parseWorkerManifestJson('{"manifestVersion":99}');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_manifest_version');
  });
});
