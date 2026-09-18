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
