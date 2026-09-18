import { expect, test } from "bun:test";
import { findPulls, pullsMarkdown, pullsText, type PullsIo } from "../src/index.js";

const pull = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number, title, body: `body of ${number}`, draft: false,
  user: { login: "someone" }, html_url: `https://github.com/o/r/pull/${number}`,
  updated_at: "2026-09-18T00:00:00Z", head: { ref: `branch-${number}` }, ...extra,
});

/** A GitHub that answers the two calls this makes, and 404s anything else. */
function githubIo(pulls: unknown[], diffs: Record<number, string | null> = {}): PullsIo {
  return {
    async gh(args) {
      const path = args.at(-1)!;
      if (path.includes("/pulls?state=open")) return { ok: true, body: JSON.stringify(pulls) };
      const m = /\/pulls\/(\d+)$/.exec(path);
      if (m) {
        const diff = diffs[Number(m[1])];
        return diff == null ? { ok: false, body: "" } : { ok: true, body: diff };
      }
      return { ok: false, body: "" };
    },
  };
}

/** Jev answering from a table keyed by the question id and whatever state it was given. */
function jev(answer: (id: string, state: Record<string, unknown>) => number, spy?: (state: Record<string, unknown>, ids: string[]) => void) {
  return {
    async evaluate(req: { questions: Record<string, unknown>; state: Record<string, unknown> }) {
      spy?.(req.state, Object.keys(req.questions));
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, p: answer(id, req.state) }])),
        usage: { inputTokens: 5 }, modelId: "jev-test",
      };
    },
  };
}

const base = { task: "warn about onchain minimums", slug: "o/r", model: "jev-test" };

test("only titles that could be the same work have their diff read", async () => {
  const seen: Record<string, unknown>[] = [];
  const res = await findPulls({
    ...base,
    io: githubIo([pull(1, "Add onchain minimum warning"), pull(2, "Bump eslint")], { 1: "diff --git a/x b/x", 2: "diff --git a/y b/y" }),
    client: jev((id, state) => {
      if (id === "title") return String(state.title).includes("onchain") ? 0.9 : 0.05;
      return id === "duplicate" ? 0.88 : 0.6;
    }, (state) => seen.push(state)),
  });
  expect(res.considered).toBe(2);
  // The unrelated title cost one small request and no diff fetch.
  expect(res.inspected).toBe(1);
  expect(seen.filter((s) => s.diff)).toHaveLength(1);
  expect(res.matches).toHaveLength(1);
  expect(res.matches[0]!).toMatchObject({ number: 1, verdict: "duplicate", score: 0.88, duplicate: 0.88, overlap: 0.6, branch: "branch-1" });
  expect(res.complete).toBe(true);
});

test("a pull request that only collides is reported as overlap, not as a duplicate", async () => {
  const res = await findPulls({
    ...base,
    io: githubIo([pull(3, "Refactor the receive screen")], { 3: "diff" }),
    client: jev((id) => (id === "title" ? 0.7 : id === "overlap" ? 0.82 : 0.2)),
  });
  expect(res.matches[0]!.verdict).toBe("overlap");
  const md = pullsMarkdown(res);
  expect(md).toContain("would touch the same code");
  expect(md).toContain("would need rebasing");
  expect(md).not.toContain("Someone may already be doing this");
});

test("a likely duplicate leads the report and says what to do about it", async () => {
  const res = await findPulls({
    ...base,
    io: githubIo([pull(7, "Show onchain min and max on the receive QR")], { 7: "diff" }),
    client: jev((id) => (id === "title" ? 0.95 : id === "duplicate" ? 0.91 : 0.5)),
  });
  const md = pullsMarkdown(res);
  expect(md).toContain("## Existing work");
  expect(md).toContain("**Someone may already be doing this.**");
  expect(md).toContain("Read #7 before writing anything");
  expect(md).toContain("[#7 Show onchain min and max on the receive QR](https://github.com/o/r/pull/7)");
  expect(md).toContain("branch `branch-7`");
  expect(pullsText(res)).toContain("may already do this");
});

test("drafts are left out unless asked for, since a draft is not work you would merge instead", async () => {
  const io = githubIo([pull(1, "Onchain warning", { draft: true })], { 1: "diff" });
  const client = jev(() => 0.9);
  expect((await findPulls({ ...base, io, client })).considered).toBe(0);
  expect((await findPulls({ ...base, io, client, includeDrafts: true })).considered).toBe(1);
});

test("a diff that cannot be read is reported on its title, and flagged as exactly that", async () => {
  const res = await findPulls({
    ...base,
    io: githubIo([pull(4, "Onchain limits")], {}),
    client: jev(() => 0.9),
  });
  expect(res.matches[0]!.duplicate).toBeUndefined();
  expect(res.inspected).toBe(0);
  expect(pullsMarkdown(res)).toContain("judged on its title only");
  // Not knowing is not the same as knowing there is no duplicate.
  expect(res.complete).toBe(false);
});

