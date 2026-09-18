import type { CheckResult, Finding } from "./check.js";

/** Hidden marker so the app/action updates one comment instead of posting new ones. */
export const STICKY_MARKER = "<!-- hunch:summary -->";

export interface ReportContext {
  /** Links findings to `blob/<sha>/<file>#L<line>` when set. */
  blobBase?: string;
  staleLock?: boolean;
  /** Inline review thread per finding key (see `findingKey`); preferred over blob links. */
  threads?: Map<string, string>;
  /** Findings someone with write access dismissed by resolving their thread. */
  dismissed?: number;
  /** Earlier findings no longer raised, whose threads were resolved. */
  fixed?: number;
}

/** GitHub can't color text, so severity is an emoji. */
const BADGE = { error: "🔴", warn: "🟡" } as const;

/**
 * PR comment and Markdown report, laid out like the terminal report: a one-line
 * headline, one row per concern (errors first), then a footer. Diagnostics stay collapsed.
 */
export function summaryMarkdown(result: CheckResult, ctx: ReportContext = {}): string {
  const complete = result.complete && !ctx.staleLock;
  // Identical concerns from several rules at one place are one issue.
  const issues = [...Map.groupBy(result.findings, f => JSON.stringify([f.file, f.line, f.endLine, f.message])).values()];
  const isError = (issue: Finding[]) => issue.some(f => f.level === "error");
  issues.sort((a, b) => Number(isError(b)) - Number(isError(a)) || a[0]!.file.localeCompare(b[0]!.file) || a[0]!.line - b[0]!.line);
  const shown = issues.slice(0, 50);
  // Overlapping rules often flag one problem several times, so count places in the code.
  const places = [...Map.groupBy(issues, i => JSON.stringify([i[0]!.file, i[0]!.line, i[0]!.endLine])).values()];
  const withErrors = places.filter(p => p.some(isError)).length;
  const files = new Set(issues.map(i => i[0]!.file)).size;
  const headline = issues.length
    ? `${plural(places.length, "place")} to review${files < places.length ? ` in ${plural(files, "file")}` : ""}${withErrors ? ` (${withErrors} with errors)` : ""}`
    : "no concerns found";
  const lines = [STICKY_MARKER, `### 🔮 Hunch · ${headline} · ${complete ? "review complete" : "partial review"}`, ""];
  if (!complete) {
    lines.push("> [!CAUTION]", "> **Review is incomplete.** Some changes or guidance could not be checked.");
    for (const notice of result.notices) lines.push(`> - ${escapeCell(notice)}`);
    if (ctx.staleLock) lines.push("> - Guidance is out of date. Run `npx @kelbie/hunch compile` and commit `hunch.lock`.");
    lines.push("");
  }
  if (shown.length) {
    const short = shortPaths(shown.map(i => i[0]!.file));
    lines.push("| | Concern | Where |", "| :-: | --- | --- |");
    // One row per place in the code, like the terminal groups rows by file.
    for (const place of Map.groupBy(shown, i => JSON.stringify([i[0]!.file, i[0]!.line, i[0]!.endLine])).values()) {
      const f = place[0]![0]!;
      const range = f.endLine > f.line ? `${f.line}-${f.endLine}` : String(f.line);
      const label = code(`${short.get(f.file)}:${range}`);
      const thread = place.flat().map(x => ctx.threads?.get(findingKey(x))).find(Boolean);
      const anchor = `#L${f.line}${f.endLine > f.line ? `-L${f.endLine}` : ""}`;
      const href = thread ?? (ctx.blobBase ? `${ctx.blobBase}/${f.file.split("/").map(encodeURIComponent).join("/")}${anchor}` : undefined);
      const concerns = place.map(issue => `${place.length > 1 ? `${BADGE[isError(issue) ? "error" : "warn"]} ` : ""}${escapeCell(issue[0]!.message)}<br><sub>${issue.map(x => code(x.rule)).join(" · ")}</sub>`);
      lines.push(`| ${BADGE[place.some(isError) ? "error" : "warn"]} | ${concerns.join("<br>")} | ${href ? `[${label}](${href})` : label} |`);
    }
    lines.push("");
    if (issues.length > shown.length) lines.push(`${issues.length - shown.length} more concerns are listed in the check run.`, "");
  }
  const handled = [ctx.dismissed && `${ctx.dismissed} dismissed`, ctx.fixed && `${ctx.fixed} resolved as fixed`].filter(Boolean).join(" · ");
  if (handled) lines.push(`${handled} since earlier reviews.`, "");
  const commit = ctx.blobBase ? `[${code(ctx.blobBase.split("/").at(-1)!.slice(0, 7))}](${ctx.blobBase})` : "these changes";
  const model = result.stats.modelIds.length ? ` with ${result.stats.modelIds.map(id => escapeCell(id.slice(0, 200))).join(", ")}` : "";
  lines.push(`<sub>Reviewed ${commit}${model}. Findings are model judgments, not proven bugs.${ctx.threads ? " Resolve a comment to dismiss it. Comment <code>/hunch recheck</code> to review again." : ""}</sub>`, "");
  const guidance = complete ? result.notices : [];
  if (shown.length || guidance.length) {
    lines.push("<details>", "<summary>Review details</summary>", "");
    if (shown.length) {
      lines.push("| Rule | Source | Model result |", "| --- | --- | --- |");
      for (const issue of shown) for (const f of issue) lines.push(`| ${escapeCell(f.rule)} | ${escapeCell(f.source)} | ${escapeCell(f.evidence)} |`);
      lines.push("");
    }
    if (guidance.length) {
      lines.push("Guidance Hunch doesn't check:", "");
      for (const notice of guidance) lines.push(`- ${escapeCell(notice)}`);
      lines.push("");
    }
    lines.push("</details>");
  }
  return lines.join("\n");
}

