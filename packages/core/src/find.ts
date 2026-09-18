import { describeChunk, languageOf, roleOf } from "./context.js";
import type { Hunk } from "./diff.js";
import type { Answer, JevClient } from "./jev.js";

/**
 * Semantic retrieval: score every chunk of a repository against a task, and return the ones a
 * person — or a larger model — would want open before starting it.
 *
 * This is not review. Nothing is judged and nothing passes or fails; each chunk is asked how it
 * relates to the task, and the answers are a ranking. Jev answers one request per chunk in
 * milliseconds, so asking the whole repository is cheaper than guessing at a grep.
 */

/**
 * The ways a chunk can matter to a task. They are asked together — cost is per request, not per
 * question — and each is reported separately, because "show me the tests" and "show me where to
 * type" are different questions that a single relevance score would blur into one.
 */
export const FACETS = ["edit", "contract", "caller", "test", "precedent"] as const;
export type Facet = (typeof FACETS)[number];

/** Ties break towards the facet that gets someone started fastest. */
const PRIORITY: Facet[] = ["edit", "contract", "caller", "test", "precedent"];

/** Each facet in one line, so a document can explain its own headings to whoever reads it. */
export const FACET_QUESTION: Record<Facet, string> = {
  edit: "Code that carrying out the task would require editing.",
  contract: "Definitions the task hinges on — the value, limit, type or interface the new code must read or satisfy.",
  caller: "Code that consumes the behaviour the task changes, and would see the difference.",
  test: "Tests of the area, which would need updating or would catch a mistake made while doing the task.",
  precedent: "Existing solutions to the same kind of problem, as a pattern to follow.",
};

export const FACET_LABEL: Record<Facet, string> = {
  edit: "edit here",
  contract: "contract to respect",
  caller: "affected caller",
  test: "test to update",
  precedent: "pattern to follow",
};

interface FacetQuestion { instructions: string; criteria: { true: string; false: string } }

const QUESTIONS: Record<Facet, FacetQuestion> = {
  edit: {
    instructions: "Would carrying out `task` require editing the code shown in `hunk`?",
    criteria: {
      true: "This code implements, renders, computes or decides the behaviour `task` changes. Someone doing `task` would open this file and change these lines.",
      false: "The code is about something else, or it only mentions the same words while doing unrelated work.",
    },
  },
  contract: {
    instructions: "Does `hunk` define the specific value, limit, type, schema or interface that `task` turns on — the thing the new code would have to read or satisfy to work at all?",
    criteria: {
      true: "Without this declaration `task` could not be implemented correctly: it is where the bound, unit, shape, option or route that `task` depends on is actually defined.",
      false: "It is merely nearby infrastructure, a general-purpose type, or something `task` could be implemented without ever reading. Broad relevance is not enough — this facet is for the definition `task` hinges on.",
    },
  },
  caller: {
    instructions: "Does `hunk` call, render, navigate to or otherwise consume the behaviour that `task` would change, so that it would see the difference?",
    criteria: {
      true: "It uses the screen, function, hook, store or value that `task` changes, and would behave differently or need updating once `task` is done.",
      false: "It does not reach that behaviour, or it is the implementation rather than a consumer of it.",
    },
  },
  test: {
    instructions: "Does `hunk` test or exercise the screen, function or flow that `task` would change — so that it would need updating, or would catch a mistake made while doing `task`?",
    criteria: {
      true: "It asserts on, drives or provides fixtures for that area, including its edge cases and error paths. `task` has not been done yet, so a test of the surrounding behaviour counts; a test of the new behaviour cannot exist.",
      false: "It tests something else, or it is not a test at all.",
    },
  },
  precedent: {
    instructions: "Does `hunk` already solve the same kind of problem `task` describes, somewhere else in the codebase, closely enough to show the pattern to follow?",
    criteria: {
      true: "It is an existing, working example of the same kind of work — the same sort of validation, warning, limit, screen or flow — that someone doing `task` would copy the shape of.",
      false: "It is the place `task` changes rather than a precedent for it, or it solves a different kind of problem.",
    },
  },
};

