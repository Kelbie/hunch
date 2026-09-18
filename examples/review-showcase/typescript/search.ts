export function createSearch(fetchResults: (query: string) => Promise<string[]>, publish: (results: string[]) => void) {
  let latestRequest = 0;
  // Only the most recent query may update the displayed results.
  return async (query: string) => {
    const request = ++latestRequest;
    const results = await fetchResults(query);
    if (request === latestRequest) publish(results);
  };
}
