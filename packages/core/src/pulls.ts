import { estimateTokens } from "./diff.js";
import { wrapText as wrap } from "./find.js";
import type { JevClient } from "./jev.js";

/**
 * Is somebody already doing this?
 *
 * The most expensive answer `find` can give is a perfect list of files to change for work that is
 * already sitting in review. Open pull requests are cheap to read and nobody reads them, so this
 * asks the same question of them that `find` asks of the code: does this already do what you are
 * about to do, and would it collide with you if it does not.
 *
 * Two passes, because diffs are the expensive part. Every open pull request is judged on its title
 * alone, and only the ones that could plausibly be the same work have their diff fetched and read.
 */

export interface PullSummary {
  number: number;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  url: string;
  updatedAt: string;
  /** Head branch, so a reader can check it out. */
  branch: string;
}

/** The parts of `gh` this needs, injected so the flow is testable without a network or a GitHub. */
export interface PullsIo {
  /** A `gh api` call. `ok` is false for any non-zero exit, including 404. */
  gh(args: string[]): Promise<{ ok: boolean; body: string }>;
}

export type PullVerdict = "duplicate" | "overlap";

export interface PullMatch extends PullSummary {
  /** How close the title alone looked; what decided whether the diff was read. */
  titleScore: number;
  /** Set once the diff was read. Absent means only the title was judged. */
  duplicate?: number;
  overlap?: number;
  /** The stronger of the two, and the number behind it. */
  verdict: PullVerdict;
  score: number;
  /** True when the diff was too large to send whole, so the judgment saw only part of it. */
  truncated?: boolean;
}

export interface PullsResult {
  matches: PullMatch[];
  /** Open pull requests considered, whether or not they matched. */
  considered: number;
  /** How many had their diff read. */
  inspected: number;
  notices: string[];
  /** False when something could not be checked, so "no duplicate" is not proven. */
  complete: boolean;
}

const TITLE_QUESTION = {
  type: "noul" as const,
  instructions:
    "Does this pull request's title describe the same work as `task`? `task` is what someone is about to start; the pull request is work already opened. Answer yes if they could plausibly be the same piece of work, so that the pull request is worth reading in full before starting. This is a cheap first pass: prefer a yes you would reject on reading the diff to a no that hides a duplicate.",
  criteria: {
    true: "The title names the same feature, fix, screen, endpoint or behaviour that `task` describes, even loosely or in different words.",
    false: "The title is about unrelated work. Sharing a general area is not enough on its own — but when in doubt, say yes and let the diff decide.",
  },
};

const DIFF_QUESTIONS = {
  duplicate: {
    type: "noul" as const,
    instructions:
      "Does this pull request already implement what `task` describes? `task` has not been started. Judge the change in `diff` against what `task` asks for, using `title` and `body` for intent.",
    criteria: {
      true: "The diff makes the change `task` asks for, or a version of it close enough that doing `task` separately would repeat this work.",
      false: "It does something else, or it touches the same area without making the change `task` asks for.",
    },
  },
  overlap: {
    type: "noul" as const,
    instructions:
      "Would the work in `task` and the change in `diff` touch the same code, so that doing `task` now would conflict with this pull request or need rebasing onto it?",
    criteria: {
      true: "The diff edits the files, functions or components that `task` would have to edit.",
      false: "The two changes are in different code and would not meet.",
    },
  },
};

/** Diffs get large; past this the judgment would be made on a truncated change, and says so. */
const DIFF_TOKEN_LIMIT = 12_000;
const BODY_LIMIT = 4000;

