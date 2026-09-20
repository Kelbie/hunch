import { describe, expect, test } from "bun:test";
import { check, judge } from "../src/check.js";
import { parseHunks, windowHunk } from "../src/diff.js";
import { type Answer, confidenceOf } from "../src/jev.js";
import { applyPresets } from "../src/load/index.js";
import type { Lock } from "../src/lock.js";
import { parseConfig } from "../src/schema.js";
import { DIFF, fakeJev } from "./helpers.js";

const config = (raw: object) => applyPresets(parseConfig(raw, "test"));

describe("diff", () => {
  test("splits files into hunks with line numbers", () => {
    const hunks = parseHunks(DIFF);
    expect(hunks.map((h) => h.file)).toEqual(["src/pay.ts", "src/pay.test.ts", "bun.lock"]);
    expect(hunks[0]!.added.map((a) => a.line)).toEqual([2, 4, 5]);
    expect(hunks[0]!.text.startsWith("@@ -1,6 +1,8 @@")).toBe(true);
  });

  test("windows oversized hunks", () => {
    const body = Array.from({ length: 400 }, (_, i) => `+const v${i} = ${"x".repeat(80)};`).join("\n");
    const big = parseHunks(`--- a/f.ts\n+++ b/f.ts\n@@ -0,0 +1,400 @@\n${body}\n`)[0]!;
    const windows = windowHunk(big, 2000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.reduce((n, w) => n + w.added.length, 0)).toBe(400);
  });
});

