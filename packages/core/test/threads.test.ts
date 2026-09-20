import { expect, test } from "bun:test";
import type { Finding } from "../src/check.js";
import { findingKey } from "../src/report.js";
import { planThreads, type ReviewThread } from "../src/threads.js";

const f: Finding = { rule: "billing/retry", level: "error", file: "src/pay.ts", line: 3, endLine: 5, message: "m", evidence: "e", source: "config" };
const t = (over: Partial<ReviewThread>): ReviewThread => ({ id: "T", resolved: false, resolvedBy: null, line: null, body: `<!-- hunch:finding ${findingKey(f)} -->`, url: "u", mine: true, ...over });
const opts = { self: "hunch[bot]", canDismiss: (login: string) => login === "maintainer", complete: true };

test("a concern Hunch closed as fixed gets a new comment when it comes back", () => {
  const plan = planThreads([f], [t({ resolved: true, resolvedBy: "hunch[bot]" })], opts);
  expect(plan.post).toEqual([[f]]);
  expect(plan.active).toEqual([f]);
});

test("a dismissal follows the rule and file, even after the code moves", () => {
  const plan = planThreads([{ ...f, line: 40, endLine: 41 }], [t({ resolved: true, resolvedBy: "maintainer" })], opts);
  expect(plan.dismissed).toHaveLength(1);
  expect(plan.active).toEqual([]);
  expect(plan.post).toEqual([]);
});

test("a partial review never closes threads as fixed", () => {
  expect(planThreads([], [t({})], { ...opts, complete: false }).resolve).toEqual([]);
  expect(planThreads([], [t({})], opts).resolve.map((x) => x.id)).toEqual(["T"]);
  expect(planThreads([], [t({ mine: false })], opts).resolve).toEqual([]);
});

test("one rule raised at two places in a file links each place to its own thread", async () => {
  const { summaryMarkdown } = await import("../src/report.js");
  const a = { ...f, line: 10, endLine: 10 }, b = { ...f, line: 40, endLine: 41 };
  const plan = planThreads([a, b], [t({ id: "A", line: 10, url: "urlA" }), t({ id: "B", line: 41, url: "urlB" })], opts);
  expect(plan.post).toEqual([]);
  const md = summaryMarkdown({ complete: true, findings: [a, b], notices: [], info: [], stats: { hunks: 2, skippedHunks: 0, requests: 2, questions: 2, inputTokens: 0, modelIds: [], failedRequests: 0 } }, { threads: plan.links });
  expect(md).toContain("[`pay.ts:10`](urlA)");
  expect(md).toContain("[`pay.ts:40-41`](urlB)");
});

test("a new location receives its own thread even when the same concern is already open elsewhere", () => {
  const existing = { ...f, line: 10, endLine: 10 }, added = { ...f, line: 80, endLine: 81 };
  const plan = planThreads([existing, added], [t({ line: 10, url: "old" })], opts);
  expect(plan.post).toEqual([[added]]);
  expect(plan.links.has(`${findingKey(added)}@81`)).toBe(false);
});

test("a complete review closes the old location when the concern remains only elsewhere", () => {
  const moved = { ...f, line: 80, endLine: 81 };
  const old = t({ line: 10 });
  expect(planThreads([moved], [old], opts).resolve).toEqual([old]);
  expect(planThreads([moved], [old], { ...opts, complete: false }).resolve).toEqual([]);
});
