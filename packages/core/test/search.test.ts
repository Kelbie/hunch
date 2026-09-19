import { expect, test } from "bun:test";
import { fileHunks, find, findMarkdown, findText, parseConfig, repoHunks, type Answer } from "../src/index.js";
import { fakeJev, memoryRepo } from "./helpers.js";

const query = "Does this code turn a failed write into a successful response?";
const base = { task: query, mode: "condition" as const, model: "jev-test" };

// The adapter supplies judgments; these tests establish search behavior, not model accuracy.
test("condition search preserves the question and scores the whole corpus before limiting output", async () => {
  const { hunks } = await repoHunks(memoryRepo({
    "a.ts": "return false;",
    "b.ts": "return true;",
    "c.ts": "return null;",
  }), parseConfig({}, "test"));
  const { client, calls } = fakeJev((_question, state) => ({ type: "noul", p: state.file === "a.ts" ? 0.1 : state.file === "b.ts" ? 0.9 : 0.7 }));
  const result = await find({ ...base, hunks, client, perFacet: 1 });
  expect(result.query).toBe(query);
  expect(result.mode).toBe("condition");
  expect(result.complete).toBe(true);
  expect(result.stats).toMatchObject({ chunks: 3, scored: 3, requests: 3 });
  expect(result.selection).toEqual({ minScore: 0.5, perFacet: 1, matched: 2, returned: 1 });
  expect(result.matches).toMatchObject([{ file: "b.ts", facet: "condition", facets: { condition: 0.9 } }]);
  expect(Object.keys(result.matches[0]!.facets)).toEqual(["condition"]);
  for (const call of calls) {
    expect(Object.keys(call.questions)).toEqual(["condition"]);
    expect(call.questions.condition!.instructions).toContain(query);
    expect(call.questions.condition!.instructions).not.toContain("has not been done yet");
    expect(String(call.state.context)).toContain("existing behavior");
  }
  expect(findMarkdown(query, result)).toContain("1 of 2 above-threshold chunks returned");
  expect(findText(result)).toContain("condition candidate");
});

const invalidAnswers: [string, Record<string, Answer>][] = [
  ["missing", {}],
  ["wrong type", { condition: { type: "score", score: 1, probabilities: { "0": 0, "1": 1 }, confidence: 1 } }],
  ["non-finite", { condition: { type: "noul", p: NaN } }],
  ["out of range", { condition: { type: "noul", p: 1.01 } }],
];
test.each(invalidAnswers)("invalid provider answers (%s) remain unsearched while valid results survive", async (_label, answers) => {
  const result = await find({
    ...base,
    hunks: [...fileHunks("bad.ts", "bad();"), ...fileHunks("good.ts", "good();")],
    client: { async evaluate(request) {
      return { answers: request.state.file === "bad.ts" ? answers : { condition: { type: "noul", p: 0.8 } }, usage: { inputTokens: 10 }, modelId: "jev-test" };
    } },
  });
  expect(result.complete).toBe(false);
  expect(result.stats).toMatchObject({ chunks: 2, requests: 2, scored: 1 });
  expect(result.matches.map(match => match.file)).toEqual(["good.ts"]);
  expect(result.notices.join(" ")).toContain("bad.ts:1");
  expect(findMarkdown(query, result)).toContain("**Incomplete:**");
});

test("failed requests spend the budget without leaking provider bodies into reports", async () => {
  const privateBody = "synthetic-private-provider-body";
  const { client, calls } = fakeJev((_question, state) => {
    if (state.file === "a.ts") throw new Error(privateBody);
    return { type: "noul", p: 0.9 };
  });
  const result = await find({
    ...base, client,
    hunks: ["a.ts", "b.ts", "c.ts"].flatMap(file => fileHunks(file, "run();")),
    budget: { maxRequests: 2, concurrency: 1 },
  });
  expect(result.complete).toBe(false);
  expect(result.stats).toMatchObject({ chunks: 3, requests: 2, scored: 1 });
  expect(calls.map(call => call.state.file)).toEqual(["a.ts", "b.ts"]);
  expect(result.matches.map(match => match.file)).toEqual(["b.ts"]);
  expect(result.notices.join(" ")).toContain("never searched");
  expect(result.notices.join(" ")).toContain("a.ts:1");
  for (const report of [JSON.stringify(result), findMarkdown(query, result), findText(result)]) {
    expect(report).not.toContain(privateBody);
  }
});

