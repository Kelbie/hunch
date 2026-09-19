import {
  inScope,
  plainRule,
  policyRules,
  reportCondition,
  rulesFor,
  staleNotice,
  staleSources,
  toWire,
  type Config,
  type Level,
  type Lock,
  type Question,
  type RepoReader,
  type WireQuestion,
} from "../../core/src/index.js";

/**
 * `hunch config`: what the policy is, as the engine will apply it. It never edits the file — people
 * and agents do that — so its whole job is to say whether the edit worked and what each rule will
 * actually ask, before anything is spent finding out.
 */

export type RuleType = "plain" | "noul" | "choice" | "score";

export interface RuleRow {
  id: string;
  level: Level;
  type: RuleType;
  /** When an answer becomes a finding, e.g. `p(yes) ≥ 0.85`. */
  reports: string;
  files?: string[];
  when?: string;
  reference?: string;
  source: string;
  message?: string;
}

export interface ConfigReport {
  path: string;
  valid: boolean;
  settings: Pick<Config, "provider" | "model" | "zeroDataRetention" | "extends" | "include" | "ignore" | "task" | "failOnError" | "budget" | "skills" | "agentsMd" | "docs">;
  /** With `--file`: the rules asked about that file, overrides applied. Otherwise every rule. */
  rules: RuleRow[];
  overrides: { files: string[]; rules: Record<string, Level> }[];
  file?: { path: string; inScope: boolean };
  /** Anything that would make a review fail or come back incomplete. Empty when valid. */
  problems: string[];
}

export interface Explanation {
  id: string;
  level: Level;
  type: RuleType;
  source: string;
  reports: string;
  files?: string[];
  when?: string;
  /** Every state value the question is sent, and when. */
  state: { name: string; contents: string }[];
  /** Exactly what Jev receives, Hunch's closing instructions included. */
  question: WireQuestion;
  message?: string;
}

const PLAIN_PREFIX = plainRule("x").instructions.slice(0, -1);

export function ruleType(q: Question): RuleType {
  return q.kind === "noul" && q.instructions.startsWith(PLAIN_PREFIX) ? "plain" : q.kind;
}

function row(id: string, level: Level, q: Question, source: string): RuleRow {
  return {
    id, level, type: ruleType(q), reports: reportCondition(q), source,
    ...(q.files ? { files: q.files } : {}),
    ...(q.when ? { when: `/${q.when.source}/${q.when.flags}` } : {}),
    ...(q.reference ? { reference: q.reference } : {}),
    ...(q.message ? { message: q.message } : {}),
  };
}

export async function inspectConfig(loaded: { path: string; config: Config }, lock: Lock | null, repo: RepoReader, file?: string): Promise<ConfigReport> {
  const { config } = loaded;
  const problems: string[] = [];
  const all = policyRules(config, lock);
  const known = new Set(all.map((r) => r.id));

  // A level for an id nothing defines is a typo that `check` would only find mid-review.
  const levelOnly = [
    ...Object.entries(config.rules).map(([id, e]) => ({ id, e, where: "rules" })),
    ...config.overrides.flatMap((o) => Object.entries(o.rules).map(([id, e]) => ({ id, e, where: `overrides for ${o.files.join(", ")}` }))),
  ].filter(({ id, e }) => !e.question && !id.includes("*") && !known.has(id));
  for (const { id, where } of levelOnly) {
    problems.push(`"${id}" in ${where} sets a level, but no preset, config rule or compiled rule has that id.`);
  }
  const references = [...new Set(all.map((r) => r.question.reference).filter((r): r is string => Boolean(r)))];
  for (const ref of references) if ((await repo.read(ref)) === null) problems.push(`reference ${ref} does not exist; rules using it would be skipped.`);
  const stale = await staleSources(lock, config, repo);
  if (stale.length) problems.push(staleNotice(lock, stale));

  let rules: RuleRow[];
  let fileInfo: ConfigReport["file"];
  if (file) {
    const reviewed = inScope(config)(file);
    fileInfo = { path: file, inScope: reviewed };
    rules = reviewed && !levelOnly.length ? rulesFor(file, config, lock).jev.map((r) => row(r.id, r.level, r.question, r.source)) : [];
  } else {
    rules = all.map((r) => row(r.id, r.level, r.question, r.source));
  }

  const { provider, model, zeroDataRetention, extends: presets, include, ignore, task, failOnError, budget, skills, agentsMd, docs } = config;
  return {
    path: loaded.path,
    valid: problems.length === 0,
    settings: { provider, model, zeroDataRetention, extends: presets, include, ignore, task, failOnError, budget, skills, agentsMd, docs },
    rules,
    overrides: config.overrides.map((o) => ({ files: o.files, rules: Object.fromEntries(Object.entries(o.rules).map(([id, e]) => [id, e.level])) })),
    ...(fileInfo ? { file: fileInfo } : {}),
    problems,
  };
}