export interface FindMatch {
  file: string;
  startLine: number;
  endLine: number;
  /** The chunk's source lines, with the diff markers stripped. */
  code: string;
  language: string | null;
  role: ReturnType<typeof roleOf>;
  /** Highest-scoring facet: what this chunk is to the task. */
  facet: Facet;
  /** That facet's probability; the ranking key. */
  score: number;
  /** Every facet's probability, so a caller can filter on one it cares about. */
  facets: Record<Facet, number>;
}

export interface FindResult {
  matches: FindMatch[];
  stats: { chunks: number; scored: number; requests: number; inputTokens: number; modelIds: string[] };
  /** Anything that stopped this from being a complete sweep. */
  notices: string[];
  complete: boolean;
}

export interface FindInput {
  /** What the person wants to do, in their own words. */
  task: string;
  /** Whole-file chunks, as `repoHunks` produces them. */
  hunks: Hunk[];
  client: JevClient;
  model: string;
  /** Only these facets are asked. Fewer facets do not cost less; they only narrow the answer. */
  facets?: readonly Facet[];
  /** Chunks scoring below this on every asked facet are dropped. */
  minScore?: number;
  /** Keep at most this many matches of each facet. Omit to keep every match above `minScore`. */
  perFacet?: number;
  budget?: { concurrency?: number; maxRequests?: number; timeoutSeconds?: number };
  onProgress?: (done: number, total: number) => void;
}

const TASK_LIMIT = 4000;

export async function find(input: FindInput): Promise<FindResult> {
  const facets = input.facets?.length ? [...input.facets] : [...FACETS];
  const minScore = input.minScore ?? 0.5;
  const concurrency = input.budget?.concurrency ?? 8;
  const maxRequests = input.budget?.maxRequests ?? 10_000;
  const deadline = Date.now() + (input.budget?.timeoutSeconds ?? 900) * 1000;
  const task = input.task.trim().slice(0, TASK_LIMIT);
  if (!task) throw new Error("find needs a task to search for");

  const matches: FindMatch[] = [];
  const notices: string[] = [];
  const stats: FindResult["stats"] = { chunks: input.hunks.length, scored: 0, requests: 0, inputTokens: 0, modelIds: [] };
  let started = 0;
  let stopped = false;
  let done = 0;
  const failures: string[] = [];

  const questions = Object.fromEntries(facets.map((f) => [f, { type: "noul" as const, instructions: QUESTIONS[f].instructions + ASKING_CONTRACT, criteria: QUESTIONS[f].criteria }]));

  await pool(input.hunks, concurrency, async (hunk) => {
    if (started >= maxRequests || Date.now() >= deadline) { stopped = true; return; }
    started++;
    // A sweep is thousands of requests; one rate-limited chunk must not discard the other 4,000.
    // The chunk is recorded as unsearched instead, which is what it is.
    let res;
    try {
      res = await input.client.evaluate({
        model: input.model,
        state: { context: findContext(hunk), task, file: hunk.file, hunk: hunk.text },
        questions,
      });
    } catch (error) {
      failures.push(`${hunk.file}:${hunk.newStart} (${(error as Error).message})`);
      input.onProgress?.(++done, input.hunks.length);
      return;
    }
    stats.requests++;
    stats.scored++;
    stats.inputTokens += res.usage.inputTokens;
    if (!stats.modelIds.includes(res.modelId)) stats.modelIds.push(res.modelId);
    const scores = Object.fromEntries(facets.map((f) => [f, probabilityOf(res.answers[f])])) as Record<Facet, number>;
    const best = facets.reduce((a, b) => (scores[b]! > scores[a]! || (scores[b] === scores[a] && PRIORITY.indexOf(b) < PRIORITY.indexOf(a)) ? b : a));
    if (scores[best]! >= minScore) {
      matches.push({
        file: hunk.file,
        startLine: hunk.newStart,
        endLine: hunk.newStart + Math.max(hunk.newLines, 1) - 1,
        code: bodyOf(hunk),
        language: languageOf(hunk.file),
        role: roleOf(hunk.file),
        facet: best,
        score: scores[best]!,
        facets: { ...emptyScores(), ...scores },
      });
    }
    input.onProgress?.(++done, input.hunks.length);
  });

  if (stopped) notices.push(`Stopped after ${stats.scored} of ${input.hunks.length} chunks: the request or time budget ran out, so the rest of the repository was never searched.`);
  if (failures.length) notices.push(`${failures.length} chunk(s) could not be searched: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? ", and more" : ""}.`);
  matches.sort(byScore);
  return { matches: input.perFacet ? topPerFacet(matches, input.perFacet) : matches, stats, notices, complete: !stopped && !failures.length };
}

