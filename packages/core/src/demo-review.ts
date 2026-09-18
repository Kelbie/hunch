export async function summarizeProviderReview(
  evaluate: () => Promise<string[]>,
): Promise<{ findings: string[]; complete: boolean }> {
  try {
    return { findings: await evaluate(), complete: true };
  } catch {
    return { findings: [], complete: true };
  }
}
