import type { CheckResult, Finding } from "./check.js";
import type { Hunk } from "./diff.js";

/** Hidden marker so the app/action updates one comment instead of posting new ones. */
export const STICKY_MARKER = "<!-- hunch:summary -->";

export interface ReportContext {
  /** Links findings to `blob/<sha>/<file>#L<line>` when set. */
  blobBase?: string;
  staleLock?: boolean;
  /** Inline review thread per `threadKey`; preferred over blob links. */
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
    if (ctx.staleLock) lines.push("> - The policy in `hunch.lock` is out of date. Run `npx @kelbie/hunch install` and commit it.");
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
      // Prefer the thread at this place: one rule can be raised at several places in a file.
      const thread = place.flat().map(x => ctx.threads?.get(threadKey(x))).find(Boolean);
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
  const guidance = result.info ?? [];
  const { hunks, questions, requests } = result.stats;
  if (shown.length || guidance.length || hunks) {
    lines.push("<details>", "<summary>Review details</summary>", "");
    const n = (count: number, noun: string) => `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
    if (hunks) lines.push(questions ? `Asked ${n(questions, "question")} in ${n(requests, "request")}, across ${n(hunks, "hunk")} in scope.` : `No rule applied to the ${n(hunks, "hunk")} in scope, so nothing was asked.`, "");
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

/** The line an inline comment for this finding is anchored to (see `reviewComment`). */
export const anchorLine = (f: Pick<Finding, "line" | "endLine">) => f.endLine - f.line + 1 > MAX_COMMENT_RANGE ? f.line : f.endLine;
/** A finding's concern at one place: the thread GitHub shows on that line. */
export const threadKey = (f: Pick<Finding, "rule" | "file" | "line" | "endLine">) => `${findingKey(f)}@${anchorLine(f)}`;

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
      `${BADGE[x.level]} **${x.level === "error" ? "Error" : "Warning"}:** ${escapeCell(x.message)}`,
      "",
      `<sub>${code(x.rule)} · ${escapeCell(x.evidence)} · from ${escapeCell(x.source)}</sub>`,
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
  /** Reviewed hunks; when set, each place shows the diff around its lines. */
  hunks?: Hunk[];
}

/** One line of a diff excerpt: `+`, `-` or ` `, with its line number in the new file (none for removed lines). */
export interface ExcerptLine { kind: "+" | "-" | " "; line?: number; text: string }

/**
 * The changed lines a finding points at, from the hunk that contains them, with
 * `context` unchanged lines around them. Long ranges keep their start and say how
 * many lines were left out.
 */
export function diffExcerpt(hunks: Hunk[], f: Pick<Finding, "file" | "line" | "endLine">, { context = 3, maxLines = 16 } = {}): { lines: ExcerptLine[]; omitted: number } | undefined {
  const hunk = hunks.find(h => h.file === f.file && h.newStart <= f.line && f.line < h.newStart + Math.max(h.newLines, 1));
  if (!hunk) return undefined;
  const all: ExcerptLine[] = [];
  let next = hunk.newStart;
  for (const raw of hunk.text.split("\n").slice(1)) {
    const kind = raw[0] === "+" || raw[0] === "-" ? raw[0] : " ";
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    all.push({ kind, ...(kind === "-" ? {} : { line: next++ }), text: raw.slice(1) });
  }
  const at = (i: number) => all[i]!.line ?? all.slice(i).find(l => l.line)?.line ?? next;
  let start = all.findIndex((l, i) => at(i) >= f.line && l.kind !== " ");
  if (start < 0) start = all.findIndex((_, i) => at(i) >= f.line);
  if (start < 0) return undefined;
  let end = start;
  for (let i = start; i < all.length; i++) if (all[i]!.kind !== " " && at(i) <= f.endLine) end = i;
  // Removed lines just before the first changed line belong to the change.
  while (start > 0 && all[start - 1]!.kind === "-") start--;
  const from = Math.max(0, start - context), to = Math.min(all.length - 1, end + context);
  const span = all.slice(from, to + 1);
  return span.length > maxLines ? { lines: span.slice(0, maxLines), omitted: span.length - maxLines } : { lines: span, omitted: 0 };
}

/**
 * Terminal report: findings grouped by file, then by place. Every concern shows its
 * line range and message, so a reader (or an agent) can act on it without the PR;
 * `hunks` adds the diff around each place. A per-rule tally, notes and totals follow.
 */
export function toText(result: CheckResult, { color = false, width = 100, hunks }: TextOptions = {}): string {
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

  // Files with errors first; within a file, places in line order, errors first at each place.
  const hasError = (fs: Finding[]) => fs.some((f) => f.level === "error");
  const files = [...Map.groupBy(findings, (f) => f.file)]
    .sort((a, b) => Number(hasError(b[1])) - Number(hasError(a[1])) || a[0].localeCompare(b[0]));
  const summary = findings.length
    ? `${plural(findings.length, "finding")} in ${plural(files.length, "file")}` +
      ` (${[errors && red(plural(errors, "error")), findings.length - errors && yellow(plural(findings.length - errors, "warning"))].filter(Boolean).join(", ")})`
    : green("no findings");
  out.push(`${bold("Hunch")} · ${summary} · ${result.complete ? green("review complete") : yellow("partial review, see notes")}`);

  const range = (f: Finding) => (f.endLine > f.line ? `L${f.line}-${f.endLine}` : `L${f.line}`);
  const lineW = Math.max(0, ...findings.map((f) => range(f).length));
  const ruleW = Math.max(0, ...findings.map((f) => f.rule.length));
  const indent = 2 + lineW + 2;
  for (const [file, group] of files) {
    out.push("", bold(file));
    const places = [...Map.groupBy(group, (f) => `${f.line}-${f.endLine}`).values()].sort((a, b) => a[0]!.line - b[0]!.line);
    for (const [p, place] of places.entries()) {
      if (p && (hunks || place.length > 1 || places[p - 1]!.length > 1)) out.push("");
      place.sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));
      for (const [i, f] of place.entries()) {
        const origin = f.source === "config" ? "" : ` · ${f.source}`;
        out.push(`  ${dim((i ? "" : range(f)).padEnd(lineW))}  ${badge(f.level)}  ${cyan(f.rule.padEnd(ruleW))}  ${dim(f.evidence + origin)}`);
        out.push(wrap(f.message, indent));
      }
      const excerpt = hunks && diffExcerpt(hunks, place[0]!);
      if (excerpt) {
        const numW = Math.max(...excerpt.lines.map((l) => String(l.line ?? "").length), 1);
        for (const l of excerpt.lines) {
          // Code is never cut: an agent reading this needs the whole line.
          const text = `${l.kind} ${l.text}`;
          const body = l.kind === "+" ? green(text) : l.kind === "-" ? red(text) : dim(text);
          out.push(`${" ".repeat(indent)}${dim(`${String(l.line ?? "").padStart(numW)} │`)} ${body}`);
        }
        if (excerpt.omitted) out.push(`${" ".repeat(indent)}${dim(`${" ".repeat(numW)} │ … ${plural(excerpt.omitted, "more line")}`)}`);
      }
    }
  }

  if (findings.length) {
    const rules = [...Map.groupBy(findings, (f) => f.rule)]
      .sort((a, b) => Number(hasError(b[1])) - Number(hasError(a[1])) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    out.push("", bold("Rules"));
    const w = Math.max(...rules.map(([rule]) => rule.length));
    for (const [rule, fs] of rules) out.push(`  ${badge(fs[0]!.level)}  ${cyan(rule.padEnd(w))}  ${dim(plural(fs.length, "finding"))}`);
  }

  // Gaps get a warning mark; standing facts about the policy are dimmed.
  const info = result.info ?? [];
  if (result.notices.length || info.length) {
    out.push("", bold("Notes"));
    for (const n of result.notices) out.push(yellow("  !") + wrap(n, 4).slice(3));
    for (const n of info) out.push(dim("  ·" + wrap(n, 4).slice(3)));
  }

  const models = stats.modelIds.length ? ` · ${stats.modelIds.join(", ")}` : "";
  out.push("", dim(`${plural(stats.hunks, "hunk")} · ${plural(stats.requests, "request")} · ${count(stats.inputTokens)} input tokens${models}`));
  return out.join("\n");
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
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
