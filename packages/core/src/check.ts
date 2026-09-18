import picomatch from "picomatch";
import { estimateTokens, type Hunk, windowHunk } from "./diff.js";
import { inScope as scopeFilter } from "./full.js";
import type { Answer, JevClient, WireQuestion } from "./jev.js";
import type { Lock } from "./lock.js";
import type { Config, Level, Question } from "./schema.js";

export interface Finding {
  rule: string;
  level: Exclude<Level, "off">;
  file: string;
  line: number;
  endLine: number;
  message: string;
  /** Why it fired, e.g. `p(yes)=0.91` or `choice=debug (confidence 0.82)`. */
  evidence: string;
  /** Where the rule came from (config, preset, skill/<name>, agents-md/…). */
  source: string;
}

export interface CheckInput {
  config: Config;
  hunks: Hunk[];
  /** PR title + body; sent as `task` when config.task === "pr". */
  task?: string;
  lock?: Lock | null;
  client: JevClient;
  /** Reads repo files for `reference:` (from the base ref). */
  readFile?: (path: string) => Promise<string | null>;
  onProgress?: (done: number, total: number) => void;
}

export interface CheckResult {
  findings: Finding[];
  stats: { hunks: number; skippedHunks: number; requests: number; questions: number; inputTokens: number; modelIds: string[] };
  notices: string[];
  /** Partial review never means a clean bill of health. */
  complete: boolean;
}

interface ActiveRule {
  id: string;
  level: Exclude<Level, "off">;
  question: Question;
  source: string;
  appliesTo?: string[];
  compiled?: boolean;
}

const REFERENCE_TOKEN_LIMIT = 8000;


export async function check(input: CheckInput): Promise<CheckResult> {
  const { config, client } = input;
  const reviewed = scopeFilter(config);
  const notices: string[] = [];
  const stats: CheckResult["stats"] = { hunks: 0, skippedHunks: 0, requests: 0, questions: 0, inputTokens: 0, modelIds: [] };
  const findings: Finding[] = [];

  const deleted = input.hunks.filter((h) => h.status === "deleted" && reviewed(h.file));
  if (deleted.length) notices.push(`${deleted.length} deleted-file hunks require human review.`);
  const inScope = input.hunks.filter((h) => reviewed(h.file) && h.status !== "deleted");
  let hunks = inScope.flatMap((h) => windowHunk(h));
  if (hunks.length > config.budget.maxHunks) {
    notices.push(`Only ${config.budget.maxHunks.toLocaleString("en-US")} of ${hunks.length.toLocaleString("en-US")} hunks were checked; raise budget.maxHunks or narrow the paths.`);
    stats.skippedHunks = hunks.length - config.budget.maxHunks;
    hunks = hunks.slice(0, config.budget.maxHunks);
  }
  stats.hunks = hunks.length;

  const referenceCache = new Map<string, Promise<string | null>>();
  const readReference = (path: string) => {
    if (!referenceCache.has(path)) referenceCache.set(path, input.readFile?.(path) ?? Promise.resolve(null));
    return referenceCache.get(path)!;
  };

  if (!Object.keys(config.rules).length && !input.lock?.sources.some((s) => s.rules.length)) {
    notices.push("No review rules configured. Add plain-English rules or compile project guidance.");
  }
  for (const source of input.lock?.sources ?? []) {
    if (source.notChecked.length) notices.push(`${source.id}: ${source.notChecked.length} guidance item(s) require human review (see hunch.lock).`);
  }
  let incomplete = stats.skippedHunks > 0 || deleted.length > 0 || (!Object.keys(config.rules).length && !input.lock?.sources.some((s) => s.rules.length));
  const deadline = Date.now() + config.budget.timeoutSeconds * 1000;
  let reservedRequests = 0;
  let done = 0;
  await pool(hunks, config.budget.concurrency, async (hunk) => {
    await checkHunk(hunk);
    input.onProgress?.(++done, hunks.length);
  });

  async function checkHunk(hunk: Hunk) {
    const rules = rulesFor(hunk.file, config, input.lock);

    let candidates = rules.jev.filter((r) => !r.question.when || new RegExp(r.question.when.source, r.question.when.flags).test(hunk.text));
    if (candidates.length > config.budget.maxRulesPerHunk) {
      notices.push(`${hunk.file}:${hunk.newStart}: ${candidates.length - config.budget.maxRulesPerHunk} rules skipped (budget.maxRulesPerHunk).`);
      incomplete = true;
      candidates = candidates.slice(0, config.budget.maxRulesPerHunk);
    }
    if (!candidates.length) return;

    // One request per distinct `reference` (usually just one: none).
    const byRef = Map.groupBy(candidates, (r) => r.question.reference ?? "");
    for (const [ref, group] of byRef) {
      if (reservedRequests >= config.budget.maxRequests || Date.now() >= deadline) {
        incomplete = true;
        notices.push("Review request/time budget reached; remaining rules were skipped.");
        continue;
      }
      reservedRequests++;
      const state: Record<string, unknown> = { file: hunk.file, hunk: hunk.text };
      if (config.task === "pr" && input.task) state.task = input.task.slice(0, 8000);
      if (ref) {
        const text = await readReference(ref);
        if (text == null) {
          incomplete = true;
          notices.push(`reference file ${ref} not found; rules using it were skipped.`);
          continue;
        }
        if (estimateTokens(text) > REFERENCE_TOKEN_LIMIT) {
          incomplete = true;
          notices.push(`reference ${ref} exceeds the context budget; rules using it were skipped.`);
          continue;
        }
        state.reference = text;
      }
      const questions = Object.fromEntries(group.map((r, i) => [`q${i}`, toWire(r.question)]));
      if (JSON.stringify({ state, questions }).length > 80_000) {
        incomplete = true;
        notices.push(`${hunk.file}:${hunk.newStart}: request exceeds conservative context budget; rules skipped.`);
        continue;
      }
      const res = await client.evaluate({ model: config.model, state, questions });
      stats.requests++;
      stats.questions += group.length;
      stats.inputTokens += res.usage.inputTokens;
      if (!stats.modelIds.includes(res.modelId)) stats.modelIds.push(res.modelId);
      group.forEach((rule, i) => {
        const answer = res.answers[`q${i}`];
        if (!answer || answer.type !== rule.question.kind) throw new Error("Jev returned missing or mismatched answers");
        if (rule.question.kind !== "noul" && answer.type !== "noul" && rule.question.minConfidence > 0 && Object.keys(answer.probabilities).length < 2) throw new Error("Provider omitted probabilities required by minConfidence");
        const verdict = judge(rule.question, answer);
        if (!verdict) return;
        const firstAdded = hunk.added[0]?.line ?? hunk.newStart;
        const lastAdded = hunk.added.at(-1)?.line ?? firstAdded;
        findings.push({
          rule: rule.id,
          level: rule.level,
          file: hunk.file,
          line: Math.max(1, firstAdded),
          endLine: Math.max(1, lastAdded),
          message: rule.question.message ?? rule.question.instructions,
          evidence: verdict,
          source: rule.source,
        });
      });
    }
  }

  return { findings: dedupe(findings), stats, notices: [...new Set(notices)], complete: !incomplete };
}

