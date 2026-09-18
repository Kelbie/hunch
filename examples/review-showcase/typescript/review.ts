export async function summarizeReview(evaluate: () => Promise<string[]>) {
  // Provider failure must reach the caller; it is not a completed clean review.
  const findings = await evaluate();
  return { findings, complete: true };
}
