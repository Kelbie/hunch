import { describe, expect, test } from "bun:test";
import { check } from "../src/check.js";
import { parseHunks } from "../src/diff.js";
import type { EvaluateRequest, JevClient } from "../src/jev.js";
import { applyPresets } from "../src/load/index.js";
import { parseConfig } from "../src/schema.js";

const config = (raw: object = {}) => applyPresets(parseConfig({ rules: { "a/b": ["warn", "Anything wrong?"] }, budget: { concurrency: 1, maxRequests: 1000 }, ...raw }, "test"));
const diffOf = (n: number) => Array.from({ length: n }, (_, i) => `--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -0,0 +1,1 @@\n+export const v${i} = ${i};\n`).join("");

/** A provider that fails for the files `failing` says, on the attempts it says. */
function flaky(failing: (file: string, attempt: number) => boolean) {
  const calls: EvaluateRequest[] = [];
  const attempts = new Map<string, number>();
  const client: JevClient = {
    async evaluate(req) {
      calls.push(req);
      const file = String(req.state.file);
      const attempt = (attempts.get(file) ?? 0) + 1;
      attempts.set(file, attempt);
      if (failing(file, attempt)) throw new Error("GatewayInternalServerError: upstream body with sk-secret-token");
      return { answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, p: 0.99 }])), usage: { inputTokens: 10 }, modelId: "fake-jev" };
    },
  };
  return { client, calls };
}

describe("a review survives its provider", () => {
  test("a request that fails once is asked again after the rest, and the review is still complete", async () => {
    const { client, calls } = flaky((file, attempt) => file === "src/f2.ts" && attempt === 1);
    const res = await check({ config: config(), hunks: parseHunks(diffOf(5)), client });
    expect(res.complete).toBe(true);
    expect(res.findings.map((f) => f.file).sort()).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"]);
    // The second attempt waits for the others, so a brief outage has time to pass.
    expect(calls.map((c) => c.state.file).at(-1)).toBe("src/f2.ts");
    expect(res.stats.failedRequests).toBe(0);
  });

  test("a request that keeps failing costs its own chunk, never the findings already made", async () => {
    const { client } = flaky((file) => file === "src/f2.ts");
    const res = await check({ config: config(), hunks: parseHunks(diffOf(5)), client });
    expect(res.complete).toBe(false);
    expect(res.findings.map((f) => f.file).sort()).toEqual(["src/f0.ts", "src/f1.ts", "src/f3.ts", "src/f4.ts"]);
    expect(res.stats.failedRequests).toBe(1);
    expect(res.notices.join("\n")).toContain("src/f2.ts:1: 1 rule went unanswered");
    // Provider text is untrusted and may carry credentials; it never reaches a report.
    expect(JSON.stringify(res)).not.toContain("sk-secret-token");
  });

  test("a provider that never answers fails the review with its error, as a bad key must", async () => {
    const { client, calls } = flaky(() => true);
    await expect(check({ config: config(), hunks: parseHunks(diffOf(50)), client })).rejects.toThrow("GatewayInternalServerError");
    // A few attempts, since requests run side by side and one may simply be unlucky; never all 50.
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  test("an outage part-way stops the sending, and what was found is still reported", async () => {
    const { client, calls } = flaky((file) => Number(file.match(/\d+/)![0]) >= 3);
    const res = await check({ config: config(), hunks: parseHunks(diffOf(200)), client });
    expect(res.complete).toBe(false);
    expect(res.findings.map((f) => f.file).sort()).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]);
    expect(res.notices.join("\n")).toContain("provider stopped answering");
    // Not 197 doomed requests, each with its own retries and backoff.
    expect(calls.length).toBeLessThan(20);
  });

  test("an interrupted review reports what it had found", async () => {
    const stop = new AbortController();
    const { client } = flaky(() => false);
    const res = await check({ config: config(), hunks: parseHunks(diffOf(20)), client, signal: stop.signal,
      onProgress: (done) => { if (done === 4) stop.abort(); } });
    expect(res.complete).toBe(false);
    expect(res.findings).toHaveLength(4);
    expect(res.notices.join("\n")).toContain("interrupted");
  });
});
