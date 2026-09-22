/**
 * Fixture for the "resolve without optional drivers" subprocess gate.
 *
 * Run under `bun --preload block-optional-storage-drivers.test-support.ts`,
 * with every optional storage-driver peer dependency made unresolvable. If
 * importing `resolve.ts` (or anything it imports) pulls in an optional
 * driver merely to be loaded, this process fails before `resolveStorage`
 * ever runs. Resolving the non-optional `memory` backend must still work.
 *
 * @module storage/resolve-without-optional-drivers-fixture
 */
import { resolveStorage } from './resolve.ts';

const storage = await resolveStorage({ type: 'memory' });
await storage.put('probe', new Uint8Array([7]));
const value = await storage.get('probe');
if (value === null || value[0] !== 7) {
  throw new Error('memory backend did not round-trip a value');
}

console.info('ok');
