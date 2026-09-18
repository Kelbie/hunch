import type { CheckResult, Finding } from "./check.js";

/** Hidden marker so the app/action updates one comment instead of posting new ones. */
export const STICKY_MARKER = "<!-- hunch:summary -->";

export interface ReportContext {
  /** Links findings to `blob/<sha>/<file>#L<line>` when set. */
  blobBase?: string;
  staleLock?: boolean;
}

export function summaryMarkdown(result: CheckResult, ctx: ReportContext = {}): string {
  const complete = result.complete && !ctx.staleLock;
  // Keep error-level concerns visible first if a large review needs truncation.
  const issues = [...Map.groupBy(result.findings, f => JSON.stringify([f.file, f.line, f.endLine, f.message])).values()];
  const isError = (issue: Finding[]) => issue.some(f => f.level === "error");
  const shown = issues.sort((a, b) => Number(isError(b)) - Number(isError(a))).slice(0, 50);
  const headline = issues.length
    ? `**${plural(issues.length, "possible issue")} to review.**`
    : complete ? "No concerns found in the reviewed changes." : "No concerns found in the checked portion.";
  const lines = [STICKY_MARKER, "## Hunch review", "", headline, ""];
  if (!complete) {
    lines.push("> **Review is incomplete.** Some changes or guidance could not be checked.", "");
    for (const notice of result.notices) lines.push(`- ${escapeCell(notice)}`);
    if (ctx.staleLock) lines.push("- Guidance is out of date. Run `npx hunch compile` and commit `hunch.lock`.");
    lines.push("");
  }
  const sections = Map.groupBy(shown, ([f]) => JSON.stringify([f!.file, f!.line, f!.endLine]));
  let issue = 0;
  for (const group of sections.values()) {
    const first = group[0]![0]!;
    const range = first.endLine > first.line ? `${first.line}–${first.endLine}` : String(first.line);
    const label = escapeCell(`${first.file}:${range}`);
    const anchor = `#L${first.line}${first.endLine > first.line ? `-L${first.endLine}` : ""}`;
    const location = ctx.blobBase ? `[${label}](${ctx.blobBase}/${first.file.split("/").map(encodeURIComponent).join("/")}${anchor})` : label;
    lines.push(`### ${location}`, "");
    for (const findings of group) {
      lines.push(`${++issue}. ${isError(findings) ? "**Error:** " : ""}${escapeCell(findings[0]!.message)}`);
    }
    lines.push("");
  }
  if (issues.length > shown.length) lines.push(`${issues.length - shown.length} more concerns are available in the check annotations.`, "");
  if (ctx.blobBase) lines.push(`Reviewed [${escapeCell(ctx.blobBase.split("/").at(-1)?.slice(0, 7) ?? "commit")}](${ctx.blobBase}).`, "");
  if (shown.length || result.notices.length || result.stats.modelIds.length) {
    lines.push("<details>", "<summary>Review details</summary>", "", "These are configured concerns selected by the model. Links identify changed sections, not exact offending lines.", "");
    if (shown.length) {
      lines.push("| Issue | Rule | Source | Model result |", "| --- | --- | --- | --- |");
      issue = 0;
      for (const group of sections.values()) for (const findings of group) {
        ++issue;
        for (const f of findings) lines.push(`| ${issue} | ${escapeCell(f.rule)} | ${escapeCell(f.source)} | ${escapeCell(f.evidence)} |`);
      }
      lines.push("");
    }
    if (complete && result.notices.length) {
      lines.push("Guidance requiring human review:", "");
      for (const notice of result.notices) lines.push(`- ${escapeCell(notice)}`);
      lines.push("");
    }
    if (result.stats.modelIds.length) lines.push(`Model: ${result.stats.modelIds.map(id => escapeCell(id.slice(0, 200))).join(", ")}. Scores are estimates, not measured accuracy.`, "");
    lines.push("</details>");
  }
  return lines.join("\n");
}

/** GitHub Checks API annotations (max 50 per request; the caller batches). */
export function toAnnotations(findings: Finding[]) {
  return findings.map((f) => ({
    path: f.file,
    start_line: f.line,
    end_line: Math.max(f.line, f.endLine),
    annotation_level: f.level === "error" ? ("failure" as const) : ("warning" as const),
    title: f.rule,
    message: `${f.message}\n(${f.evidence}; from ${f.source})`,
  }));
}

/** GitHub Actions workflow commands, for the CLI's `--reporter github`. */
export function toWorkflowCommands(findings: Finding[]): string {
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return findings
    .map((f) => `::${f.level === "error" ? "error" : "warning"} file=${esc(f.file).replace(/,/g, "%2C").replace(/:/g, "%3A")},line=${f.line},endLine=${f.endLine},title=${esc(f.rule).replace(/,/g, "%2C").replace(/:/g, "%3A")}::${esc(`${f.message} (${f.evidence})`)}`)
    .join("\n");
}

export function toSarif(findings: Finding[], version: string) {
  const rules = [...new Set(findings.map((f) => f.rule))];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "hunch", version, informationUri: "https://github.com/kelbie/hunch", rules: rules.map((id) => ({ id })) } },
        results: findings.map((f) => ({
          ruleId: f.rule,
          level: f.level === "error" ? "error" : "warning",
          message: { text: `${f.message} (${f.evidence})` },
          locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line, endLine: f.endLine } } }],
        })),
      },
    ],
  };
}

export function toText(result: CheckResult): string {
  const out = result.findings.map(
    (f) => `${f.file}:${f.line}  ${f.level === "error" ? "error" : "warn "}  ${f.message}  ${f.rule}\n    ${f.evidence} · ${f.source}`,
  );
  out.unshift(`Hunch · ${result.complete ? "review complete" : "partial review"}\n`);
  out.push(...result.notices.map((n) => `note: ${n}`));
  const s = result.stats;
  out.push(`\n${plural(result.findings.length, "finding")} · ${s.hunks} hunks · ${s.requests} requests · ${s.inputTokens} input tokens`);
  return out.join("\n");
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const escapeCell = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\[\]`*|\\]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\r\n]/g, " ");
