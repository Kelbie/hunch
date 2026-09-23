import picomatch from "picomatch";
import { hunkContext } from "./context.js";
import { estimateTokens, type Hunk, windowHunk } from "./diff.js";
import { inScope as scopeFilter } from "./full.js";
import { isSetupError, OUTAGE_FAILURES, validateAnswers, type Answer, type JevClient, type WireQuestion } from "./jev.js";
import { localizeFinding } from "./localize.js";
import { lockRuleIds, type CompiledRule, type Lock } from "./lock.js";
import type { Config, Level, Question, RuleEntry } from "./schema.js";

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
  /** Source at the reviewed head/index/working tree, never policy from the head. */
  readChangedFile?: (path: string) => Promise<string | null>;
  onProgress?: (done: number, total: number) => void;
  /**
   * Each concern the moment a rule raises it, so a caller waiting on a long review can show what
   * has been flagged so far. These are the baseline findings: localization runs afterwards and may
   * narrow a range or split one of them, so anything shown from here is provisional until the
   * result is returned. Findings that never arrive are not absence of concern — read `complete`.
   */
  onFinding?: (finding: Finding) => void;
  /** Ask only these rule ids, to try a rule without paying for the rest. */
  only?: readonly string[];
  /**
   * Count the requests and questions this review would send, and send none. The plan walks the
   * same selection, context and batching as a review, and reports the whole need even past
   * `budget.maxRequests`, so a budget that is too small is visible before the run is paid for.
   */
  plan?: boolean;
  /** Stops the review early, as on Ctrl-C. What was found so far is returned, marked incomplete. */
  signal?: AbortSignal;
  /** A provider failure, for a caller's own diagnostics. Its text is untrusted and is never put in the result. */
  onRequestError?: (error: unknown) => void;
}

