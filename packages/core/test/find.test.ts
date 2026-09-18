import { expect, test } from "bun:test";
import { bodyOf, FACETS, fileHunks, find, findContext, findMarkdown, findText, mergeAdjacent, type Facet, type FindInput } from "../src/index.js";

/** A Jev that answers each facet from a table keyed by file, so ranking is exercised, not guessed. */
function scripted(byFile: Record<string, Partial<Record<Facet, number>>>, spy?: (state: Record<string, unknown>) => void): FindInput["client"] {
  return {
    async evaluate(req) {
      spy?.(req.state);
      const scores = byFile[String(req.state.file)] ?? {};
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, p: scores[id as Facet] ?? 0 }])),
        usage: { inputTokens: 10 },
        modelId: "jev-test",
      };
    },
  };
}

const chunks = (...files: string[]) => files.flatMap((f) => fileHunks(f, "export const a = 1;\nexport const b = 2;"));
const base = { task: "warn about onchain minimums", model: "jev-test" };

test("chunks rank by their strongest facet, and that facet is what the chunk is called", async () => {
  const res = await find({
    ...base,
    hunks: chunks("app/send.tsx", "app/limits.ts", "app/__tests__/send.test.ts", "app/unrelated.ts"),
    client: scripted({
      "app/send.tsx": { edit: 0.91, caller: 0.4 },
      "app/limits.ts": { contract: 0.8, edit: 0.2 },
      "app/__tests__/send.test.ts": { test: 0.7 },
      "app/unrelated.ts": { edit: 0.1, precedent: 0.2 },
    }),
  });
  expect(res.matches.map((m) => [m.file, m.facet, m.score])).toEqual([
    ["app/send.tsx", "edit", 0.91],
    ["app/limits.ts", "contract", 0.8],
    ["app/__tests__/send.test.ts", "test", 0.7],
  ]);
  // Below-threshold chunks are dropped, not reported with a low score.
  expect(res.matches.some((m) => m.file === "app/unrelated.ts")).toBe(false);
  expect(res.stats.scored).toBe(4);
  expect(res.complete).toBe(true);
});

test("every facet's probability survives, so a caller can filter on one the ranking did not pick", async () => {
  const res = await find({ ...base, hunks: chunks("a.ts"), client: scripted({ "a.ts": { edit: 0.9, test: 0.6, caller: 0.55 } }) });
  expect(res.matches[0]!.facets).toEqual({ edit: 0.9, contract: 0, caller: 0.55, test: 0.6, precedent: 0 });
});

test("asking for fewer facets narrows the answer rather than changing the ranking of the rest", async () => {
  const table = { "a.ts": { edit: 0.9, test: 0.6 } };
  const all = await find({ ...base, hunks: chunks("a.ts"), client: scripted(table) });
  const only = await find({ ...base, hunks: chunks("a.ts"), facets: ["test"], client: scripted(table) });
  expect(all.matches[0]!.facet).toBe("edit");
  expect(only.matches[0]!.facet).toBe("test");
  expect(only.matches[0]!.score).toBe(0.6);
});

test("the threshold is the caller's, and a tie goes to the facet that gets someone started fastest", async () => {
  const table = { "a.ts": { edit: 0.3, precedent: 0.3 } };
  expect((await find({ ...base, hunks: chunks("a.ts"), client: scripted(table) })).matches).toHaveLength(0);
  const loose = await find({ ...base, hunks: chunks("a.ts"), minScore: 0.25, client: scripted(table) });
  expect(loose.matches[0]!.facet).toBe("edit");
});

test("a sweep cut short says so and reports itself incomplete, rather than looking like the whole answer", async () => {
  const res = await find({
    ...base,
    hunks: chunks("a.ts", "b.ts", "c.ts", "d.ts"),
    budget: { maxRequests: 2, concurrency: 1 },
    client: scripted({ "a.ts": { edit: 0.9 }, "b.ts": { edit: 0.9 }, "c.ts": { edit: 0.9 }, "d.ts": { edit: 0.9 } }),
  });
  expect(res.stats.scored).toBe(2);
  expect(res.complete).toBe(false);
  expect(res.notices[0]).toContain("never searched");
});

test("each chunk is asked about a task it is told has not happened yet", async () => {
  const seen: Record<string, unknown>[] = [];
  await find({ ...base, hunks: chunks("app/send.tsx"), client: scripted({}, (s) => seen.push(s)) });
  expect(seen[0]!.task).toBe("warn about onchain minimums");
  const context = String(seen[0]!.context);
  expect(context).toContain("has not been made yet");
  expect(context).toContain("You are not reviewing this code");
  expect(context).toContain("Shared words are not relevance");
  // Retrieval must not inherit review's framing, which would have it hunting for defects.
  expect(context).not.toContain("Report a problem");
});

test("an empty task is refused rather than matching everything", async () => {
  await expect(find({ ...base, task: "   ", hunks: chunks("a.ts"), client: scripted({}) })).rejects.toThrow("needs a task");
});