test("no GitHub answer never reads as 'nothing is open'", async () => {
  const res = await findPulls({ ...base, io: { async gh() { return { ok: false, body: "" }; } }, client: jev(() => 0.9) });
  expect(res.matches).toHaveLength(0);
  expect(res.complete).toBe(false);
  expect(res.notices[0]).toContain("Existing work was not checked");
  expect(pullsMarkdown(res)).toContain("does not prove the work is not already underway");
});

test("an empty repository of open PRs is a complete answer, and prints nothing", async () => {
  const res = await findPulls({ ...base, io: githubIo([]), client: jev(() => 0.9) });
  expect(res.complete).toBe(true);
  expect(pullsMarkdown(res)).toBe("");
  expect(pullsText(res)).toBe("");
});

test("the number of diffs read is capped, and the ones left out are named as a gap", async () => {
  const many = Array.from({ length: 6 }, (_, i) => pull(i + 1, `Onchain thing ${i}`));
  const res = await findPulls({
    ...base, maxInspected: 2,
    io: githubIo(many, Object.fromEntries(many.map((p) => [p.number, "diff"]))),
    client: jev((id, state) => (id === "title" ? 0.9 - Number(String(state.title).at(-1)) / 100 : 0.9)),
  });
  expect(res.inspected).toBe(2);
  expect(res.notices.join(" ")).toContain("4 more pull request(s) looked related by title");
  expect(res.complete).toBe(false);
});

test("pagination across pages is joined rather than parsed as the first page only", async () => {
  const io: PullsIo = {
    async gh(args) {
      return args.at(-1)!.includes("state=open")
        ? { ok: true, body: `${JSON.stringify([pull(1, "a")])}\n${JSON.stringify([pull(2, "Onchain b")])}` }
        : { ok: true, body: "diff" };
    },
  };
  const res = await findPulls({ ...base, io, client: jev((id, state) => (id === "title" ? (String(state.title).includes("Onchain") ? 0.9 : 0.1) : 0.9)) });
  expect(res.considered).toBe(2);
  expect(res.matches[0]!.number).toBe(2);
});

test("three or more duplicates read as a list, not as a chain of ands", async () => {
  const many = [pull(1, "Onchain a"), pull(2, "Onchain b"), pull(3, "Onchain c")];
  const res = await findPulls({
    ...base,
    io: githubIo(many, { 1: "d", 2: "d", 3: "d" }),
    client: jev(() => 0.9),
  });
  expect(pullsMarkdown(res)).toContain("Read #1, #2 and #3 before writing anything");
});

test("a truncated diff is judged, but the report says the judgment saw only part of it", async () => {
  const huge = "diff --git a/x b/x\n".repeat(20_000);
  const res = await findPulls({ ...base, io: githubIo([pull(9, "Onchain limits")], { 9: huge }), client: jev(() => 0.9) });
  expect(res.matches[0]!.truncated).toBe(true);
  expect(pullsMarkdown(res)).toContain("diff was too large to read whole");
});

test("the terminal warning leads with what to do, and colour strips back to the same text", async () => {
  const res = await findPulls({
    ...base,
    io: githubIo([pull(7, "Show onchain min and max"), pull(8, "Refactor receive")], { 7: "d", 8: "d" }),
    client: jev((id, state) => {
      if (id === "title") return 0.9;
      const isSeven = String(state.title).includes("min and max");
      return id === "duplicate" ? (isSeven ? 0.91 : 0.2) : isSeven ? 0.5 : 0.8;
    }),
  });
  const text = pullsText(res, { width: 80 });
  expect(text).toContain("Existing work");
  expect(text).toContain("Someone may already be doing this.");
  expect(text).toContain("Read #7 before writing anything");
  expect(text).toContain("0.91  may already do this");
  expect(text).toContain("0.80  touches the same code");
  expect(text).toContain("#7 Show onchain min and max");
  expect(text).toContain("duplicate 0.91, overlap 0.50");
  expect(text).toContain("https://github.com/o/r/pull/7");

  const painted = pullsText(res, { color: true, width: 80 });
  expect(painted).toContain("\x1b[");
  expect(painted.replace(/\x1b\[\d+m/g, "")).toBe(text);
});

test("the detail lines sit under the title, not under the score", async () => {
  const res = await findPulls({ ...base, io: githubIo([pull(7, "Onchain min and max")], { 7: "d" }), client: jev(() => 0.9) });
  const lines = pullsText(res).split("\n");
  const title = lines.find((l) => l.includes("may already do this"))!;
  const detail = lines.find((l) => l.includes("by someone"))!;
  expect(detail.match(/^ */)![0].length).toBe(title.indexOf("#7"));
});