export interface CheckResult {
  findings: Finding[];
  stats: { hunks: number; skippedHunks: number; requests: number; questions: number; inputTokens: number; modelIds: string[];
    /** Requests the provider never answered, after every retry. Their rules are named in `notices`. */
    failedRequests: number };
  /** Gaps in this review: anything here means some changes or guidance weren't checked. */
  notices: string[];
  /** Standing facts about the policy, such as guidance the lock can't check. Never a gap. */
  info: string[];
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
/** Conservative ceiling on one serialized Jev request, well inside the provider's context. */
const REQUEST_CHAR_LIMIT = 80_000;
/** An answer that breaks the provider contract. Asking again would not mend it, so it fails the review. */
class ContractError extends Error {}

/** Before anything has been answered, this many failures end the review with the provider's error. */
const FIRST_FAILURES = 3;


export async function check(input: CheckInput): Promise<CheckResult> {
  const { config, client } = input;
  const reviewed = scopeFilter(config);
  const notices: string[] = [];
  const info: string[] = [];
  const stats: CheckResult["stats"] = { hunks: 0, skippedHunks: 0, requests: 0, questions: 0, inputTokens: 0, modelIds: [], failedRequests: 0 };
  const findings: Finding[] = [];
  const localization: { finding: Finding; hunk: Hunk; question: Question; state: Record<string, unknown> }[] = [];

  const deleted = input.hunks.filter((h) => h.status === "deleted" && reviewed(h.file));
  if (deleted.length) notices.push(`${deleted.length} deleted-file hunks require human review.`);
  const inScope = input.hunks.filter((h) => reviewed(h.file) && h.status !== "deleted");
  // Whole-file windows were already prepared by repoHunks, including repeated imports.
  let hunks = inScope.flatMap((h) => h.kind === "file" ? [h] : windowHunk(h, 6000, config.review.chunkLines));
  if (hunks.length > config.budget.maxHunks) {
    notices.push(`Only ${config.budget.maxHunks.toLocaleString("en-US")} of ${hunks.length.toLocaleString("en-US")} hunks were checked; raise budget.maxHunks or narrow the paths.`);
    stats.skippedHunks = hunks.length - config.budget.maxHunks;
    hunks = hunks.slice(0, config.budget.maxHunks);
  }
  stats.hunks = hunks.length;
  // The other files this change touches, so a hunk can be told what it is part of without being
  // sent their contents. A whole-file run is not a change and has no siblings to name.
  const siblings = [...new Set(inScope.filter((h) => h.kind !== "file").map((h) => h.file))];

  const referenceCache = new Map<string, Promise<string | null>>();
  const sourceCache = new Map<string, Promise<string | null>>();
  const readReference = (path: string) => {
    if (!referenceCache.has(path)) referenceCache.set(path, input.readFile?.(path) ?? Promise.resolve(null));
    return referenceCache.get(path)!;
  };

  if (!Object.keys(config.rules).length && !lockRuleIds(input.lock).length) {
    notices.push("No review rules configured. Add plain-English rules, name a pack, or install project guidance.");
  }
  for (const source of input.lock?.sources ?? []) {
    if (source.notChecked.length) info.push(`${source.id}: ${plural(source.notChecked.length, "guidance item")} can't be checked one change at a time; see notChecked in hunch.lock.`);
  }
  let incomplete = stats.skippedHunks > 0 || deleted.length > 0 || (!Object.keys(config.rules).length && !lockRuleIds(input.lock).length);
  const deadline = input.plan ? Infinity : Date.now() + config.budget.timeoutSeconds * 1000;
  const budgetSpent = () => !input.plan && (reservedRequests >= config.budget.maxRequests || Date.now() >= deadline);
  // A request that fails is set aside and asked once more after everything else, by when a brief
  // outage has usually passed. One that fails twice costs its own rules; the findings already made
  // are kept. Only a provider that has never answered fails the review outright: that is a bad key
  // or a refused policy, which no amount of further sending will fix.
  type Batch = { hunk: Hunk; state: Record<string, unknown>; rules: ActiveRule[] };
  const failed: Batch[] = [];
  let failuresInARow = 0;
  let outage = false;
  let firstError: unknown;
  const stopped = () => outage || Boolean(input.signal?.aborted);
  // Bound reader waits as well as provider calls. A slow optional reader must not consume
  // the worker's publication time after the review deadline.
  async function readWithinDeadline(read: () => Promise<string | null>): Promise<string | null> {
    if (input.plan) return read(); // a plan has no deadline to race
    if (Date.now() >= deadline) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(), new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  let reservedRequests = 0;
  let done = 0;
  await pool(hunks, config.budget.concurrency, async (hunk) => {
    if (stopped()) return;
    await checkHunk(hunk);
    if (input.signal?.aborted) return;
    done++;
    input.onProgress?.(done, hunks.length);
  });
  if (!stats.requests && firstError !== undefined && !input.signal?.aborted) throw firstError;
  const unanswered = (b: Batch) => {
    incomplete = true;
    stats.failedRequests++;
    notices.push(`${b.hunk.file}:${b.hunk.newStart}: ${plural(b.rules.length, "rule")} went unanswered because the provider request failed after retries.`);
  };
  const secondChance = failed.splice(0);
  await pool(secondChance, config.budget.concurrency, async (b) => {
    if (stopped() || budgetSpent()) return unanswered(b);
    reservedRequests++;
    try { await ask(b); }
    catch (e) {
      if (e instanceof ContractError) throw e;
      input.onRequestError?.(e);
      unanswered(b);
    }
  });
  if (done < hunks.length) {
    incomplete = true;
    notices.push(input.signal?.aborted
      ? `Review interrupted: ${plural(hunks.length - done, "hunk")} of ${hunks.length} were not checked.`
      : `The provider stopped answering (${OUTAGE_FAILURES} requests failed in a row), so ${plural(hunks.length - done, "hunk")} of ${hunks.length} were not checked. Run it again shortly.`);
  }

  // Baseline coverage always gets first use of the budget. Refinement never prunes baseline inputs.
  let localizationRequests = 0;
  for (const item of localization) {
    try {
      const narrowed = await localizeFinding({ ...item, maxLines: config.review.localizationLines,
        async evaluate(startLine, endLine) {
          if (localizationRequests >= config.review.maxLocalizationRequests || reservedRequests >= config.budget.maxRequests || Date.now() >= deadline) throw new Error("Localization budget reached");
          localizationRequests++; reservedRequests++; stats.requests++; stats.questions++;
          const focus = { startLine, endLine, lines: item.hunk.added.filter(line => line.line >= startLine && line.line <= endLine) };
          const request = { model: config.model, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), state: { ...item.state, focus }, questions: {
            q0: { ...toWire(item.question), instructions: toWire(item.question).instructions + ` Attribution: answer for the changed target lines ${startLine}–${endLine} in focus. The complete original hunk and all supplied context remain visible. Report only when these target lines participate in the concern, considering guards and counterevidence anywhere in the supplied context. Related callers, tests or vocabulary alone are not a violation. If evidence cannot be attributed to these target lines, answer no for a boolean, otherwise choose the non-reporting criterion.` },
          } };
          const res = await client.evaluate(request);
          validateAnswers(request, res.answers);
          const answer = res.answers.q0!;
          if (item.question.kind === "choice" && answer.type === "choice" && item.question.abstain.includes(answer.choice)) throw new Error("Localization needs more context");
          if (item.question.kind !== "noul" && answer.type !== "noul" && item.question.minConfidence > 0 && Object.keys(answer.probabilities).length < 2) throw new Error("Localization probabilities unavailable");
          if (item.question.kind !== "noul" && answer.type !== "noul" && answer.confidence < item.question.minConfidence) throw new Error("Localization confidence too low");
          stats.inputTokens += res.usage.inputTokens;
          if (!stats.modelIds.includes(res.modelId)) stats.modelIds.push(res.modelId);
          return judge(item.question, answer);
        },
      });
      findings.splice(findings.indexOf(item.finding), 1, ...narrowed);
    } catch {
      incomplete = true;
      item.finding.evidence += "; original range retained (localization incomplete)";
      notices.push("Baseline findings retained: requested localization could not finish within the provider, request or time budget.");
    }
  }

  /** Sends one request and records its answers. Throws, recording nothing, when the provider fails or answers out of contract. */
  async function ask({ hunk, state, rules: batch }: Batch) {
    const questions = Object.fromEntries(batch.map((r, i) => [`q${i}`, toWire(r.question)]));
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const request = { model: config.model, state, questions, signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout };
    const res = await client.evaluate(request);
    try {
      validateAnswers(request, res.answers);
      batch.forEach((rule, i) => {
        const answer = res.answers[`q${i}`];
        if (!answer || answer.type !== rule.question.kind) throw new Error("Jev returned missing or mismatched answers");
        if (rule.question.kind !== "noul" && answer.type !== "noul" && rule.question.minConfidence > 0 && Object.keys(answer.probabilities).length < 2) throw new Error("Provider omitted probabilities required by minConfidence");
      });
    } catch (e) { throw new ContractError(e instanceof Error ? e.message : String(e)); }
    stats.requests++;
    stats.questions += batch.length;
    stats.inputTokens += res.usage.inputTokens;
    if (!stats.modelIds.includes(res.modelId)) stats.modelIds.push(res.modelId);
    batch.forEach((rule, i) => {
      const answer = res.answers[`q${i}`]!;
      if (rule.question.kind === "choice" && answer.type === "choice" && rule.question.abstain.includes(answer.choice)) {
        incomplete = true;
        notices.push(`${hunk.file}:${hunk.newStart}: ${rule.id} returned insufficient context (${answer.choice}); inspect the relevant contract or caller.`);
        return;
      }
      const verdict = judge(rule.question, answer);
      if (!verdict) return;
      const firstAdded = hunk.added[0]?.line ?? hunk.newStart;
      const lastAdded = hunk.added.at(-1)?.line ?? firstAdded;
      const finding: Finding = {
        rule: rule.id,
        level: rule.level,
        file: hunk.file,
        line: Math.max(1, firstAdded),
        endLine: Math.max(1, lastAdded),
        message: rule.question.message ?? rule.question.instructions,
        evidence: verdict,
        source: rule.source,
      };
      findings.push(finding);
      input.onFinding?.(finding);
      if (config.review.localize) localization.push({ finding, hunk, question: rule.question, state });
    });
  }

  async function checkHunk(hunk: Hunk) {
    const rules = rulesFor(hunk.file, config, input.lock, input.only);

    let candidates = rules.jev.filter((r) => !r.question.when || new RegExp(r.question.when.source, r.question.when.flags).test(hunk.text));
    if (candidates.length > config.budget.maxRulesPerHunk) {
      notices.push(`${hunk.file}:${hunk.newStart}: ${candidates.length - config.budget.maxRulesPerHunk} rules skipped (budget.maxRulesPerHunk).`);
      incomplete = true;
      candidates = candidates.slice(0, config.budget.maxRulesPerHunk);
    }
    if (!candidates.length) return;
    if (budgetSpent()) {
      incomplete = true;
      notices.push("Review request/time budget reached; remaining rules were skipped.");
      return;
    }

    let surrounding: { file: string; startLine: number; endLine: number; text: string } | undefined;
    if (input.readChangedFile && config.review.contextLines > 0) {
      try {
        if (!sourceCache.has(hunk.file)) sourceCache.set(hunk.file, readWithinDeadline(() => input.readChangedFile!(hunk.file)));
        const text = await sourceCache.get(hunk.file)!;
        if (text == null || text.includes("\0") || text.length > 1_000_000) throw new Error("Unavailable source");
        const lines = text.replace(/\n$/, "").split("\n");
        if (hunk.added.some(line => lines[line.line - 1] !== line.content)) throw new Error("Source does not match patch");
        const startLine = Math.max(1, hunk.newStart - config.review.contextLines);
        const endLine = Math.min(lines.length, hunk.newStart + Math.max(1, hunk.newLines) - 1 + config.review.contextLines);
        const context = lines.slice(startLine - 1, endLine).join("\n");
        if (!context || estimateTokens(context) > 8000) throw new Error("Context unavailable or too large");
        surrounding = { file: hunk.file, startLine, endLine, text: context };
      } catch {
        incomplete = true;
        notices.push(`${hunk.file}:${hunk.newStart}: requested source context unavailable, mismatched or oversized; evaluated visible patch only.`);
      }
    }

    // One request per distinct `reference` (usually just one: none), split into as many requests
    // as the provider context budget needs. A policy with more rules than fit in one request is
    // asked over several, rather than having the excess silently dropped.
    const byRef = Map.groupBy(candidates, (r) => r.question.reference ?? "");
    for (const [ref, group] of byRef) {
      const state: Record<string, unknown> = { context: hunkContext(hunk, { siblings }), file: hunk.file, hunk: hunk.text };
      if (surrounding) state.surrounding = surrounding;
      if (config.task === "pr" && input.task) state.task = input.task.slice(0, 8000);
      if (ref) {
        if (budgetSpent()) {
          incomplete = true;
          notices.push("Review request/time budget reached; remaining rules were skipped.");
          continue;
        }
        const text = await readWithinDeadline(() => readReference(ref)).catch(() => null);
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

      for (const batch of batchWithinRequestLimit(state, group)) {
        const questions = Object.fromEntries(batch.map((r, i) => [`q${i}`, toWire(r.question)]));
        if (JSON.stringify({ state, questions }).length > REQUEST_CHAR_LIMIT) {
          // Only reachable for a single question whose own text cannot fit beside the state, so
          // one rule is dropped here rather than every rule sharing the request.
          incomplete = true;
          notices.push(`${hunk.file}:${hunk.newStart}: ${batch.map((r) => r.id).join(", ")} exceeds the request context budget; skipped.`);
          continue;
        }
        if (budgetSpent()) {
          incomplete = true;
          notices.push("Review request/time budget reached; remaining rules were skipped.");
          continue;
        }
        reservedRequests++;
        if (input.plan) {
          stats.requests++;
          stats.questions += batch.length;
          continue;
        }
        if (stopped()) continue;
        try {
          await ask({ hunk, state, rules: batch });
          failuresInARow = 0;
        } catch (e) {
          input.onRequestError?.(e);
          if (input.signal?.aborted) continue;
          firstError ??= e;
          // Not being signed in fails every request alike, so it ends the review with that error.
          if (e instanceof ContractError || isSetupError(e)) throw e;
          failed.push({ hunk, state, rules: batch });
          // A provider that has answered nothing yet gets less patience: that is a bad key or a
          // refused policy far more often than bad luck.
          if (++failuresInARow >= (stats.requests ? OUTAGE_FAILURES : FIRST_FAILURES)) outage = true;
        }
      }
    }
  }

  if (input.plan && stats.requests > config.budget.maxRequests) {
    incomplete = true;
    notices.push(`This review needs ${stats.requests} requests; budget.maxRequests is ${config.budget.maxRequests}, so the rest would be skipped. Raise the budget or narrow the paths.`);
  }
  return { findings: dedupe(findings), stats, notices: [...new Set(notices)], info, complete: !incomplete };
}

/**
 * Splits one hunk's questions into requests that each fit `REQUEST_CHAR_LIMIT`.
 *
 * The state (context, hunk, surrounding source, reference) is repeated in every request, so it is
 * charged against each batch. Batching rather than truncating is what lets a policy carry more
 * rules than fit in a single request: the extra rules cost extra requests, not lost coverage.
 * A lone question too large to sit beside the state is returned on its own, and the caller drops
 * that one rule instead of everything sharing its request.
 */
export function batchWithinRequestLimit<T extends { question: Question }>(
  state: Record<string, unknown>,
  group: readonly T[],
): T[][] {
  const overhead = JSON.stringify({ state, questions: {} }).length;
  const batches: T[][] = [];
  let batch: T[] = [];
  let size = 0;
  for (const rule of group) {
    // The serialized question plus its `"q12":` key and a separator.
    const cost = JSON.stringify(toWire(rule.question)).length + 12;
    if (batch.length && overhead + size + cost > REQUEST_CHAR_LIMIT) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(rule);
    size += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Effective rules for one file: config + presets + overrides + pack and compiled rules. `only` keeps the ids or globs it names. */
export function rulesFor(file: string, config: Config, lock?: Lock | null, only?: readonly string[]) {
  const entries = new Map(Object.entries(config.rules));
  for (const o of config.overrides) {
    if (!picomatch(o.files, { dot: true })(file)) continue;
    for (const [id, e] of Object.entries(o.rules)) {
      entries.set(id, { level: e.level, question: e.question ?? entries.get(id)?.question,
        source: e.question ? "config" : entries.get(id)?.source });
    }
  }

  const jev: ActiveRule[] = [];
  const locked = new Set(lockRuleIds(lock));
  for (const [id, e] of entries) {
    if (e.level === "off") continue;
    if (e.question?.files && !picomatch(e.question.files, { dot: true })(file)) continue;
    if (e.question) jev.push({ id, level: e.level, question: e.question, source: e.source ?? "config" });
    // A bare level re-levels a rule defined elsewhere: in the lock, or under a prefix the lock owns
    // once it is compiled. Anything else is a typo that would otherwise pass silently.
    else if (!id.includes("*") && !locked.has(id) && !/^(skill|agents-md|doc|pack)\//.test(id)) throw new Error(`rule "${id}" has no question`);
  }

  for (const rule of packPolicy(lock, entries)) {
    if (rule.level === "off") continue;
    if (rule.question.files && !picomatch(rule.question.files, { dot: true })(file)) continue;
    jev.push({ id: rule.id, level: rule.level, question: rule.question, source: rule.source });
  }

  const applicableAgentSources = (lock?.sources ?? []).filter((s) => s.kind === "agents-md" && (!s.scope || file.startsWith(`${s.scope}/`)));
  const deepestAgent = applicableAgentSources.sort((a, b) => b.scope.length - a.scope.length)[0]?.id;
  const already = new Set(jev.map((r) => r.id));
  for (const src of lock?.sources ?? []) {
    if (src.kind === "agents-md" && src.id !== deepestAgent) continue;
    if (src.scope && !(file === src.scope || file.startsWith(`${src.scope}/`))) continue;
    for (const r of src.rules.map((rule) => scoped(config, rule))) {
      if (r.appliesTo.length && !r.appliesTo.some((pattern) =>
        picomatch(pattern, { dot: true, matchBase: !pattern.includes("/") })(file))) continue;
      const level = compiledLevel(entries, r.id);
      if (level === "off" || already.has(r.id)) continue;
      jev.push({ id: r.id, level, compiled: true, source: src.id, question: compiledQuestion(r) });
    }
  }
  return { jev: only ? jev.filter((r) => matchesAny(r.id, only)) : jev };
}

/** An id or a glob, so `--only nut11/*` selects what `"nut11/*": "off"` would re-level. */
export const matchesAny = (id: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => p === id || (p.includes("*") && picomatch.isMatch(id, p)));

/**
 * The level for a rule the config did not write: the config's own entry for that id, else the most
 * specific glob entry that matches it (e.g. "skill/seo/*": "off"), else the rule's own level.
 */
function levelFor(entries: Map<string, RuleEntry>, id: string, fallback: Level): Level {
  let level = fallback;
  for (const [pat, e] of entries) if (!e.question && pat.includes("*") && picomatch.isMatch(id, pat)) level = e.level;
  return entries.get(id)?.level ?? level;
}

/** Compiled rules default to warn, because a compiler's guess about severity is not the author's. */
const compiledLevel = (entries: Map<string, RuleEntry>, id: string): Level => levelFor(entries, id, "warn");

/**
 * Rules copied from a pack into the lock. Unlike compiled rules these were written as rules by the
 * pack's author, so they keep their own level and their own question; the config can still re-level
 * or switch one off by id or glob, or replace its question entirely.
 */
function packPolicy(lock: Lock | null | undefined, entries: Map<string, RuleEntry>): PolicyRule[] {
  const rows: PolicyRule[] = [];
  for (const pack of lock?.packs ?? []) {
    for (const [id, rule] of Object.entries(pack.rules)) {
      if (entries.get(id)?.question) continue; // the config wrote its own question for this id
      rows.push({ id, level: levelFor(entries, id, rule.level), question: rule.question, source: `pack:${pack.origin}`, compiled: false });
    }
  }
  return rows;
}

/** The compiler infers `appliesTo` and `when`; `everywhere` trusts the question over that guess. */
const scoped = (config: Config, r: CompiledRule): CompiledRule =>
  config.review.compiledScope === "everywhere" ? { ...r, appliesTo: [], when: undefined } : r;

function compiledQuestion(r: CompiledRule): Question {
  return {
    kind: "noul",
    instructions: r.instructions,
    criteria: r.criteria,
    threshold: 0.75,
    message: r.message,
    ...(r.when ? { when: { source: r.when, flags: "" } } : {}),
  };
}

/** One rule as the policy defines it, before any file decides whether it applies. */
export interface PolicyRule {
  id: string;
  level: Level;
  question: Question;
  source: string;
  /** Compiled from guidance into hunch.lock, rather than written in config or a preset. */
  compiled: boolean;
  /** Compiled rules only: the directory their AGENTS.md or skill governs, and the globs they apply to. */
  scope?: string;
  appliesTo?: string[];
}

/**
 * Every rule the policy defines, whichever files it applies to, at the level config gives it —
 * including rules turned off, so a person can see what they switched off. Overrides are not applied:
 * they depend on the file, and `rulesFor` answers that question.
 */
export function policyRules(config: Config, lock?: Lock | null): PolicyRule[] {
  const entries = new Map(Object.entries(config.rules));
  const rows: PolicyRule[] = [];
  for (const [id, e] of entries) if (e.question) rows.push({ id, level: e.level, question: e.question, source: e.source ?? "config", compiled: false });
  rows.push(...packPolicy(lock, entries));
  const taken = new Set(rows.map((r) => r.id));
  for (const src of lock?.sources ?? []) {
    for (const r of src.rules.map((rule) => scoped(config, rule))) {
      if (taken.has(r.id)) continue;
      rows.push({ id: r.id, level: compiledLevel(entries, r.id), question: compiledQuestion(r), source: src.id, compiled: true, scope: src.scope || undefined, appliesTo: r.appliesTo.length ? r.appliesTo : undefined });
    }
  }
  return rows;
}

/** When a rule's answer becomes a finding, in words: the same test `judge` applies. */
export function reportCondition(q: Question): string {
  switch (q.kind) {
    case "noul": return `p(yes) ≥ ${q.threshold}`;
    case "choice": return `answer is ${q.report.join(" or ")}${q.minConfidence ? ` with confidence ≥ ${q.minConfidence}` : ""}`;
    case "score": {
      const bounds = [q.reportBelow !== undefined && `score < ${q.reportBelow}`, q.reportAbove !== undefined && `score > ${q.reportAbove}`].filter(Boolean).join(" or ");
      return `${bounds || "never"} (0 = first criterion, 1 = last)${q.minConfidence ? ` with confidence ≥ ${q.minConfidence}` : ""}`;
    }
  }
}

/**
 * Appended to every question, so that no rule has to repeat it. These are facts about the review
 * itself rather than about any one rule: what the reviewer may look at, and what it must do when the
 * hunk simply has nothing to say. Rule authors who state them anyway lose nothing; authors who
 * forget — which is most of them — no longer get confident answers drawn from imagined callers.
 */
export const JUDGING_CONTRACT =
  " Read `context` first: it says what `hunk` is, which lines are under review, and what you cannot see. Follow its \"How to answer\" rules.";

/** Absent evidence has to land somewhere, and for a yes/no rule that somewhere is "no". */
export const NO_EVIDENCE_CLAUSE =
  " Answer no if this hunk is unrelated to the question, or shows no concrete evidence either way.";

/** Used when a noul rule states no criteria, so an unqualified question still fails safe. */
export const DEFAULT_NOUL_CRITERIA = {
  true: "The visible lines give concrete evidence of exactly what the question asks about.",
  false: "They do not, the hunk is unrelated, or there is not enough visible evidence to tell.",
} as const;

export function toWire(q: Question): WireQuestion {
  switch (q.kind) {
    case "noul":
      return {
        type: "noul",
        instructions: q.instructions + JUDGING_CONTRACT + NO_EVIDENCE_CLAUSE,
        criteria: q.criteria ?? DEFAULT_NOUL_CRITERIA,
      };
    case "choice":
      return { type: "choice", instructions: q.instructions + JUDGING_CONTRACT, criteria: q.criteria };
    case "score":
      return { type: "score", instructions: q.instructions + JUDGING_CONTRACT, criteria: q.criteria };
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

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
