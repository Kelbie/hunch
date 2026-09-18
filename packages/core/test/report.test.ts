import { expect, test } from "bun:test";
import { findingKey, findingKeysIn, reviewComment, summaryMarkdown, toText } from "../src/report.js";
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

test("PR comment reads like the terminal report: headline, one row per concern, diagnostics collapsed", () => {
  const markdown = summaryMarkdown(result, { blobBase: `https://github.com/acme/repo/blob/${"a".repeat(40)}` });
  const visible = markdown.split("<details>")[0]!;
  expect(visible).toContain("### 🔮 Hunch · 2 possible issues in 1 file (1 error, 1 warning) · review complete");
  expect(visible).toContain("| 🔴 | 🔴 Retrying after a timeout may charge the customer twice.<br><sub>`billing/retry`</sub><br>");
  expect(visible).toContain(`| [\`pay.ts:12-20\`](https://github.com/acme/repo/blob/${"a".repeat(40)}/src/pay.ts#L12-L20) |`);
  expect(visible.match(/pay\.ts:12-20/g)).toHaveLength(1);
  expect(visible).toContain("<br>🟡 A failed operation");
  expect(visible).not.toContain("confidence");
  expect(visible).not.toContain("guidance item");
  expect(visible).not.toContain("Resolve a comment");
  expect(markdown).toContain("hunch:recommended");
  expect(markdown).not.toContain("input tokens");
});

test("PR comment links concerns to their review threads and counts dismissed and fixed ones", () => {
  const threads = new Map([[findingKey(result.findings[0]!), "https://github.com/acme/repo/pull/1#discussion_r1"]]);
  const markdown = summaryMarkdown(result, { blobBase: `https://github.com/acme/repo/blob/${"a".repeat(40)}`, threads, dismissed: 2, fixed: 1 });
  expect(markdown).toContain("[`pay.ts:12-20`](https://github.com/acme/repo/pull/1#discussion_r1)");
  expect(markdown).toContain("2 dismissed · 1 resolved as fixed");
  expect(markdown).toContain("Resolve a comment to dismiss it");
});

test("inline comments carry every concern at a location, with a marker per rule and file", () => {
  const comment = reviewComment(result.findings);
  expect(comment).toMatchObject({ path: "src/pay.ts", start_line: 12, line: 20, side: "RIGHT" });
  expect(findingKeysIn(comment.body)).toEqual(result.findings.map(findingKey));
  expect(comment.body).toContain("🔴 **Error:** Retrying after a timeout");
  expect(comment.body).toContain("🟡 **Warning:** A failed operation");
  expect(reviewComment([{ ...result.findings[0]!, endLine: 12 }])).not.toHaveProperty("start_line");
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
  expect(visible).toContain("1 possible issue in 1 file");
  expect(visible.match(/Retrying after a timeout/g)).toHaveLength(1);
  expect(markdown).toContain("skill/payments/retry");
  expect(markdown).toContain("billing/retry");
});

test("terminal report lists findings as rows per file and prints each rule's text once", () => {
  const text = toText({
    ...result,
    findings: [
      ...result.findings,
      { rule: "billing/retry", source: "config", level: "error", file: "src/refund.ts", line: 3, endLine: 3, message: "Retrying after a timeout may charge the customer twice.", evidence: "p(yes)=0.9 ≥ 0.7" },
    ],
  }, { width: 80 });
  expect(text).not.toContain("\x1b[");
  expect(text.split("\n")[0]).toBe("Hunch · 3 findings in 2 files (2 errors, 1 warning) · review complete");
  expect(text).toMatch(/^src\/pay\.ts\n  L12  ✖ error  billing\/retry +choice=duplicate_charge/m);
  expect(text).toContain("failures/misleading-success  p(yes)=0.96 ≥ 0.85 · hunch:recommended");
  expect(text.split("Retrying after a timeout").length - 1).toBe(1);
  expect(text).toContain("billing/retry  2 findings");
  expect(text).toContain("Notes\n  ! skill/codebase-design");
  expect(text.trim().split("\n").at(-1)).toBe("1 hunk · 1 request · 1,234 input tokens · typesafe-ai/jev");
  expect(toText(result, { color: true })).toContain("\x1b[31m✖ error\x1b[0m");
  expect(toText({ ...result, findings: [], notices: [] }).split("\n")[0]).toBe("Hunch · no findings · review complete");
});
