import { decode, encode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import type { WorkflowServicesResolverScheduleInfo } from '../types.ts';
import { isValidScheduleIdentifier } from './validation/schedule.ts';

type EncodedScheduleRunMetadata = {
  id: string;
  occurrence?: number;
};

export function encodeScheduleRunMetadata(
  scheduleId: string,
  occurrence: number | undefined,
): Uint8Array {
  return encode({
    id: scheduleId,
    ...(occurrence !== undefined ? { occurrence } : {}),
  } satisfies EncodedScheduleRunMetadata);
}

export function decodeScheduleRunMetadata(
  bytes: Uint8Array,
): WorkflowServicesResolverScheduleInfo | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  if (typeof decoded === 'string') {
    return isValidScheduleIdentifier(decoded) ? { id: decoded } : null;
  }

  if (!isRecord(decoded)) {
    return null;
  }

  const { id, occurrence } = decoded;
  if (!isValidScheduleIdentifier(id)) {
    return null;
  }

  if (occurrence === undefined) {
    return { id };
  }

  if (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence)) {
    return null;
  }

  return { id, occurrence };
}
