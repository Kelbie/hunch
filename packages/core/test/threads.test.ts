import { expect, test } from "bun:test";
import type { Finding } from "../src/check.js";
import { findingKey } from "../src/report.js";
import { planThreads, type ReviewThread } from "../src/threads.js";

const f: Finding = { rule: "billing/retry", level: "error", file: "src/pay.ts", line: 3, endLine: 5, message: "m", evidence: "e", source: "config" };
const t = (over: Partial<ReviewThread>): ReviewThread => ({ id: "T", resolved: false, resolvedBy: null, body: `<!-- hunch:finding ${findingKey(f)} -->`, url: "u", mine: true, ...over });
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
