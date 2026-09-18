import type { CheckResult, Finding } from "./check.js";

/** Hidden marker so the app/action updates one comment instead of posting new ones. */
export const STICKY_MARKER = "<!-- hunch:summary -->";

export interface ReportContext {
  /** Links findings to `blob/<sha>/<file>#L<line>` when set. */
  blobBase?: string;
  staleLock?: boolean;
}

export function summaryMarkdown(result: CheckResult, ctx: ReportContext = {}): string {
  const { findings, stats, notices } = result;
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.length - errors;
  const head =
    findings.length === 0
      ? result.complete ? "**Hunch** found no concerns in the reviewed changes." : "**Hunch** found no concerns in the checked portion. Review is incomplete."
      : `**hunch** flagged ${plural(findings.length, "finding")}: ${errors} error, ${warns} warning.`;

  const lines = [STICKY_MARKER, `### 🔮 hunch`, "", head, ""];
  if (findings.length) {
    lines.push("| | Rule | Where | Why |", "|---|---|---|---|");
    for (const f of findings.slice(0, 50)) {
      const location = escapeCell(`${f.file}:${f.line}`);
      const where = ctx.blobBase ? `[${location}](${ctx.blobBase}/${f.file.split("/").map(encodeURIComponent).join("/")}#L${f.line})` : location;
      lines.push(`| ${f.level === "error" ? "🔴" : "🟡"} | ${escapeCell(f.rule)} | ${where} | ${escapeCell(f.message)}<br><sub>${escapeCell(f.evidence)}</sub> |`);
    }
    if (findings.length > 50) lines.push("", `…and ${findings.length - 50} more in the check run annotations.`);
    lines.push("");
  }
  if (!result.complete) lines.push("**Coverage: partial.** This is not a passing audit.", "");
  for (const n of notices) lines.push(`> ${escapeCell(n)}`);
  if (ctx.blobBase) lines.push("", `Reviewed commit: [${ctx.blobBase.split("/").at(-1)?.slice(0, 7)}](${ctx.blobBase}).`);
  if (ctx.staleLock) lines.push("> `hunch.lock` is out of date with your skills or AGENTS.md. Run `npx hunch compile` and commit it.");
  lines.push(
    "",
    `<sub>${stats.hunks} hunks · ${stats.requests} Jev requests · ${stats.questions} questions · ${stats.inputTokens.toLocaleString("en")} input tokens` +
      `${stats.modelIds.length ? ` · ${stats.modelIds.map((id) => escapeCell(id.slice(0, 200))).join(", ")}` : ""}. Scores are model estimates, not measured accuracy. Messages state configured concerns; Jev does not generate explanations. Locations identify hunks, not a proven offending line.</sub>`,
  );
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
