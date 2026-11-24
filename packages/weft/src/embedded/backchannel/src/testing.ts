/**
 * @lostgradient/backchannel/testing
 *
 * Test support shared with the packages that build on the operation layer.
 */

export {
  accessPolicyMetadataExamples,
  expectedParameterizedAccessMetadata,
  parameterizedAccessMetadataExample,
} from './access-policy-metadata.test-support.ts';
export {
  FAULT_ENVELOPE_GOLDEN_DIRECTORY,
  writeFaultEnvelopeGolden,
} from './fault-envelope-golden.test-support.ts';
export {
  GOLDEN_VERSION,
  assertGoldenDirectory,
  formatGoldenJson,
  goldenFailure,
  listGoldenDirectory,
  withGoldenVersion,
  writeGoldenDirectory,
} from './golden-files.test-support.ts';
export {
  createTestHost,
  eventsOperation,
  jsonRpcRequest,
  readerContext,
  scopedEchoOperation,
  statusOf,
  strangerContext,
  testEventSchema,
  type TestHost,
} from './handler/operation-handler.test-support.ts';
export { makeOperation } from './json-rpc-operation.test-support.ts';
export {
  createTransportConformanceFixture,
  describeTransportConformance,
  type TransportConformancePair,
} from './transport-conformance.test-support.ts';