/** Effective rules for one file: config + presets + overrides + compiled skill rules. */
export function rulesFor(file: string, config: Config, lock?: Lock | null) {
  const entries = new Map(Object.entries(config.rules));
  for (const o of config.overrides) {
    if (!picomatch(o.files, { dot: true })(file)) continue;
    for (const [id, e] of Object.entries(o.rules)) {
      entries.set(id, { level: e.level, question: e.question ?? entries.get(id)?.question,
        source: e.question ? "config" : entries.get(id)?.source });
    }
  }

  const jev: ActiveRule[] = [];
  for (const [id, e] of entries) {
    if (e.level === "off") continue;
    if (e.question?.files && !picomatch(e.question.files, { dot: true })(file)) continue;
    if (e.question) jev.push({ id, level: e.level, question: e.question, source: e.source ?? "config" });
    else if (!id.includes("*") && !/^(skill|agents-md|doc)\//.test(id)) throw new Error(`rule "${id}" has no question`);
  }

  // Compiled rules default to warn; config may re-level them by id or glob
  // (e.g. "skill/seo/*": "off").
  const levelPatterns = [...entries].filter(([id, e]) => !e.question && id.includes("*"));
  const applicableAgentSources = (lock?.sources ?? []).filter((s) => s.kind === "agents-md" && (!s.scope || file.startsWith(`${s.scope}/`)));
  const deepestAgent = applicableAgentSources.sort((a, b) => b.scope.length - a.scope.length)[0]?.id;
  for (const src of lock?.sources ?? []) {
    if (src.kind === "agents-md" && src.id !== deepestAgent) continue;
    if (src.scope && !(file === src.scope || file.startsWith(`${src.scope}/`))) continue;
    for (const r of src.rules) {
      if (r.appliesTo.length && !picomatch(r.appliesTo, { dot: true, matchBase: true })(file)) continue;
      let level: Level = "warn";
      for (const [pat, e] of levelPatterns) if (picomatch.isMatch(r.id, pat)) level = e.level;
      level = entries.get(r.id)?.level ?? level;
      if (level === "off" || entries.get(r.id)?.question) continue;
      jev.push({
        id: r.id,
        level,
        compiled: true,
        source: src.id,
        question: {
          kind: "noul",
          instructions: r.instructions,
          criteria: r.criteria,
          threshold: 0.75,
          message: r.message,
          ...(r.when ? { when: { source: r.when, flags: "" } } : {}),
        },
      });
    }
  }
  return { jev };
}

export function toWire(q: Question): WireQuestion {
  switch (q.kind) {
    case "noul":
      return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: q.criteria };
    case "score":
      return { type: "score", instructions: q.instructions, criteria: q.criteria };
  }
}

/** Returns evidence text when the answer should be reported, else null. */
export function judge(q: Question, a: Answer): string | null {
  if (q.kind === "noul" && a.type === "noul") {
    return a.p >= q.threshold ? `p(yes)=${a.p.toFixed(2)} ≥ ${q.threshold}` : null;
  }
  if (q.kind === "choice" && a.type === "choice") {
    if (!q.report.includes(a.choice) || a.confidence < q.minConfidence) return null;
    return `choice=${a.choice} (confidence ${a.confidence.toFixed(2)})`;
  }
  if (q.kind === "score" && a.type === "score") {
    if (a.confidence < q.minConfidence) return null;
    const norm = a.score / (q.criteria.length - 1);
    const level = q.criteria[Math.round(a.score)] ?? "";
    if (q.reportBelow !== undefined && norm < q.reportBelow) return `score ${norm.toFixed(2)} < ${q.reportBelow}: ${level}`;
    if (q.reportAbove !== undefined && norm > q.reportAbove) return `score ${norm.toFixed(2)} > ${q.reportAbove}: ${level}`;
    return null;
  }
  return null;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings
    .filter((f) => {
      const key = `${f.rule}|${f.file}|${f.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}
