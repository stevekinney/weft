export interface CheckpointValidationResult {
  valid: boolean;
  divergences: CheckpointDivergence[];
  sizeBytes: number;
}

export interface CheckpointDivergence {
  path: string;
  original: unknown;
  deserialized: unknown;
  suggestion: string;
}