test("overlapping repository windows preserve line ranges and render each source line once", async () => {
  const source = 'import { save } from "./store";\na();\nb();\nc();\nd();\ne();\nf();\ng();';
  const { hunks } = await repoHunks(memoryRepo({ "flow.ts": source }), parseConfig({}, "test"), [], { chunkLines: 4, overlapLines: 2 });
  expect(hunks.map(hunk => [hunk.newStart, hunk.newLines])).toEqual([[1, 4], [3, 4], [5, 4]]);
  const { client } = fakeJev(() => ({ type: "noul", p: 0.8 }));
  const result = await find({ ...base, hunks, client, perFacet: 0 });
  expect(result.matches.map(match => [match.startLine, match.endLine, match.code])).toEqual([
    [1, 4, 'import { save } from "./store";\na();\nb();\nc();'],
    [3, 6, "b();\nc();\nd();\ne();"],
    [5, 8, "d();\ne();\nf();\ng();"],
  ]);
  expect(result.selection).toMatchObject({ perFacet: null, matched: 3, returned: 3 });
  const markdown = findMarkdown(query, result);
  expect(markdown).toContain("### `flow.ts`:1-8");
  expect(markdown).toContain(`\n${source}\n`);
  expect(markdown.match(/import \{ save \}/g)).toHaveLength(1);
  expect(findText(result)).toContain("8 │ g();");
});

test("unavailable selected files make a sweep incomplete without confusing exclusions with failures", async () => {
  const repo = memoryRepo({
    "src/ok.ts": "write();",
    "src/blob.bin": "\0binary",
    "src/huge.ts": "x".repeat(1_000_001),
    "src/empty.ts": " \n",
    "src/ignored.ts": "excluded();",
    "src/yarn.lock": "artifact",
    "docs/readme.md": "outside include",
  });
  const { hunks, skipped } = await repoHunks({
    ...repo,
    files: async () => [...await repo.files(), "src/missing.ts", "src/unreadable.ts"],
    read: async path => {
      if (path === "src/unreadable.ts") throw new Error("private filesystem detail");
      return repo.read(path);
    },
  }, parseConfig({ include: ["src/**"], ignore: ["src/ignored.ts"] }, "test"), ["src"]);
  expect(skipped).toEqual(["src/blob.bin", "src/huge.ts", "src/missing.ts", "src/unreadable.ts"]);
  const { client } = fakeJev(() => ({ type: "noul", p: 0.9 }));
  const result = await find({ ...base, hunks, skippedFiles: skipped, client });
  expect(result.stats).toMatchObject({ chunks: 1, scored: 1 });
  expect(result.complete).toBe(false);
  expect(result.matches.map(match => match.file)).toEqual(["src/ok.ts"]);
  for (const file of skipped) expect(result.notices.join(" ")).toContain(file);
  expect(JSON.stringify(result)).not.toContain("private filesystem detail");
  expect(JSON.stringify(result)).not.toContain("src/ignored.ts");
});

test("Markdown reports keep embedded fences inside the quoted source", async () => {
  const { client } = fakeJev(() => ({ type: "noul", p: 0.9 }));
  const source = "```ts\nwrite();\n```\n# This heading belongs to the source";
  const result = await find({ ...base, hunks: fileHunks("notes.md", source), client });
  expect(findMarkdown(query, result)).toContain("````markdown\n```ts\nwrite();\n```\n# This heading belongs to the source\n````");
});

test("a query is never silently truncated before it reaches the provider", async () => {
  const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.9 }));
  await expect(find({ ...base, task: "x".repeat(4001), hunks: fileHunks("a.ts", "write();"), client })).rejects.toThrow("4000");
  expect(calls).toHaveLength(0);
});