export function explainRule(config: Config, lock: Lock | null, id: string): Explanation {
  const rule = policyRules(config, lock).find((r) => r.id === id);
  if (!rule) {
    const ids = policyRules(config, lock).map((r) => r.id);
    throw new Error(`no rule "${id}". Rules: ${ids.join(", ") || "none"}`);
  }
  const q = rule.question;
  const state = [
    { name: "context", contents: "what the chunk is (diff or whole file), its path, language and role, the lines under review, the other files the change touches, and how to answer" },
    { name: "file", contents: "the repository-relative path" },
    { name: "hunk", contents: "the code, as a unified diff" },
    ...(config.task === "pr" ? [{ name: "task", contents: "the pull request title and description, up to 8,000 characters (check --task locally)" }] : []),
    ...(q.reference ? [{ name: "reference", contents: `${q.reference}, read from the base branch` }] : []),
  ];
  return {
    id, level: rule.level, type: ruleType(q), source: rule.source, reports: reportCondition(q),
    ...(q.files ? { files: q.files } : {}),
    ...(q.when ? { when: `/${q.when.source}/${q.when.flags}` } : {}),
    state,
    question: toWire(q),
    ...(q.message ? { message: q.message } : {}),
  };
}

/**
 * Pads columns for a terminal. A column after the first wider than `max` is cut with an ellipsis;
 * the first never is, because it holds the id people copy into `--explain` and `--only`.
 */
function table(header: string[], rows: string[][], max = 40): string {
  const cut = (s: string, i: number) => (i > 0 && s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const all = [header, ...rows].map((r) => r.map(cut));
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")}`.trimEnd()).join("\n");
}

export function configText(report: ConfigReport): string {
  const s = report.settings;
  const out: string[] = [];
  out.push(report.valid ? `${report.path} is valid.` : `${report.path} has ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}:`);
  for (const p of report.problems) out.push(`  ✗ ${p}`);
  out.push("");
  out.push(table(["SETTING", "VALUE"], [
    ["provider", `${s.provider}${s.provider === "typesafe" ? ` (${s.model})` : " (typesafe-ai/jev)"}; zero data retention ${s.zeroDataRetention ? "enforced" : "not enforced"}`],
    ["presets", s.extends.join(", ") || "none"],
    ["include", s.include.join(", ")],
    ["ignore", s.ignore.join(", ") || "nothing beyond lockfiles, minified files and node_modules"],
    ["PR context", s.task === "pr" ? "title and description sent as task" : "not sent"],
    ["failOnError", String(s.failOnError)],
    ["budget", `${s.budget.maxHunks} hunks, ${s.budget.maxRequests} requests, ${s.budget.maxRulesPerHunk} rules per hunk, ${s.budget.timeoutSeconds}s`],
    ["guidance", `${s.skills === undefined ? "any skills installed in .agents/skills or .claude/skills" : s.skills.length ? s.skills.map((k) => (typeof k === "string" ? k : k.repo)).join(", ") : "no skills"}${s.agentsMd ? ", AGENTS.md" : ""}${s.docs.length ? `, ${s.docs.join(", ")}` : ""}`],
  ], 100));
  out.push("");
  if (report.file) {
    out.push(report.file.inScope
      ? `${report.rules.length} rule${report.rules.length === 1 ? "" : "s"} asked about ${report.file.path}:`
      : `${report.file.path} is outside include/ignore, so no rule is asked about it.`);
  } else out.push(`${report.rules.length} rule${report.rules.length === 1 ? "" : "s"}:`);
  if (report.rules.length) {
    out.push(table(["RULE", "LEVEL", "TYPE", "REPORTS WHEN", "FILES", "SOURCE"], report.rules.map((r) => [
      r.id, r.level, r.type, r.reports.replace(/ \(0 = first criterion, 1 = last\)/, ""), r.files?.join(", ") ?? "all", r.source,
    ])));
  }
  if (!report.file && report.overrides.length) {
    out.push("", "Overrides:");
    for (const o of report.overrides) out.push(`  ${o.files.join(", ")}: ${Object.entries(o.rules).map(([id, l]) => `${id} ${l}`).join(", ")}`);
  }
  out.push("", "See exactly what one rule asks: hunch config --explain <rule>");
  return out.join("\n");
}

export function explanationText(e: Explanation): string {
  const out = [
    `${e.id}  ${e.level}  ${e.type}  from ${e.source}`,
    "",
    `reports when  ${e.reports}`,
    `asked about   ${e.files ? e.files.join(", ") : "every reviewed file"}${e.when ? `, only when the chunk matches ${e.when}` : ""}`,
    ...(e.message ? [`message       ${e.message}`] : []),
    "",
    "State sent with the question:",
    ...e.state.map((s) => `  ${s.name.padEnd(10)} ${s.contents}`),
    "",
    "Instructions, exactly as sent (Hunch adds the closing sentences to every rule):",
    ...wrap(e.question.instructions, 96).map((l) => `  ${l}`),
    "",
    "Criteria:",
  ];
  const q = e.question;
  if (q.type === "noul") out.push(`  yes: ${q.criteria?.true ?? ""}`, `  no:  ${q.criteria?.false ?? ""}`);
  else if (q.type === "choice") for (const [label, text] of Object.entries(q.criteria)) out.push(`  ${label}${e.reports.includes(label) ? " (reported)" : ""}: ${text}`);
  else q.criteria.forEach((text, i) => out.push(`  ${(i / (q.criteria.length - 1)).toFixed(2)}  ${text}`));
  return out.join("\n");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
