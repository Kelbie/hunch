import { expect, test } from "bun:test";
import { check } from "../src/check.js";
import { parseHunks } from "../src/diff.js";
import { parseConfig } from "../src/schema.js";
import { fakeJev } from "./helpers.js";

const lines = Array.from({ length: 32 }, (_, i) => i === 27 ? "return success(error);" : `work${i}();`);
const hunks = parseHunks(`--- /dev/null\n+++ b/pay.ts\n@@ -0,0 +1,32 @@\n${lines.map(line => `+${line}`).join("\n")}\n`);
const policy = () => parseConfig({ agentsMd: false, rules: { failure: ["warn", "Preserve a failed payment."] }, review: { localize: true, localizationLines: 4 } }, "test");

test("review localizes supporting changed lines while retaining parent context and contracts", async () => {
  const { client, calls } = fakeJev((_, state) => {
    const focus = state.focus as { startLine: number; endLine: number } | undefined;
    return { type: "noul", p: !focus || (focus.startLine <= 28 && focus.endLine >= 28) ? 0.95 : 0.05 };
  });
  const result = await check({ config: policy(), hunks, client });
  expect(result.complete).toBe(true);
  expect(result.findings.map(f => [f.line, f.endLine])).toEqual([[25, 28]]);
  expect(calls.every(call => call.state.hunk === hunks[0]!.text)).toBe(true);
  expect(result.findings[0]?.evidence).toContain("localized");
});

test("review supplies bounded head context and trusted reference without claiming they are absent", async () => {
  const cfg = parseConfig({ agentsMd: false, review: { contextLines: 2 }, rules: { guard: ["warn", { kind: "noul", instructions: "Was a guard removed?", reference: "contract.md" }] } }, "test");
  const diff = parseHunks("--- a/f.ts\n+++ b/f.ts\n@@ -4,2 +4,1 @@\n- guard();\n work();\n");
  const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.9 }));
  const result = await check({ config: cfg, hunks: diff, client, readFile: async () => "Only authorized calls may proceed.", readChangedFile: async () => "one\ntwo\nthree\nwork();\nfive\nsix\nseven\n" });
  expect(result.complete).toBe(true);
  expect(calls[0]?.state.surrounding).toEqual({ file: "f.ts", startLine: 2, endLine: 6, text: "two\nthree\nwork();\nfive\nsix" });
  expect(calls[0]?.state.context).toContain("removal");
  expect(calls[0]?.state.context).toContain("reference");
  expect(calls[0]?.state.context).not.toContain("Nothing else is visible");
});

test("an explicit insufficient-context answer is a reported coverage gap, not a clean review", async () => {
  const config = parseConfig({ agentsMd: false, rules: { operation: ["warn", { kind: "choice", instructions: "Does this preserve the operation contract?", criteria: { concern: "Visible violation", preserved: "Visible preservation", unknown: "Relevant but necessary context is absent" }, report: ["concern"], abstain: ["unknown"] }] } }, "test");
  const { client } = fakeJev(() => ({ type: "choice", choice: "unknown", confidence: 0.8, probabilities: { concern: 0.05, preserved: 0.05, unknown: 0.9 } }));
  const result = await check({ config, hunks, client });
  expect(result.complete).toBe(false);
  expect(result.findings).toEqual([]);
  expect(result.notices.join()).toContain("operation");
  expect(result.notices.join()).toContain("insufficient context");
});

test("localization never spends baseline coverage or drops a finding when its budget ends", async () => {
  const config = policy();
  config.budget.maxRequests = 2;
  const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.9 }));
  const result = await check({ config, hunks: [hunks[0]!, { ...hunks[0]!, file: "other.ts" }], client });
  expect(calls).toHaveLength(2);
  expect(calls.every(call => !call.state.focus)).toBe(true);
  expect(result.findings).toHaveLength(2);
  expect(result.findings.every(f => f.line === 1 && f.endLine === 32)).toBe(true);
  expect(result.complete).toBe(false);
});

test("a broad finding survives when neither child independently supports it", async () => {
  const { client } = fakeJev((_, state) => ({ type: "noul", p: state.focus ? 0.1 : 0.9 }));
  const result = await check({ config: policy(), hunks, client });
  expect(result.complete).toBe(true);
  expect(result.findings.map(f => [f.line, f.endLine])).toEqual([[1, 32]]);
  expect(result.findings[0]?.evidence).toContain("broader context retained");
});

test("exhausted review budgets do not fetch context for remaining hunks", async () => {
  const config = policy();
  config.review.localize = false;
  config.budget.maxRequests = 1;
  config.budget.concurrency = 1;
  const reads: string[] = [];
  const { client } = fakeJev(() => ({ type: "noul", p: 0.1 }));
  const result = await check({ config, hunks: [hunks[0]!, { ...hunks[0]!, file: "other.ts" }], client,
    readChangedFile: async path => { reads.push(path); return lines.join("\n"); } });
  expect(reads).toEqual(["pay.ts"]);
  expect(result.complete).toBe(false);
});

test("windowed review provides consistent diff coordinates and removal membership", async () => {
  const config = parseConfig({ agentsMd: false, review: { chunkLines: 2 }, rules: { a: ["warn", "Preserve failures."] } }, "test");
  const h = parseHunks("--- a/f.ts\n+++ b/f.ts\n@@ -10,4 +10,2 @@\n-remove();\n keep();\n-remove();\n keep();\n");
  const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.1 }));
  await check({ config, hunks: h, client });
  expect(calls.map(call => String(call.state.hunk).split("\n")[0])).toEqual(["@@ -10,2 +10,1 @@", "@@ -12,2 +11,1 @@"]);
});

test("mismatched reviewed source is an explicit coverage gap", async () => {
  const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.1 }));
  const result = await check({ config: policy(), hunks, client, readChangedFile: async () => "different revision" });
  expect(result.complete).toBe(false);
  expect(result.notices.join()).toContain("mismatched");
  expect(calls[0]?.state.surrounding).toBeUndefined();
});

test("a low-confidence child cannot discard part of a positive parent", async () => {
  const config = parseConfig({ agentsMd: false, review: { localize: true, localizationLines: 4 }, rules: { r: ["warn", { kind: "choice", instructions: "Assess payment preservation", criteria: { bad: "Concern", safe: "Safe" }, report: ["bad"], minConfidence: 0.5 }] } }, "test");
  const { client } = fakeJev((_, state) => {
    const focus = state.focus as { startLine: number } | undefined;
    const uncertain = focus && focus.startLine > 16;
    return { type: "choice", choice: uncertain ? "safe" : "bad", confidence: uncertain ? 0.1 : 0.9, probabilities: uncertain ? { bad: 0.45, safe: 0.55 } : { bad: 0.95, safe: 0.05 } };
  });
  const result = await check({ config, hunks, client });
  expect(result.complete).toBe(false);
  expect(result.findings.map(f => [f.line, f.endLine])).toEqual([[1, 32]]);
  expect(result.findings[0]?.evidence).toContain("original range retained");
});
