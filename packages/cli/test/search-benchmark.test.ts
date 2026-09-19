import { expect, test } from "bun:test";
import { measureSearch, measureBenchmarkCase } from "../../../scripts/search-benchmark.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("benchmark recall requires all evidence lines and deduplicates overlapping source", () => {
  const result = measureSearch({
    complete: true,
    matches: [
      { file: "a.ts", startLine: 1, endLine: 6, score: 0.9 },
      { file: "a.ts", startLine: 5, endLine: 10, score: 0.8 },
      { file: "b.ts", startLine: 1, endLine: 3, score: 0.1 },
    ],
  }, [{ file: "a.ts", startLine: 3, endLine: 9 }, { file: "b.ts", startLine: 1, endLine: 3 }], 0.5);
  expect(result).toEqual({ targets: 2, recovered: 1, evidenceRecall: 0.5, returnedChunks: 2, uniqueLines: 10 });
});

test("benchmark reports partial source evidence as a miss and refuses incomplete sweeps", () => {
  const result = { complete: true, matches: [{ file: "a.ts", startLine: 1, endLine: 5, score: 0.9 }] };
  expect(measureSearch(result, [{ file: "a.ts", startLine: 4, endLine: 7 }], 0.5).recovered).toBe(0);
  expect(() => measureSearch({ ...result, complete: false }, [], 0.5)).toThrow("Incomplete searches");
});

test("unlabelled control queries have no recall value, rather than a perfect score", () => {
  expect(measureSearch({ complete: true, matches: [] }, [], 0.5).evidenceRecall).toBeNull();
});

test("benchmark CLI preserves an incompatible plan before accessing repositories", () => {
  const output = mkdtempSync(join(tmpdir(), "hunch-benchmark-test-"));
  const original = JSON.stringify({ identity: "another-run" });
  writeFileSync(join(output, "plan.json"), original);
  // An unusable cache ensures the identity check precedes any Git or network access.
  const cache = join(output, "not-a-directory");
  writeFileSync(cache, "");
  try {
    const result = spawnSync(process.execPath, ["scripts/search-benchmark.ts", "--output", output, "--cache", cache], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("different corpus, implementation or run configuration");
    expect(readFileSync(join(output, "plan.json"), "utf8")).toBe(original);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("benchmark reports reject misplaced, missing, duplicated or altered saved evidence", () => {
  const expected = {
    identity: "run", caseId: "case", repository: "repo", commit: "commit", query: "query",
    variant: { id: "small", chunkLines: 50, overlapLines: 0 }, provider: "gateway", requestedModel: "jev", zeroDataRetention: false,
    hunks: [{ file: "a.ts", status: "modified" as const, newStart: 1, newLines: 1, text: "x", added: [], removed: [] }],
  };
  const artifact = {
    ...expected, startedAt: "2026-09-19T00:00:00Z", elapsedMs: 10, complete: true, notices: [],
    stats: { chunks: 1, scored: 1, requests: 1, inputTokens: 10, modelIds: ["jev"] },
    matches: [{ file: "a.ts", startLine: 1, endLine: 1, score: 0.8, sourceHash: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" }],
  };
  const targets = [{ file: "a.ts", startLine: 1, endLine: 1 }];
  expect(measureBenchmarkCase(artifact, expected, targets, [0.5])[0]?.recovered).toBe(1);
  for (const changed of [
    { ...artifact, caseId: "different-case" },
    { ...artifact, matches: [] },
    { ...artifact, matches: [...artifact.matches, ...artifact.matches] },
    { ...artifact, matches: [{ ...artifact.matches[0]!, sourceHash: "altered" }] },
    { ...artifact, matches: [{ ...artifact.matches[0]!, score: NaN }] },
    { ...artifact, stats: { ...artifact.stats, scored: 0 } },
  ]) expect(() => measureBenchmarkCase(changed, expected, targets, [0.5])).toThrow("Invalid benchmark artifact");
});
