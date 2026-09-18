import parseDiff from "parse-diff";

export interface Hunk {
  file: string;
  /** Previous path when the file was renamed or deleted. */
  oldFile?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  /**
   * Where the hunk came from: a real diff, or a whole file split for `check --all`. The reviewer is
   * told which, because "every line is `+`" means "newly added" in one mode and "read the whole
   * file" in the other. Absent means diff, the only shape a parsed patch produces.
   */
  kind?: "diff" | "file";
  /** First line of the hunk in the new file (for annotations). */
  newStart: number;
  newLines: number;
  /** Unified diff text of this hunk only: header + ` `/`+`/`-` lines. */
  text: string;
  added: { line: number; content: string }[];
  removed: { line: number; content: string }[];
}

/** Splits a unified diff (git diff / GitHub .diff) into hunks. Binary files are skipped. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const f of parseDiff(diff)) {
    const file = f.to && f.to !== "/dev/null" ? f.to : f.from!;
    const status = f.new ? "added" : f.deleted ? "deleted" : f.from !== f.to ? "renamed" : "modified";
    for (const chunk of f.chunks) {
      const added: Hunk["added"] = [];
      const removed: Hunk["removed"] = [];
      const lines = [chunk.content];
      for (const c of chunk.changes) {
        lines.push(c.content);
        if (c.type === "add") added.push({ line: c.ln, content: c.content.slice(1) });
        else if (c.type === "del") removed.push({ line: c.ln, content: c.content.slice(1) });
      }
      hunks.push({
        file,
        kind: "diff",
        oldFile: f.from !== file ? f.from : undefined,
        status,
        newStart: chunk.newStart,
        newLines: chunk.newLines,
        text: lines.join("\n"),
        added,
        removed,
      });
    }
  }
  return hunks;
}

/** Rough token estimate (≈4 chars/token) used only for budgeting. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Splits an oversized hunk into windows so state + question stays well under
 * Jev's 32k limit (and small, since accuracy drops with irrelevant state).
 */
export function windowHunk(h: Hunk, maxTokens = 6000): Hunk[] {
  if (estimateTokens(h.text) <= maxTokens) return [h];
  const [header, ...body] = h.text.split("\n");
  const out: Hunk[] = [];
  let buf: string[] = [];
  let size = 0;
  let newLine = h.newStart;
  let windowStart = newLine;
  const flush = () => {
    if (!buf.length) return;
    const text = [header, ...buf].join("\n");
    const inWindow = (l: number) => l >= windowStart && l < newLine;
    out.push({
      ...h,
      newStart: windowStart,
      newLines: newLine - windowStart,
      text,
      added: h.added.filter((a) => inWindow(a.line)),
      removed: h.removed.filter((r) => buf.some((b) => b === `-${r.content}`)),
    });
    buf = [];
    size = 0;
    windowStart = newLine;
  };
  for (const l of body) {
    if (size + estimateTokens(l) > maxTokens) flush();
    buf.push(l);
    size += estimateTokens(l) + 1;
    if (!l.startsWith("-")) newLine++;
  }
  flush();
  return out;
}

/**
 * Files whose change has no reviewable text: binary content, a rename without
 * edits, or a mode change. Hunch can't judge these, so callers report the ones
 * in review scope as needing a human.
 */
export function unreviewableFiles(diff: string): string[] {
  const files: string[] = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    if (!/^(?:Binary files |GIT binary patch|rename from |old mode )/m.test(block)) continue;
    const path = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1] ?? /^rename to (.+)$/m.exec(block)?.[1] ?? /^diff --git a\/.+ b\/(.+)$/m.exec(block)?.[1];
    if (path) files.push(path);
  }
  return files;
}
