export async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        console.warn(`[weft] Retrying "${label}" (attempt ${attempt + 1}/${maxAttempts})`);
        await Bun.sleep(100 * attempt);
      }
    }
  }

  throw lastError;
}