const byScore = (a: FindMatch, b: FindMatch) => b.score - a.score || a.file.localeCompare(b.file) || a.startLine - b.startLine;

/**
 * Keep the best `n` of each facet rather than the best `n` overall. The facets do not share a
 * scale — "is this the definition the task hinges on" is an easier yes than "would you edit this" —
 * so one global cut lets the generous facet crowd the others out entirely, and the single test
 * worth updating never appears. Asking each facet for its own best answers is the point of having
 * facets at all.
 */
export function topPerFacet(matches: FindMatch[], n: number): FindMatch[] {
  const kept: FindMatch[] = [];
  for (const facet of FACETS) kept.push(...matches.filter((m) => m.facet === facet).slice(0, n));
  return kept.sort(byScore);
}

/** A missing or wrong-shaped answer is a transport failure, and scores zero rather than guessing. */
function probabilityOf(answer: Answer | undefined): number {
  return answer?.type === "noul" ? answer.p : 0;
}

const emptyScores = (): Record<Facet, number> => Object.fromEntries(FACETS.map((f) => [f, 0])) as Record<Facet, number>;

/**
 * Retrieval's own closing instruction. It is the opposite of review's: nothing here is a defect,
 * so a chunk that is merely *near* the task should still say no — a hundred plausible files are
 * worth less to the reader than ten that actually matter.
 */
const ASKING_CONTRACT =
  " `task` is what someone wants to do next; it has not been done yet, so do not look for it in the code. Read `context` for what `hunk` is. Nothing here is a defect and nothing is being judged — the only question is whether this code would be worth reading before starting `task`. Answer no for code that merely shares vocabulary with `task` while doing unrelated work, and no when you are unsure.";

/** The framing for retrieval: what the chunk is, then what is being looked for and why. */
export function findContext(hunk: Hunk): string {
  return [
    ...describeChunk(hunk),
    "",
    "Why you are reading it:",
    "- `task` describes a change someone is about to make to this codebase. It has not been made yet.",
    "- You are not reviewing this code, finding bugs in it, or judging it. You are deciding whether someone doing `task` would want this code in front of them.",
    "- Nothing else is visible to you: not the rest of this file, not its callers, not any other file. Judge this chunk on what it plainly does.",
    "- Shared words are not relevance. A file that says \"amount\" while `task` says \"amount\" is relevant only if it does something `task` touches.",
  ].join("\n");
}

/**
 * Exactly the source between the chunk's stated line numbers, markers removed.
 *
 * Only the `+` lines: a whole-file chunk after the first repeats the file's import block as
 * unchanged context, which helps a reviewer read it but would make the quoted code disagree with
 * the range printed above it. A reader who trusts that range — a person or a model citing a line —
 * has to get back what it says.
 */
export function bodyOf(hunk: Hunk): string {
  return hunk.text
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .join("\n");
}

/**
 * Chunks of the same file that touch are one passage, so they are printed as one. A file split at
 * line 150 for budgeting reasons is not three findings, and three fenced blocks with a heading
 * between them read as three unrelated excerpts to anyone — or anything — downstream.
 */
export function mergeAdjacent(matches: FindMatch[]): FindMatch[] {
  const merged: FindMatch[] = [];
  for (const m of [...matches].sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine)) {
    const last = merged.at(-1);
    if (last && last.file === m.file && m.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, m.endLine);
      last.code = `${last.code}\n${m.code}`;
      last.score = Math.max(last.score, m.score);
      for (const f of FACETS) last.facets[f] = Math.max(last.facets[f], m.facets[f]);
      continue;
    }
    merged.push({ ...m, facets: { ...m.facets } });
  }
  return merged.sort(byScore);
}

