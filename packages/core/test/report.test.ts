import { expect, test } from "bun:test";
import { diffExcerpt, findingKey, findingKeysIn, reviewComment, shortPaths, summaryMarkdown, toText } from "../src/report.js";
import { parseHunks, unreviewableFiles } from "../src/diff.js";
import type { CheckResult } from "../src/check.js";

const result: CheckResult = {
  complete: true,
  findings: [
    { rule: "billing/retry", source: "config", level: "error", file: "src/pay.ts", line: 12, endLine: 20, message: "Retrying after a timeout may charge the customer twice.", evidence: "choice=duplicate_charge (confidence 0.94)" },
    { rule: "failures/misleading-success", source: "hunch:recommended", level: "warn", file: "src/pay.ts", line: 12, endLine: 20, message: "A failed operation may now be reported as successful completion.", evidence: "p(yes)=0.96 ≥ 0.85" },
  ],
  stats: { hunks: 1, skippedHunks: 0, requests: 1, questions: 2, inputTokens: 1234, modelIds: ["typesafe-ai/jev"] },
  notices: [],
  info: ["skill/codebase-design: 1 guidance item can't be checked one change at a time; see notChecked in hunch.lock."],
};

test("PR comment reads like the terminal report: headline, one row per concern, diagnostics collapsed", () => {
  const markdown = summaryMarkdown(result, { blobBase: `https://github.com/acme/repo/blob/${"a".repeat(40)}` });
  const visible = markdown.split("<details>")[0]!;
  expect(visible).toContain("### 🔮 Hunch · 1 place to review (1 with errors) · review complete");
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
  // A whole new file anchors where reading starts, and says which lines it means.
  const long = reviewComment([{ ...result.findings[0]!, line: 1, endLine: 40 }]);
  expect(long).toMatchObject({ line: 1 });
  expect(long).not.toHaveProperty("start_line");
  expect(long.body).toContain("About lines 1-40");
});

test("the headline counts places, not every overlapping rule, and names files only when it adds something", () => {
  const [a, b] = result.findings;
  const other = { ...a!, file: "src/refund.ts", line: 3, endLine: 3, level: "warn" as const };
  const markdown = summaryMarkdown({ ...result, findings: [a!, b!, other, { ...other, line: 30, endLine: 30 }] });
  expect(markdown).toContain("### 🔮 Hunch · 3 places to review in 2 files (1 with errors) · review complete");
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
  expect(visible).toContain("1 place to review (1 with errors)");
  expect(visible.match(/Retrying after a timeout/g)).toHaveLength(1);
  expect(markdown).toContain("skill/payments/retry");
  expect(markdown).toContain("billing/retry");
});

test("terminal report shows every concern's line range and message, grouped by place", () => {
  const text = toText({
    ...result,
    findings: [
      ...result.findings,
      { rule: "billing/retry", source: "config", level: "error", file: "src/refund.ts", line: 3, endLine: 3, message: "Retrying after a timeout may charge the customer twice.", evidence: "p(yes)=0.9 ≥ 0.7" },
    ],
  }, { width: 80 });
  expect(text).not.toContain("\x1b[");
  expect(text.split("\n")[0]).toBe("Hunch · 3 findings in 2 files (2 errors, 1 warning) · review complete");
  // Both concerns at src/pay.ts:12-20 share one location label, each with its own message.
  expect(text).toMatch(/^src\/pay\.ts\n  L12-20  ✖ error  billing\/retry +choice=duplicate_charge.*\n +Retrying after a timeout may charge the customer twice\.\n +▲ warn   failures\/misleading-success +p\(yes\)=0\.96 ≥ 0\.85 · hunch:recommended\n +A failed operation/m);
  expect(text).toMatch(/^src\/refund\.ts\n  L3 +✖ error  billing\/retry/m);
  expect(text).toMatch(/billing\/retry +2 findings/);
  expect(text).toContain("Notes\n  · skill/codebase-design");
  expect(text.trim().split("\n").at(-1)).toBe("1 hunk · 1 request · 1,234 input tokens · typesafe-ai/jev");
  expect(toText(result, { color: true })).toContain("\x1b[31m✖ error\x1b[0m");
  expect(toText({ ...result, findings: [], notices: [] }).split("\n")[0]).toBe("Hunch · no findings · review complete");
});

test("--show-diff prints the changed lines around each place with new-file line numbers", () => {
  const hunks = parseHunks([
    "diff --git a/src/pay.ts b/src/pay.ts", "--- a/src/pay.ts", "+++ b/src/pay.ts",
    "@@ -10,6 +10,6 @@ export function pay() {",
    " const a = 1;", " const b = 2;", "-const key = order.id;", "+const key = crypto.randomUUID();", " retry(key);", " const c = 3;", " const d = 4;",
  ].join("\n"));
  const f = { ...result.findings[0]!, line: 12, endLine: 12 };
  expect(diffExcerpt(hunks, f, { context: 2 })).toEqual({ omitted: 0, lines: [
    { kind: " ", line: 10, text: "const a = 1;" }, { kind: " ", line: 11, text: "const b = 2;" },
    { kind: "-", text: "const key = order.id;" }, { kind: "+", line: 12, text: "const key = crypto.randomUUID();" },
    { kind: " ", line: 13, text: "retry(key);" }, { kind: " ", line: 14, text: "const c = 3;" },
  ] });
  const text = toText({ ...result, findings: [f] }, { hunks });
  expect(text).toContain("12 │ + const key = crypto.randomUUID();");
  expect(text).toContain("   │ - const key = order.id;");
  expect(toText({ ...result, findings: [f] })).not.toContain("│");
  // A long new file keeps its start and says what was left out.
  const big = parseHunks(`diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`).join("\n")}\n`);
  const e = diffExcerpt(big, { file: "n.ts", line: 1, endLine: 40 })!;
  expect(e.lines[0]).toEqual({ kind: "+", line: 1, text: "line 1" });
  expect(e.omitted).toBe(24);
});

test("locations use the shortest path that tells files apart", () => {
  const paths = shortPaths(["apps/api/lib/review.ts", "examples/typescript/review.ts", "src/index.ts", "src/web/index.ts", "index.ts"]);
  expect([...paths.values()]).toEqual(["lib/review.ts", "typescript/review.ts", "src/index.ts", "web/index.ts", "index.ts"]);
});

test("a partial review's caution lists only real gaps; guidance the lock can't check stays in details", () => {
  const md = summaryMarkdown({ ...result, findings: [], complete: false, notices: ["Binary, rename-only or mode changes need human review: src/logo.bin."] });
  const caution = md.slice(md.indexOf("[!CAUTION]"), md.indexOf("<details>"));
  expect(caution).toContain("src/logo.bin");
  expect(caution).not.toContain("guidance item");
  expect(md.slice(md.indexOf("<details>"))).toContain("skill/codebase-design: 1 guidance item");
});

test("unreviewable changes are named per file, so callers can ignore files outside review scope", () => {
  const diff = [
    "diff --git a/docs/shot.png b/docs/shot.png", "index 1..2 100644", "Binary files a/docs/shot.png and b/docs/shot.png differ",
    "diff --git a/src/a.ts b/src/b.ts", "similarity index 100%", "rename from src/a.ts", "rename to src/b.ts",
    "diff --git a/bin/run b/bin/run", "old mode 100644", "new mode 100755",
    "diff --git a/src/c.ts b/src/c.ts", "--- a/src/c.ts", "+++ b/src/c.ts", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n");
  expect(unreviewableFiles(diff)).toEqual(["docs/shot.png", "src/b.ts", "bin/run"]);
});