describe("check", () => {
  test("preset provenance survives severity changes but replacement questions belong to config", async () => {
    const cfg = config({ extends: ["hunch:recommended"],
      rules: { "failures/misleading-success": "error" },
      overrides: [{ files: ["src/pay.ts"], rules: { "docs/contradictory-comment": ["warn", "Follow the project's documentation contract."] } }],
    });
    const result = await check({ config: cfg, hunks: parseHunks(DIFF).slice(0, 1), client: fakeJev(() => ({ type: "noul", p: 0.99 })).client });
    expect(result.findings.find(f => f.rule === "failures/misleading-success")?.source).toBe("hunch:recommended");
    expect(result.findings.find(f => f.rule === "docs/contradictory-comment")?.source).toBe("config");
  });
  test("semantic rules share one batched request per hunk", async () => {
    const { client, calls } = fakeJev((q): Answer =>
      q.type === "noul" ? { type: "noul", p: q.instructions.includes("comment") ? 0.95 : 0.05 } : q.type === "choice"
        ? { type: "choice", choice: "debug", probabilities: { production: 0.05, debug: 0.9, placeholder: 0.03, other: 0.02 }, confidence: confidenceOf({ production: 0.05, debug: 0.9, placeholder: 0.03, other: 0.02 }) }
        : { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
    );
    const cfg = config({ extends: ["hunch:recommended"] });
    const res = await check({ config: cfg, hunks: parseHunks(DIFF), client, task: "Add payment" });

    const rules = res.findings.map((f) => `${f.rule}@${f.file}`);
    expect(rules).toContain("docs/contradictory-comment@src/pay.ts");
    // every Jev-backed rule for a hunk goes in one request
    const payCalls = calls.filter((c) => c.state.file === "src/pay.ts");
    expect(payCalls).toHaveLength(1);
    expect(payCalls[0]!.state.task).toBe("Add payment");
    expect(Object.keys(payCalls[0]!.questions).length).toBeGreaterThan(1);
  });

  test("overrides turn rules off per file; ignore skips files", async () => {
    const { client } = fakeJev(() => ({ type: "noul", p: 0.99 }));
    const cfg = config({
      ignore: ["bun.lock"],
      rules: { "team/no-console": ["warn", "No console.log in source files."] },
      overrides: [{ files: ["**/*.test.ts"], rules: { "team/no-console": "off" } }],
    });
    const res = await check({ config: cfg, hunks: parseHunks(DIFF), client });
    expect(res.findings.map((f) => f.file)).toEqual(["src/pay.ts"]);
    expect(res.findings[0]!.message).toBe("No console.log in source files.");
  });

  test("`when` prefilter avoids the request entirely", async () => {
    const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.99 }));
    const cfg = config({ rules: { "x/unsafe": ["warn", { kind: "noul", instructions: "Unsafe?", when: "unsafe\\s*\\{" }] } });
    const res = await check({ config: cfg, hunks: parseHunks(DIFF), client });
    expect(calls).toHaveLength(0);
    expect(res.findings).toHaveLength(0);
  });

  test("compiled skill rules: scoped, deterministically bounded, incomplete coverage explicit", async () => {
    const lock: Lock = {
      version: 1,
      compiler: { model: "m" },
      sources: [
        {
          id: "skill/seo",
          kind: "skill",
          origin: "acme/skills",
          commit: "abc",
          path: "seo/SKILL.md",
          scope: "",
          hash: "h",
          notChecked: [],
          rules: Array.from({ length: 5 }, (_, i) => ({
            id: `skill/seo/r${i}`,
            section: "S",
            message: `SEO rule ${i}`,
            instructions: `Does hunk break SEO rule ${i}?`,
            criteria: { true: "t", false: "f" },
            appliesTo: i === 4 ? ["**/*.tsx"] : [],
          })),
        },
      ],
    };
    const { client, calls } = fakeJev((q) => ({ type: "noul", p: q.instructions.includes("kind of code") ? (q.instructions.includes("rule 0") ? 0.9 : 0.1) : 0.9 }));
    const cfg = config({ budget: { maxRulesPerHunk: 2 }, rules: { "skill/seo/r1": "error" } });
    const res = await check({ config: cfg, hunks: parseHunks(DIFF).slice(0, 1), client, lock });
    // r4 is scoped to .tsx; 4 remain > 2 → routing request, only r0 judged relevant
    expect(calls).toHaveLength(1);
    expect(res.findings.map((f) => f.rule)).toEqual(["skill/seo/r0", "skill/seo/r1"]);
    expect(res.complete).toBe(false);
    expect(res.notices.join()).toContain("2 rules skipped");
    expect(res.findings[0]!.source).toBe("skill/seo");

    const off = config({ rules: { "skill/seo/*": "off" } });
    const none = await check({ config: off, hunks: parseHunks(DIFF).slice(0, 1), client: fakeJev(() => ({ type: "noul", p: 1 })).client, lock });
    expect(none.findings).toHaveLength(0);
  });

  test("compiledScope everywhere asks every compiled rule of every chunk, ignoring inferred globs and regexes", async () => {
    const lock: Lock = { version: 1, compiler: { model: "m" }, sources: [
      { id: "doc/style", kind: "doc", origin: "./style.md", path: "style.md", scope: "", hash: "h", notChecked: [], rules: [
        { id: "doc/style/tsx-only", section: "S", message: "m", instructions: "Tsx?", criteria: { true: "t", false: "f" }, appliesTo: ["**/*.tsx"] },
        { id: "doc/style/never-matches", section: "S", message: "m", instructions: "Regex?", criteria: { true: "t", false: "f" }, appliesTo: [], when: "zzz-not-in-the-hunk" },
        { id: "doc/style/off", section: "S", message: "m", instructions: "Off?", criteria: { true: "t", false: "f" }, appliesTo: [] },
      ] },
      { id: "agents-md/other", kind: "agents-md", origin: "./other/AGENTS.md", path: "other/AGENTS.md", scope: "other", hash: "h", notChecked: [], rules: [
        { id: "agents-md/other/local", section: "S", message: "m", instructions: "Other dir?", criteria: { true: "t", false: "f" }, appliesTo: [] },
      ] },
    ] };
    const hunks = parseHunks(DIFF).slice(0, 1);
    const asked = async (raw: object) => {
      const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.01 }));
      const res = await check({ config: config({ rules: { "doc/style/off": "off" }, ...raw }), hunks, client, lock });
      return { res, questions: calls.flatMap((c) => Object.values(c.questions).map((q) => q.instructions.split(" ")[0])) };
    };

    expect((await asked({})).questions).toEqual([]);
    const everywhere = await asked({ review: { compiledScope: "everywhere" } });
    // A rule switched off stays off, and a nested AGENTS.md still governs only its own directory.
    expect(everywhere.questions).toEqual(["Tsx?", "Regex?"]);
    expect(everywhere.res.complete).toBe(true);
  });

  test("a plan counts exactly what a review would send, and sends nothing", async () => {
    const rules = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
      `policy/r${i}`,
      ["warn", `Rule ${i}. ${"The contract must hold. ".repeat(160)}`],
    ]));
    const hunks = parseHunks(DIFF).slice(0, 1);
    const real = fakeJev(() => ({ type: "noul", p: 0.01 }));
    const sent = await check({ config: config({ budget: { maxRulesPerHunk: 1024, maxRequests: 100 }, rules }), hunks, client: real.client });

    const planned = fakeJev(() => ({ type: "noul", p: 0.99 }));
    const plan = await check({ config: config({ budget: { maxRulesPerHunk: 1024, maxRequests: 100 }, rules }), hunks, client: planned.client, plan: true });
    expect(planned.calls).toHaveLength(0);
    expect(plan.findings).toEqual([]);
    expect(plan.stats.requests).toBe(sent.stats.requests);
    expect(plan.stats.questions).toBe(60);
    expect(plan.complete).toBe(true);

    // Planning reads the same surrounding source a review would, however slow the reader is.
    const source = Array.from({ length: 8 }, (_, i) => hunks[0]!.added.find((a) => a.line === i + 1)?.content ?? "").join("\n");
    const slow = await check({ config: config({ rules: { "a/b": ["warn", "Anything?"] } }), hunks, client: planned.client, plan: true,
      readChangedFile: () => new Promise((resolve) => setTimeout(() => resolve(source), 20)) });
    expect(slow.notices).toEqual([]);

    // A budget the review would exhaust shows up in the plan, not only after paying for the run.
    const short = await check({ config: config({ budget: { maxRulesPerHunk: 1024, maxRequests: 2 }, rules }), hunks, client: planned.client, plan: true });
    expect(short.complete).toBe(false);
    expect(short.stats.requests).toBe(sent.stats.requests);
    expect(short.notices.join()).toContain(`needs ${sent.stats.requests} requests; budget.maxRequests is 2`);
  });

  test("a policy too large for one request is asked over several, not truncated", async () => {
    // Each rule carries ~4KB of instructions, so 60 of them cannot share one 80KB request.
    const rules = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
      `policy/r${i}`,
      ["warn", `Rule ${i}. ${"The contract must hold. ".repeat(160)}`],
    ]));
    const { client, calls } = fakeJev((q) => ({ type: "noul", p: q.instructions.includes("Rule 7.") ? 0.99 : 0.01 }));
    const cfg = config({ budget: { maxRulesPerHunk: 1024, maxRequests: 100 }, rules });
    const res = await check({ config: cfg, hunks: parseHunks(DIFF).slice(0, 1), client });

    expect(calls.length).toBeGreaterThan(1);
    expect(res.complete).toBe(true);
    expect(res.notices.join()).not.toContain("context budget");
    // Every rule was asked exactly once, across the requests.
    expect(calls.reduce((n, c) => n + Object.keys(c.questions).length, 0)).toBe(60);
    expect(res.findings.map((f) => f.rule)).toEqual(["policy/r7"]);
    for (const call of calls) expect(JSON.stringify(call).length).toBeLessThanOrEqual(80_000);
  });

  test("the request budget still bounds a split policy, and says so", async () => {
    const rules = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
      `policy/r${i}`,
      ["warn", `Rule ${i}. ${"The contract must hold. ".repeat(160)}`],
    ]));
    const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.01 }));
    const cfg = config({ budget: { maxRulesPerHunk: 1024, maxRequests: 1 }, rules });
    const res = await check({ config: cfg, hunks: parseHunks(DIFF).slice(0, 1), client });

    expect(calls).toHaveLength(1);
    expect(res.complete).toBe(false);
    expect(res.notices.join()).toContain("request/time budget reached");
  });
});

describe("judge", () => {
  test("score reportBelow uses the normalised position", () => {
    const q = { kind: "score" as const, instructions: "i", criteria: ["a", "b", "c"], reportBelow: 0.25, minConfidence: 0 };
    expect(judge(q, { type: "score", score: 0.2, probabilities: {}, confidence: 1 })).toContain("score 0.10");
    expect(judge(q, { type: "score", score: 1.2, probabilities: {}, confidence: 1 })).toBeNull();
  });
  test("confidence is 1 for a certain answer and 0 for uniform", () => {
    expect(confidenceOf({ a: 1, b: 0 })).toBe(1);
    expect(confidenceOf({ a: 0.5, b: 0.5 })).toBeCloseTo(0);
  });
});