/** Matches as one Markdown document, which is the point: paste it into a larger model. */
export function findMarkdown(task: string, result: FindResult, existing = ""): string {
  const out = [
    `# Code relevant to: ${task}`,
    "",
    "Chunks of this repository, ranked by how they relate to that task by a classifier that read",
    "each one in isolation. Headings give the exact file and line range of the code beneath them.",
    "Scores are the classifier's probability, not a guarantee: treat the grouping as the signal and",
    "verify anything you rely on. This is a starting point — relevant code may be missing, and",
    "nothing here has been checked for correctness.",
    "",
  ];
  // Above the file list on purpose: if this work already exists, the file list is beside the point.
  if (existing) out.push(existing, "");
  const groups = FACETS.map((facet) => ({ facet, matches: mergeAdjacent(result.matches.filter((m) => m.facet === facet)) })).filter((g) => g.matches.length);
  if (!groups.length) out.push("No chunk scored above the threshold.", "");

  if (groups.length) {
    out.push("## What was found", "");
    for (const { facet, matches } of groups) {
      out.push(`- **${FACET_LABEL[facet]}** — ${FACET_QUESTION[facet]}`);
      for (const m of matches) out.push(`  - \`${m.file}\`:${m.startLine}-${m.endLine} (${m.score.toFixed(2)})`);
    }
    out.push("");
  }
  for (const notice of result.notices) out.push(`> **Incomplete:** ${notice}`, "");
  if (!result.complete && !result.notices.length) out.push("> **Incomplete:** some of the repository was not searched.", "");

  for (const { facet, matches } of groups) {
    out.push(`## ${FACET_LABEL[facet]}`, "", `${FACET_QUESTION[facet]}`, "");
    for (const m of matches) {
      out.push(`### \`${m.file}\`:${m.startLine}-${m.endLine}`, "");
      out.push(`${FACET_LABEL[facet]} ${m.score.toFixed(2)}${otherFacets(m, facet)}${m.role ? ` · ${m.role} file` : ""}`, "");
      out.push("```" + (fence(m.language) ?? ""), m.code, "```", "");
    }
  }
  return out.join("\n").trimEnd();
}

/** The runners-up, so a reader can see a chunk that is nearly as much one thing as another. */
function otherFacets(m: FindMatch, chosen: Facet): string {
  const rest = FACETS.filter((f) => f !== chosen && m.facets[f] >= 0.4).map((f) => `${FACET_LABEL[f]} ${m.facets[f].toFixed(2)}`);
  return rest.length ? ` · also ${rest.join(", ")}` : "";
}

const FENCE: Record<string, string> = {
  "TypeScript": "ts", "TypeScript JSX": "tsx", "JavaScript": "js", "JavaScript JSX": "jsx",
  "Rust": "rust", "Python": "python", "Go": "go", "Ruby": "ruby", "Java": "java", "Kotlin": "kotlin",
  "Swift": "swift", "C": "c", "C++": "cpp", "C#": "csharp", "PHP": "php", "shell": "bash",
  "JSON": "json", "YAML": "yaml", "TOML": "toml", "SQL": "sql", "Markdown": "markdown",
};
const fence = (language: string | null) => (language ? FENCE[language] : undefined);

/** One line per match, densest first. */
export function findText(result: FindResult, existing = ""): string {
  const out: string[] = existing ? [existing] : [];
  for (const facet of FACETS) {
    const group = result.matches.filter((m) => m.facet === facet);
    if (!group.length) continue;
    out.push(`${FACET_LABEL[facet]}:`);
    for (const m of group) out.push(`  ${m.score.toFixed(2)}  ${m.file}:${m.startLine}-${m.endLine}`);
    out.push("");
  }
  const counted = FACETS.map((f) => ({ f, n: result.matches.filter((m) => m.facet === f).length })).filter((c) => c.n);
  return [
    ...out,
    `${result.matches.length} of ${result.stats.scored} chunks: ${counted.map((c) => `${c.n} ${FACET_LABEL[c.f]}`).join(", ") || "none"}.`,
    ...result.notices.map((n) => `! ${n}`),
  ].join("\n");
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}