test("markdown output groups by facet and fences the code by language, ready to paste", async () => {
  const res = await find({
    ...base,
    hunks: [...chunks("app/send.tsx"), ...chunks("app/limits.ts")],
    client: scripted({ "app/send.tsx": { edit: 0.9 }, "app/limits.ts": { contract: 0.8 } }),
  });
  const md = findMarkdown("warn about onchain minimums", res);
  expect(md).toContain("# Code relevant to: warn about onchain minimums");
  expect(md).toContain("## What was found");
  expect(md).toContain("## edit here");
  expect(md).toContain("## contract to respect");
  expect(md).toContain("### `app/send.tsx`:1-2");
  expect(md).toContain("```tsx");
  expect(md).toContain("```ts\n");
  expect(md).toContain("export const a = 1;");
  // The document explains its own headings and its own limits to whoever reads it.
  expect(md).toContain("Code that carrying out the task would require editing.");
  expect(md).toContain("not a guarantee");
  expect(findText(res)).toContain("2 of 2 chunks: 1 edit here, 1 contract to respect.");
});

test("the code returned is the file's own source, not the diff markers it was chunked with", () => {
  const [chunk] = fileHunks("a.ts", "const a = 1;\nconst b = 2;");
  expect(chunk!.text).toContain("+const a = 1;");
  expect(bodyOf(chunk!)).toBe("const a = 1;\nconst b = 2;");
});

test("the facet list is the one the CLI validates against", () => {
  expect([...FACETS]).toEqual(["edit", "contract", "caller", "test", "precedent"]);
  expect(findContext(fileHunks("a.ts", "const a = 1;")[0]!)).toContain("`a.ts`");
});

test("each facet keeps its own best, so a generous facet cannot crowd out the rest", async () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const res = await find({
    ...base,
    hunks: chunks(...files),
    perFacet: 2,
    client: scripted({
      "a.ts": { contract: 0.95 }, "b.ts": { contract: 0.94 },
      "c.ts": { contract: 0.93 }, "d.ts": { test: 0.55 },
    }),
  });
  // A global top-3 would have been three contracts and no test at all.
  expect(res.matches.map((m) => [m.file, m.facet])).toEqual([
    ["a.ts", "contract"], ["b.ts", "contract"], ["d.ts", "test"],
  ]);
});

test("one failed chunk costs that chunk, not the sweep", async () => {
  let n = 0;
  const res = await find({
    ...base,
    hunks: chunks("a.ts", "b.ts", "c.ts"),
    budget: { concurrency: 1 },
    client: {
      async evaluate(req) {
        if (++n === 2) throw new Error("rate limited");
        return { answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, p: id === "edit" ? 0.9 : 0 }])), usage: { inputTokens: 1 }, modelId: "jev-test" };
      },
    },
  });
  expect(res.matches.map((m) => m.file)).toEqual(["a.ts", "c.ts"]);
  // The two that worked are real answers; the one that did not is named, and the sweep is not whole.
  expect(res.notices.join(" ")).toContain("rate limited");
  expect(res.complete).toBe(false);
});

test("the code shown is exactly the lines the heading claims, imports included only where they are", () => {
  const body = ["import a from \"a\";", ...Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`)].join("\n");
  const [first, second] = fileHunks("a.ts", body);
  expect(bodyOf(first!).split("\n")[0]).toBe('import a from "a";');
  // The second chunk repeats the imports as reviewer context; quoting them would contradict its range.
  expect(second!.text).toContain(' import a from "a";');
  expect(bodyOf(second!).split("\n")[0]).toBe(`const line${second!.newStart - 1} = ${second!.newStart - 1};`);
  expect(bodyOf(second!).split("\n")).toHaveLength(second!.newLines);
});

test("a file split for budgeting is printed as one passage, not three unrelated excerpts", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
  const res = await find({ ...base, hunks: fileHunks("app/big.ts", long), client: scripted({ "app/big.ts": { edit: 0.8 } }) });
  expect(res.matches.length).toBeGreaterThan(1);
  const merged = mergeAdjacent(res.matches);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.startLine).toBe(1);
  expect(merged[0]!.endLine).toBe(400);
  expect(merged[0]!.code.split("\n")).toHaveLength(400);
  // Merging is presentation: `matches` stays faithful to what was actually scored.
  expect(res.matches.every((m) => m.endLine - m.startLine < 399)).toBe(true);
});

test("chunks that do not touch stay apart", () => {
  const near = { file: "a.ts", startLine: 1, endLine: 10, code: "a", language: null, role: null, facet: "edit" as const, score: 0.9, facets: { edit: 0.9, contract: 0, caller: 0, test: 0, precedent: 0 } };
  const far = { ...near, startLine: 50, endLine: 60, code: "b", score: 0.8 };
  expect(mergeAdjacent([near, far])).toHaveLength(2);
  expect(mergeAdjacent([near, { ...far, startLine: 11, endLine: 20 }])).toHaveLength(1);
});
