import { describe, expect, test } from "bun:test";
import { chunkMarkdown, compileSources, type RuleExtractor } from "../src/compile.js";
import { gatewayClient, typesafeClient } from "../src/jev.js";
import { parseConfig } from "../src/schema.js";
import { collectSources, parseSkillSource, type RemoteFetcher, staleSources } from "../src/skills.js";
import { memoryRepo } from "./helpers.js";

describe("skill sources", () => {
  test.each([
    ["./skills/*", { type: "local", path: "skills", glob: true }],
    ["./skills/seo", { type: "local", path: "skills/seo", glob: false }],
    ["vercel-labs/agent-skills", { type: "remote", repo: "vercel-labs/agent-skills" }],
    [
      "https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines",
      { type: "remote", repo: "vercel-labs/agent-skills", ref: "main", path: "skills/web-design-guidelines" },
    ],
    [{ repo: "acme/skills", skill: "seo" }, { type: "remote", repo: "acme/skills", skill: "seo" }],
  ] as const)("parses %p", (src, expected) => {
    expect(parseSkillSource(src as never)).toMatchObject(expected);
  });

  const repo = memoryRepo({
    ".agents/skills/seo/SKILL.md": "---\nname: seo\ndescription: d\n---\n# SEO\nUse one h1.",
    ".agents/skills/seo/references/meta.md": "Every page sets a meta description.",
    ".claude/skills/seo/SKILL.md": "---\nname: seo\n---\nduplicate, ignored",
    "AGENTS.md": "# Root\n@docs/style.md\nNo default exports.",
    "docs/style.md": "Prefer const.",
    "packages/api/AGENTS.md": "Handlers return Result.",
  });

  test("defaults to installed skill dirs, dedupes by name, inlines references and @includes, scopes nested AGENTS.md", async () => {
    const docs = await collectSources(parseConfig({}, "t"), repo);
    expect(docs.map((d) => d.id)).toEqual(["skill/seo", "agents-md/root", "agents-md/packages/api"]);
    expect(docs[0]!.text).toContain("meta description");
    expect(docs[1]!.text).toContain("Prefer const.");
    expect(docs[2]!.scope).toBe("packages/api");
  });

  test("remote skills are pinned to a commit and filtered by name", async () => {
    const remote: RemoteFetcher = {
      commit: async () => "deadbeef",
      tree: async () => ["skills/a/SKILL.md", "skills/b/SKILL.md", "skills/b/references/x.md"],
      read: async (_r, _c, p) => (p.endsWith("x.md") ? "ref x" : `---\nname: ${p.split("/")[1]}\n---\nbody`),
    };
    const docs = await collectSources(parseConfig({ skills: [{ repo: "acme/skills", skill: "b" }], agentsMd: false }, "t"), repo, remote);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: "skill/b", origin: "acme/skills", commit: "deadbeef" });
    expect(docs[0]!.text).toContain("ref x");
  });

  test("compile reuses unchanged sources and staleness tracks edits", async () => {
    let calls = 0;
    const extractor: RuleExtractor = {
      async extract({ sourceId }) {
        calls++;
        return {
          rules: [
            { slug: "Rule One!", section: "S", message: "m", instructions: "Does `hunk` …?", criteriaTrue: "t", criteriaFalse: "f", appliesTo: [], when: "([" },
            { slug: "rule-one", section: "S", message: "m2", instructions: "?", criteriaTrue: "t", criteriaFalse: "f", appliesTo: ["**/*.md"] },
          ],
          notChecked: [{ section: sourceId, reason: "process" }],
        };
      },
    };
    const cfg = parseConfig({}, "t");
    const docs = await collectSources(cfg, repo);
    const lock = await compileSources(docs, { extractor, model: "m" });
    expect(calls).toBe(3);
    expect(lock.sources[0]!.rules.map((r) => r.id)).toEqual(["skill/seo/rule-one", "skill/seo/rule-one-2"]);
    expect(lock.sources[0]!.rules[0]!.when).toBeUndefined(); // invalid regex dropped
    expect(await staleSources(lock, cfg, repo)).toEqual([]);

    await compileSources(docs, { extractor, model: "m", previous: lock });
    expect(calls).toBe(3); // nothing changed → nothing recompiled

    const edited = memoryRepo({ ...Object.fromEntries(await Promise.all((await repo.files()).map(async (f) => [f, (await repo.read(f))!]))), "AGENTS.md": "changed" });
    expect(await staleSources(lock, cfg, edited)).toEqual(["agents-md/root", "agents-md/packages/api"]);
  });

  test("chunkMarkdown keeps sections whole under the limit", () => {
    const md = ["# A", "a".repeat(50), "## B", "b".repeat(50), "## C", "c".repeat(50)].join("\n");
    const chunks = chunkMarkdown(md, 70);
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.startsWith("## B")).toBe(true);
  });
});

describe("TypeSafe REST adapter", () => {
  test("maps noul/choice/score and retries 529", async () => {
    let n = 0;
    const seen: unknown[] = [];
    const client = typesafeClient({
      apiKey: "k",
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string));
        if (n++ === 0) return new Response("overloaded", { status: 529 });
        return Response.json({
          model: "jev-1.13.0",
          answers: {
            a: { type: "noul", noul: 0.92 },
            b: { type: "choice", choice: "technical", probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 }, confidence: 0.82 },
            c: { type: "score", score: 1.6, legend: {}, probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 }, confidence: 0.78 },
          },
          usage: { input_tokens: 312, output_tokens: 48 },
        });
      }) as typeof fetch,
    });
    const res = await client.evaluate({
      model: "jev-1.13.0",
      state: { hunk: "x" },
      questions: {
        a: { type: "noul", instructions: "?" },
        b: { type: "choice", instructions: "?", criteria: { billing: "", technical: "", sales: "" } },
        c: { type: "score", instructions: "?", criteria: ["a", "b", "c"] },
      },
    });
    expect(n).toBe(2);
    expect((seen[0] as { questions: { a: { type: string } } }).questions.a.type).toBe("noul");
    expect(res.answers.a).toEqual({ type: "noul", p: 0.92 });
    expect(res.answers.b).toMatchObject({ type: "choice", choice: "technical" });
    expect(res.usage.inputTokens).toBe(312);
    expect(res.modelId).toBe("jev-1.13.0");
  });
});

describe.skipIf(!process.env.HUNCH_LIVE)("live gateway smoke", () => {
  test("answers a boolean via AI Gateway", async () => {
    const res = await gatewayClient({ zeroDataRetention: true }).evaluate({
      model: "jev-1.13.0",
      state: { hunk: "+  console.log('DEBUG', user.password)" },
      questions: { leak: { type: "noul", instructions: "Does `hunk` log a password?" } },
    });
    expect((res.answers.leak as { p: number }).p).toBeGreaterThan(0.5);
  });
});
