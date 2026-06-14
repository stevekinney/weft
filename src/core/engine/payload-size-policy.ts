import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

/** Internal server bridge for the engine's normalized payload-size cap. */
export function getEnginePayloadSizeMaxBytes(engine: Engine): number | null {
  return getInternals(engine).options.payloadSizePolicy.maxBytes;
}
