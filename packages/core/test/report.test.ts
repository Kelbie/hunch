import { expect, test } from "bun:test";
import { summaryMarkdown } from "../src/report.js";
import type { CheckResult } from "../src/check.js";

const result: CheckResult = {
  complete: true,
  findings: [
    { rule: "billing/retry", source: "config", level: "error", file: "src/pay.ts", line: 12, endLine: 20, message: "Retrying after a timeout may charge the customer twice.", evidence: "choice=duplicate_charge (confidence 0.94)" },
    { rule: "failures/misleading-success", source: "hunch:recommended", level: "warn", file: "src/pay.ts", line: 12, endLine: 20, message: "A failed operation may now be reported as successful completion.", evidence: "p(yes)=0.96 ≥ 0.85" },
  ],
  stats: { hunks: 1, skippedHunks: 0, requests: 1, questions: 2, inputTokens: 1234, modelIds: ["typesafe-ai/jev"] },
  notices: ["skill/codebase-design: 1 guidance item(s) require human review (see hunch.lock)."],
};

test("PR comment leads with readable concerns and groups locations, keeping diagnostics collapsed", () => {
  const markdown = summaryMarkdown(result, { blobBase: `https://github.com/acme/repo/blob/${"a".repeat(40)}` });
  const visible = markdown.split("<details>")[0]!;
  expect(visible).toContain("2 possible issues");
  expect(visible).toContain("Retrying after a timeout may charge the customer twice.");
  expect(visible).toContain("#L12-L20");
  expect(visible.match(/src\/pay.ts:12/g)).toHaveLength(1);
  expect(visible).not.toContain("billing/retry");
  expect(visible).not.toContain("confidence");
  expect(visible).not.toContain("guidance item");
  expect(markdown).toContain("hunch:recommended");
  expect(markdown).not.toContain("input tokens");
});

test("coverage gaps stay visible even when findings exist", () => {
  const markdown = summaryMarkdown({ ...result, complete: false, notices: ["Review budget reached; remaining rules were skipped."] });
  const visible = markdown.split("<details>")[0]!;
  expect(visible).toContain("Review is incomplete");
  expect(visible).toContain("remaining rules were skipped");
  expect(summaryMarkdown({ ...result, findings: [] }, { staleLock: true })).not.toContain("No concerns found.");
});

test("identical concerns from multiple rules appear once without losing their attribution", () => {
  const first = result.findings[0]!;
  const markdown = summaryMarkdown({ ...result, findings: [first, { ...first, rule: "skill/payments/retry", source: "skill/payments", level: "warn" }] });
  const visible = markdown.split("<details>")[0]!;
  expect(visible).toContain("1 possible issue");
  expect(visible.match(/Retrying after a timeout/g)).toHaveLength(1);
  expect(markdown).toContain("skill/payments/retry");
  expect(markdown).toContain("billing/retry");
});