export interface PullsInput {
  task: string;
  /** `owner/repo`. */
  slug: string;
  io: PullsIo;
  client: JevClient;
  model: string;
  /** Read the diff of every pull request scoring at least this on its title. */
  titleThreshold?: number;
  /** Report a pull request scoring at least this on duplicate or overlap. */
  reportThreshold?: number;
  /** Cap on diffs read, so a repository with a hundred open PRs cannot run away. */
  maxInspected?: number;
  /** Include drafts. Off by default: a draft is not work you would merge instead. */
  includeDrafts?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export async function findPulls(input: PullsInput): Promise<PullsResult> {
  const titleThreshold = input.titleThreshold ?? 0.5;
  const reportThreshold = input.reportThreshold ?? 0.5;
  const maxInspected = input.maxInspected ?? 10;
  const notices: string[] = [];

  const listed = await listPulls(input.io, input.slug);
  if (!listed) {
    return { matches: [], considered: 0, inspected: 0, complete: false,
      notices: [`Could not list open pull requests for ${input.slug}. Is \`gh\` installed and authenticated? Existing work was not checked.`] };
  }
  const pulls = listed.filter((p) => input.includeDrafts || !p.draft);
  if (!pulls.length) return { matches: [], considered: 0, inspected: 0, notices: [], complete: true };

  // Pass one: titles only. Small states, one request each.
  const candidates: { pull: PullSummary; titleScore: number }[] = [];
  let done = 0;
  let failed = 0;
  for (const pull of pulls) {
    try {
      const res = await input.client.evaluate({
        model: input.model,
        state: { task: input.task, title: pull.title },
        questions: { title: TITLE_QUESTION },
      });
      const answer = res.answers.title;
      const titleScore = answer?.type === "noul" ? answer.p : 0;
      if (titleScore >= titleThreshold) candidates.push({ pull, titleScore });
    } catch {
      failed++;
    }
    input.onProgress?.(++done, pulls.length);
  }
  if (failed) notices.push(`${failed} pull request title(s) could not be judged, so a duplicate among them would have been missed.`);

  candidates.sort((a, b) => b.titleScore - a.titleScore);
  const overflow = Math.max(0, candidates.length - maxInspected);
  if (overflow) notices.push(`${overflow} more pull request(s) looked related by title but were not read; raise --pr-max to include them.`);

  // Pass two: the ones worth reading, judged on their actual change.
  const matches: PullMatch[] = [];
  let inspected = 0;
  for (const { pull, titleScore } of candidates.slice(0, maxInspected)) {
    const raw = await readDiff(input.io, input.slug, pull.number);
    if (raw === null) {
      notices.push(`Could not read the diff of #${pull.number}; it is reported on its title alone.`);
      matches.push({ ...pull, titleScore, verdict: "duplicate", score: titleScore });
      continue;
    }
    inspected++;
    const truncated = estimateTokens(raw) > DIFF_TOKEN_LIMIT;
    const diff = truncated ? raw.slice(0, DIFF_TOKEN_LIMIT * 4) : raw;
    try {
      const res = await input.client.evaluate({
        model: input.model,
        state: { task: input.task, title: pull.title, body: pull.body.slice(0, BODY_LIMIT), diff },
        questions: DIFF_QUESTIONS,
      });
      const duplicate = res.answers.duplicate?.type === "noul" ? res.answers.duplicate.p : 0;
      const overlap = res.answers.overlap?.type === "noul" ? res.answers.overlap.p : 0;
      const verdict: PullVerdict = duplicate >= overlap ? "duplicate" : "overlap";
      const score = Math.max(duplicate, overlap);
      if (score >= reportThreshold) matches.push({ ...pull, titleScore, duplicate, overlap, verdict, score, ...(truncated ? { truncated } : {}) });
    } catch (error) {
      notices.push(`#${pull.number} could not be judged (${(error as Error).message}); it may still be the same work.`);
    }
  }

  matches.sort((a, b) => b.score - a.score || a.number - b.number);
  return { matches, considered: pulls.length, inspected, notices, complete: !notices.length };
}

const listSchema = (value: unknown): PullSummary[] | null => {
  if (!Array.isArray(value)) return null;
  const pulls: PullSummary[] = [];
  for (const raw of value) {
    const p = raw as Record<string, unknown>;
    if (typeof p.number !== "number" || typeof p.title !== "string") continue;
    pulls.push({
      number: p.number,
      title: p.title,
      body: typeof p.body === "string" ? p.body : "",
      author: typeof (p.user as { login?: unknown })?.login === "string" ? String((p.user as { login: string }).login) : "someone",
      draft: p.draft === true,
      url: typeof p.html_url === "string" ? p.html_url : "",
      updatedAt: typeof p.updated_at === "string" ? p.updated_at : "",
      branch: typeof (p.head as { ref?: unknown })?.ref === "string" ? String((p.head as { ref: string }).ref) : "",
    });
  }
  return pulls;
};

async function listPulls(io: PullsIo, slug: string): Promise<PullSummary[] | null> {
  const res = await io.gh(["api", "--paginate", `/repos/${slug}/pulls?state=open&per_page=100`]);
  if (!res.ok) return null;
  try {
    // --paginate concatenates JSON arrays when the body is a list; gh emits one array per page.
    const pages = res.body.trim().replace(/\]\s*\[/g, ",").replace(/^\s*/, "");
    return listSchema(JSON.parse(pages || "[]"));
  } catch {
    return null;
  }
}

async function readDiff(io: PullsIo, slug: string, number: number): Promise<string | null> {
  const res = await io.gh(["api", "-H", "Accept: application/vnd.github.v3.diff", `/repos/${slug}/pulls/${number}`]);
  return res.ok ? res.body : null;
}

/**
 * The part of the report that changes what someone does next. It goes above the file list, because
 * a duplicate makes the file list irrelevant — and it says what to do, not just what it found.
 */
export function pullsMarkdown(result: PullsResult): string {
  if (!result.matches.length && !result.notices.length) return "";
  const out: string[] = ["## Existing work", ""];
  const strong = result.matches.filter((m) => m.verdict === "duplicate" && m.score >= 0.7);
  if (strong.length) {
    out.push(`**Someone may already be doing this.** ${strong.length === 1 ? "An open pull request appears" : `${strong.length} open pull requests appear`} to make this change. Read ${andList(strong.map((m) => `#${m.number}`))} before writing anything — reviewing or finishing that work is probably cheaper than starting again.`, "");
  } else if (result.matches.length) {
    out.push("No open pull request appears to make this change, but these touch the same code and would need rebasing against it — or against you.", "");
  } else {
    out.push("Open pull requests could not be fully checked, so this does not prove the work is not already underway.", "");
  }
  for (const m of result.matches) {
    const label = m.verdict === "duplicate" ? "may already do this" : "would touch the same code";
    out.push(`- [#${m.number} ${m.title}](${m.url}) — ${label} (${m.score.toFixed(2)})`);
    const detail = [
      `by ${m.author}`,
      m.branch ? `branch \`${m.branch}\`` : "",
      m.draft ? "draft" : "",
      m.duplicate === undefined ? "judged on its title only; the diff could not be read" : `duplicate ${m.duplicate.toFixed(2)}, overlap ${m.overlap!.toFixed(2)}`,
      m.truncated ? "diff was too large to read whole" : "",
    ].filter(Boolean);
    out.push(`  ${detail.join(" · ")}`);
  }
  out.push("");
  for (const notice of result.notices) out.push(`> **Incomplete:** ${notice}`, "");
  return out.join("\n");
}

const andList = (items: string[]): string =>
  items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export interface PullsTextOptions {
  color?: boolean;
  width?: number;
}

/**
 * The terminal form of the same warning, laid out like `check`'s report. It leads with what to do,
 * because a duplicate changes the reader's next action and a list of scores does not.
 */
export function pullsText(result: PullsResult, { color = false, width = 100 }: PullsTextOptions = {}): string {
  if (!result.matches.length && !result.notices.length) return "";
  const paint = (codes: string) => (s: string) => (color ? `\x1b[${codes}m${s}\x1b[0m` : s);
  const bold = paint("1"), dim = paint("2"), yellow = paint("33"), cyan = paint("36"), magenta = paint("35"), red = paint("31");
  const out: string[] = [bold("Existing work")];

  const strong = result.matches.filter((m) => m.verdict === "duplicate" && m.score >= 0.7);
  if (strong.length) {
    out.push(`  ${red("!")} ${bold("Someone may already be doing this.")}`);
    out.push(wrap(`Read ${andList(strong.map((m) => `#${m.number}`))} before writing anything — reviewing or finishing that work is probably cheaper than starting again.`, 4, width));
  } else if (result.matches.length) {
    out.push(wrap("No open pull request appears to make this change, but these touch the same code and would need rebasing against it — or against you.", 2, width));
  } else {
    out.push(wrap("Open pull requests could not be fully checked, so this does not prove the work is not already underway.", 2, width));
  }

  if (result.matches.length) {
    const labelW = Math.max(...result.matches.map((m) => VERDICT_LABEL[m.verdict].length));
    for (const m of result.matches) {
      out.push("");
      const label = m.verdict === "duplicate" ? yellow(VERDICT_LABEL[m.verdict].padEnd(labelW)) : dim(VERDICT_LABEL[m.verdict].padEnd(labelW));
      // A pull request title is display text, so it wraps under itself rather than running off
      // the screen — the number stays on the first line where the eye looks for it.
      const [head, ...tail] = wrap(m.title, 0, width - (labelW + 10) - `#${m.number} `.length).split("\n");
      out.push(`  ${magenta(m.score.toFixed(2))}  ${label}  ${cyan(`#${m.number}`)} ${head}`);
      for (const line of tail) out.push(`${" ".repeat(labelW + 10 + `#${m.number} `.length)}${line}`);
      const detail = [
        `by ${m.author}`,
        m.branch ? `branch ${m.branch}` : "",
        m.draft ? "draft" : "",
        m.duplicate === undefined ? "judged on its title only; the diff could not be read" : `duplicate ${m.duplicate.toFixed(2)}, overlap ${m.overlap!.toFixed(2)}`,
        m.truncated ? "diff was too large to read whole" : "",
      ].filter(Boolean);
      // Line up under the title: two spaces, the four-character score, two, the label, two.
      const indent = labelW + 10;
      out.push(dim(wrap(detail.join(" · "), indent, width)));
      if (m.url) out.push(`${" ".repeat(indent)}${dim(m.url)}`);
    }
  }
  for (const n of result.notices) out.push("", yellow("  !") + wrap(n, 4, width).slice(3));
  return out.join("\n");
}

const VERDICT_LABEL: Record<PullVerdict, string> = {
  duplicate: "may already do this",
  overlap: "touches the same code",
};

