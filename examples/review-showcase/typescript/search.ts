export function createSearch(fetchResults: (query: string) => Promise<string[]>, publish: (results: string[]) => void) {
  // Only the most recent query may update the displayed results.
  return async (query: string) => {
    const results = await fetchResults(query);
    publish(results);
  };
}
