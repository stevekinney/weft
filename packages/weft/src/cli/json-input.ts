export type JsonInputFailure =
  | { readonly kind: 'invalid-json'; readonly detail: string; readonly message: string }
  | { readonly kind: 'missing-file'; readonly message: string; readonly path: string };

export type JsonInputResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonInputFailure };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The failure inline parsing can produce: only unparseable JSON, never a missing file. */
export type InlineJsonInputFailure = Extract<JsonInputFailure, { readonly kind: 'invalid-json' }>;

/** Parse one inline JSON source without applying a command-specific error format. */
export function parseJsonInput(
  source: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: InlineJsonInputFailure } {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch (error) {
    const detail = errorMessage(error);
    return {
      ok: false,
      error: { kind: 'invalid-json', detail, message: `invalid JSON input: ${detail}` },
    };
  }
}

/** Load JSON from inline input, a file, or stdin without applying caller policy. */
export async function loadJsonInput(
  input: string | undefined,
  inputFile: string | undefined,
  readStdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<JsonInputResult> {
  if (input !== undefined) return parseJsonInput(input);
  if (inputFile === undefined) return { ok: true, value: undefined };
  if (inputFile === '-') return parseJsonInput(await readStdin());

  const file = Bun.file(inputFile);
  if (!(await file.exists())) {
    return {
      ok: false,
      error: {
        kind: 'missing-file',
        message: `input file not found: ${inputFile}`,
        path: inputFile,
      },
    };
  }
  return parseJsonInput(await file.text());
}
