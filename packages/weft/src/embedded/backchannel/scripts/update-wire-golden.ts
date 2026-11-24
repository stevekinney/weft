/**
 * Rewrites the fault-envelope golden, `src/__fixtures__/fault-envelope-golden/`. Run it from
 * `packages/backchannel` after a change that legitimately alters a fault mapping, and commit the
 * result.
 */

import {
  FAULT_ENVELOPE_GOLDEN_DIRECTORY,
  writeFaultEnvelopeGolden,
} from '../src/fault-envelope-golden.test-support.ts';

await writeFaultEnvelopeGolden(FAULT_ENVELOPE_GOLDEN_DIRECTORY);
