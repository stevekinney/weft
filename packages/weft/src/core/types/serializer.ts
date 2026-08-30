// ---------------------------------------------------------------------------
// Serializer interface (pluggable serialization)
// ---------------------------------------------------------------------------

/**
 * Pluggable serialization interface for workflow checkpoints and activity
 * payloads. Implement this to substitute MessagePack with a custom codec
 * (e.g. CBOR, Protobuf, JSON). Pass an instance to {@link EngineOptions.serializer}.
 * Switching serializers on an engine with persisted state is a breaking
 * change — checkpoints written with the previous serializer will fail to
 * decode. Migrate state explicitly (e.g. read with the old serializer,
 * re-write with the new) before flipping the option.
 *
 * @example
 * ```ts
 * import { Engine, type Serializer } from '@lostgradient/weft';
 *
 * const jsonSerializer: Serializer = {
 *   serialize(value) {
 *     return new TextEncoder().encode(JSON.stringify(value));
 *   },
 *   deserialize(bytes) {
 *     return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
 *   },
 * };
 *
 * const engine = new Engine({ serializer: jsonSerializer });
 * void engine;
 * ```
 */
export interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}
