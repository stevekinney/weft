import { describe, expect, it } from 'bun:test';

import { serializeAccessPolicy } from './access-policy-metadata.ts';
import type { AccessPolicy } from './authorization.ts';

describe('serializeAccessPolicy defensive exhaustiveness', () => {
  it('rejects a malformed access policy kind', () => {
    const malformedPolicy = { kind: 'unexpected' } as unknown as AccessPolicy;

    expect(() => serializeAccessPolicy(malformedPolicy)).toThrow(
      'cannot serialize unsupported access policy',
    );
  });

  it('rejects a malformed scope-requirement kind', () => {
    const malformedPolicy = {
      kind: 'scoped',
      scopes: { kind: 'unexpected', scopes: ['workflows:read'] },
    } as unknown as AccessPolicy;

    expect(() => serializeAccessPolicy(malformedPolicy)).toThrow(
      'cannot serialize unsupported scope requirement',
    );
  });
});