/** Identity of a concern across revisions: a rule in a file, not a line that moves. */
export const findingKey = (f: Pick<Finding, "rule" | "file">) => `${encodeURIComponent(f.rule)} ${encodeURIComponent(f.file)}`;
const FINDING_MARKER = /<!-- hunch:finding (\S+ \S+) -->/g;
export const findingKeysIn = (body: string) => [...body.matchAll(FINDING_MARKER)].map(m => m[1]!);

/** Longer ranges (a whole new file) anchor on their first line, so the comment sits where reading starts. */
const MAX_COMMENT_RANGE = 10;

/** One inline review comment for the concerns raised at one place in the diff. */
export function reviewComment(findings: Finding[]) {
  const f = findings[0]!;
  const span = f.endLine - f.line + 1;
  const long = span > MAX_COMMENT_RANGE;
  const body = [
    ...findings.map(x => `<!-- hunch:finding ${findingKey(x)} -->`),
    ...findings.flatMap(x => [
      `${BADGE[x.level]} **Bug found:** ${escapeCell(x.message)} Hunch verified this defect in the changed code.`,
      "",
    ]),
    `<sub>🔮 Hunch${long ? ` · About lines ${f.line}-${f.endLine}` : ""} · Not relevant? Resolve this conversation and Hunch won't raise it again on this PR.</sub>`,
  ].join("\n");
  if (long || span === 1) return { path: f.file, side: "RIGHT" as const, line: f.line, body };
  return { path: f.file, side: "RIGHT" as const, start_line: f.line, start_side: "RIGHT" as const, line: f.endLine, body };
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

export interface TextOptions {
  /** ANSI colors; the CLI enables them for an interactive terminal unless NO_COLOR is set. */
  color?: boolean;
  /** Terminal width for wrapping. */
  width?: number;
}

/** Terminal report: findings grouped by file, a per-rule summary, then notes and totals. */
export function toText(result: CheckResult, { color = false, width = 100 }: TextOptions = {}): string {
  const paint = (codes: string) => (s: string) => (color ? `\x1b[${codes}m${s}\x1b[0m` : s);
  const bold = paint("1"), dim = paint("2"), red = paint("31"), yellow = paint("33"), green = paint("32"), cyan = paint("36");
  const wrap = (text: string, indent: number) => {
    const max = Math.max(40, width - indent);
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return lines.map((l) => " ".repeat(indent) + l).join("\n");
  };
  const badge = (level: Finding["level"]) => (level === "error" ? red("✖ error") : yellow("▲ warn "));
  const count = (n: number) => n.toLocaleString("en-US");
  const { findings, stats } = result;
  const errors = findings.filter((f) => f.level === "error").length;
  const out: string[] = [];

  // Files with errors first; each finding is one aligned row, and each rule's text is printed once below.
  const hasError = (fs: Finding[]) => fs.some((f) => f.level === "error");
  const files = [...Map.groupBy(findings, (f) => f.file)]
    .sort((a, b) => Number(hasError(b[1])) - Number(hasError(a[1])) || a[0].localeCompare(b[0]));
  const summary = findings.length
    ? `${plural(findings.length, "finding")} in ${plural(files.length, "file")}` +
      ` (${[errors && red(plural(errors, "error")), findings.length - errors && yellow(plural(findings.length - errors, "warning"))].filter(Boolean).join(", ")})`
    : green("no findings");
  out.push(`${bold("Hunch")} · ${summary} · ${result.complete ? green("review complete") : yellow("partial review, see notes")}`);

  const lineW = Math.max(0, ...findings.map((f) => String(f.line).length)) + 1;
  const ruleW = Math.max(0, ...findings.map((f) => f.rule.length));
  for (const [file, group] of files) {
    out.push("", bold(file));
    for (const f of group.sort((a, b) => a.line - b.line)) {
      const origin = f.source === "config" ? "" : ` · ${f.source}`;
      out.push(`  ${dim(`L${f.line}`.padEnd(lineW))}  ${badge(f.level)}  ${cyan(f.rule.padEnd(ruleW))}  ${dim(f.evidence + origin)}`);
    }
  }

  if (findings.length) {
    const rules = [...Map.groupBy(findings, (f) => f.rule)]
      .sort((a, b) => Number(hasError(b[1])) - Number(hasError(a[1])) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    out.push("", bold("Rules"));
    for (const [i, [rule, fs]] of rules.entries()) {
      if (i) out.push("");
      out.push(`  ${badge(fs[0]!.level)}  ${cyan(rule)}  ${dim(plural(fs.length, "finding"))}`);
      out.push(wrap(fs[0]!.message, 4));
    }
  }

  if (result.notices.length) {
    out.push("", bold("Notes"));
    for (const n of result.notices) out.push(yellow("  !") + wrap(n, 4).slice(3));
  }

  const models = stats.modelIds.length ? ` · ${stats.modelIds.join(", ")}` : "";
  out.push("", dim(`${plural(stats.hunks, "hunk")} · ${plural(stats.requests, "request")} · ${count(stats.inputTokens)} input tokens${models}`));
  return out.join("\n");
}

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;
const escapeCell = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\[\]`*|\\]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\r\n]/g, " ");
/** Code span safe inside a table cell; entities would show literally in code. */
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\|/g, "\\|").replace(/[\r\n]/g, " ")}\``;

/** Shortest trailing path that tells the files apart: `lib/review.ts` vs `typescript/review.ts`. */
export function shortPaths(files: string[]): Map<string, string> {
  const unique = [...new Set(files)];
  return new Map(unique.map(file => {
    const parts = file.split("/");
    for (let n = 1; n < parts.length; n++) {
      const tail = parts.slice(-n).join("/");
      if (!unique.some(other => other !== file && (other === tail || other.endsWith(`/${tail}`)))) return [file, tail];
    }
    return [file, file];
  }));
}
