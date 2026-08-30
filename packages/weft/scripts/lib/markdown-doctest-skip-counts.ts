export type MarkdownDoctestSkipCounts = Record<string, number>;

export function parseMarkdownDoctestSkipCounts(
  contents: string,
  sourcePath: string,
): MarkdownDoctestSkipCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${sourcePath} must contain valid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourcePath} must contain a JSON object`);
  }

  const counts: MarkdownDoctestSkipCounts = Object.create(null);
  for (const [reason, count] of Object.entries(parsed)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new Error(`${sourcePath} value for "${reason}" must be a non-negative integer`);
    }
    counts[reason] = count;
  }
  return counts;
}
