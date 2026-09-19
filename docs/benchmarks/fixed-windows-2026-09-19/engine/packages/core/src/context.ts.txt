import type { Hunk } from "./diff.js";

/**
 * What the reviewer is looking at, in words, sent as the `context` state value beside every hunk.
 *
 * Jev sees one hunk and nothing else. Without being told, it cannot know whether the `+` lines are
 * a change or a whole file being read for the first time, which lines are under review, or that the
 * rest of the file is absent rather than empty. Every config then re-states those facts in every
 * question — the `SCOPE` and `NO_EVIDENCE` constants people end up writing by hand. Saying it once,
 * accurately, from what the engine already knows, is both cheaper and more reliable than asking rule
 * authors to remember it.
 */

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript JSX", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript JSX", mjs: "JavaScript", cjs: "JavaScript",
  rs: "Rust", py: "Python", rb: "Ruby", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  swift: "Swift", m: "Objective-C", mm: "Objective-C++", c: "C", h: "C/C++ header",
  cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++ header", cs: "C#", php: "PHP",
  scala: "Scala", ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell", ml: "OCaml",
  dart: "Dart", lua: "Lua", pl: "Perl", r: "R", sql: "SQL", sh: "shell", bash: "shell", zsh: "shell",
  ps1: "PowerShell", vue: "Vue single-file component", svelte: "Svelte component",
  css: "CSS", scss: "SCSS", less: "Less", html: "HTML", xml: "XML",
  json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
  md: "Markdown", mdx: "MDX", graphql: "GraphQL", gql: "GraphQL", proto: "Protocol Buffers",
  tf: "Terraform", dockerfile: "Dockerfile", gradle: "Gradle", zig: "Zig", nix: "Nix",
};

const BASENAMES: Record<string, string> = {
  dockerfile: "Dockerfile", makefile: "Makefile", rakefile: "Ruby", gemfile: "Ruby",
  "cargo.toml": "TOML", "package.json": "JSON",
};

/** The language name for a path, or null when the extension says nothing useful. */
export function languageOf(file: string): string | null {
  const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  if (BASENAMES[base]) return BASENAMES[base]!;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return LANGUAGES[ext] ?? null;
}

/**
 * How a file is used, when the path says so plainly. This is the carve-out every config writes by
 * hand ("excluding tests", "excluding fixtures"); naming it once lets a rule say "this is a test
 * file" is a reason rather than making each author enumerate path patterns.
 */
export type FileRole = "test" | "fixture" | "example" | "generated" | "config" | "documentation" | null;

export function roleOf(file: string): FileRole {
  const path = file.toLowerCase();
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(base) || /^test_|_test\.[a-z]+$/.test(base)) return "test";
  if (/(^|\/)(__fixtures__|fixtures?|testdata|snapshots?|__snapshots__)\//.test(path) || /\.snap$/.test(base)) return "fixture";
  if (/(^|\/)(examples?|samples?|demos?|playground)\//.test(path)) return "example";
  if (/\.(generated|gen|pb|g)\.[a-z]+$/.test(base) || /(^|\/)(generated|__generated__)\//.test(path)) return "generated";
  if (/(^|\/)docs?\//.test(path) || /\.(md|mdx|rst|txt)$/.test(base)) return "documentation";
  if (/^(package|tsconfig|jsconfig|cargo|pyproject|go|composer)\.(json|toml|mod)$/.test(base) || /^\.?[a-z.]*(eslint|prettier|babel|vite|webpack|rollup|jest|vitest|tailwind|next|metro|expo)[a-z.]*\.(js|cjs|mjs|ts|json|yaml|yml|toml)$/.test(base)) return "config";
  return null;
}

const ROLE_NOTE: Record<Exclude<FileRole, null>, string> = {
  test: "This is a test file: its job is to exercise behaviour, so patterns that would be wrong in production code are often correct here.",
  fixture: "This is test data or a fixture, not production code.",
  example: "This is example or demo code, not production code.",
  generated: "This file looks generated; a human does not edit it directly.",
  config: "This is a configuration or build file, not application code.",
  documentation: "This is documentation, not code.",
};

export interface ContextOptions {
  /** Repository-relative paths of the other files this change touches, if known. */
  siblings?: string[];
}

const SIBLING_LIMIT = 20;

/**
 * The framing paragraph for one hunk. Deterministic, derived only from what the engine already
 * knows, and true in both review modes — a whole-file chunk must never be described as a change.
 */
export function hunkContext(hunk: Hunk, options: ContextOptions = {}): string {
  return [...describeChunk(hunk, options), "", HOW_TO_ANSWER].join("\n");
}

/**
 * What this chunk is, independent of why it is being read. Review and retrieval need the same
 * facts — mode, path, language, role, line range, what the markers mean — and differ only in what
 * they ask for afterwards, so the description lives in one place and each caller adds its own task.
 */
export function describeChunk(hunk: Hunk, options: ContextOptions = {}): string[] {
  const language = languageOf(hunk.file);
  const named = language ? `a ${language} file` : "a file";
  const role = roleOf(hunk.file);
  const first = hunk.newStart;
  const last = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  const hasUnchanged = hunk.text.split("\n").slice(1).some((l) => l.startsWith(" "));
  const lines: string[] = [];

  if (hunk.kind === "file") {
    lines.push(
      "You are looking at part of an existing file in a code repository. This is not a change: there is no previous version and nothing was edited.",
      `\`file\` is \`${hunk.file}\`, ${named}. \`hunk\` is lines ${first}–${last} of it.`,
      hasUnchanged
        ? "Every line under review is marked `+` because the whole file is being read; the lines marked with a leading space are the file's imports, repeated so you can see what the code depends on."
        : "Every line is marked `+` because the whole file is being read, not because it was added.",
    );
  } else {
    const change = hunk.status === "added" ? "added by this change"
      : hunk.status === "renamed" ? `renamed from \`${hunk.oldFile ?? "another path"}\` by this change`
      : "modified by this change";
    lines.push(
      "You are looking at one hunk of a proposed code change, such as a pull request.",
      `\`file\` is \`${hunk.file}\`, ${named} ${change}. \`hunk\` is that file's unified diff around lines ${first}–${last}.`,
      hunk.status === "added"
        ? "Every line is marked `+`: the file is new, so there is no previous behaviour to compare against."
        : `Lines starting with \`+\` are the new code under review. Lines starting with \`-\` are the code being replaced — they are the previous behaviour, not a problem to report.${hasUnchanged ? " Lines starting with a space are unchanged code, shown only so the change is readable." : ""}`,
    );
  }

  if (role) lines.push(ROLE_NOTE[role]);

  // Only a change has siblings; in a whole-file run the "other files" are simply the repository.
  const siblings = hunk.kind === "file" ? [] : (options.siblings ?? []).filter((f) => f !== hunk.file);
  if (siblings.length) {
    const shown = siblings.slice(0, SIBLING_LIMIT);
    lines.push(`The same change also touches ${shown.map((f) => `\`${f}\``).join(", ")}${siblings.length > shown.length ? `, and ${siblings.length - shown.length} more` : ""}. Their contents are not shown.`);
  }

  return lines;
}

/**
 * The part that is the same for every hunk and every rule. It is stated here, once, instead of in
 * each question, because a repository with fifty rules would otherwise pay for fifty copies of it —
 * and because rule authors who forget to say it are the ones whose rules most need it said.
 */
export const HOW_TO_ANSWER = `How to answer:
- Report a problem only when the lines under review cause it. Pre-existing problems the change leaves untouched are not this review's concern.
- Nothing else is visible to you: not the rest of this file, not its callers, not any other file, not the project's conventions beyond what you are told here.
- So absent code is not evidence. A guard, check, test, cleanup or caller you cannot see may well exist elsewhere; never report a problem that depends only on your not seeing something.
- Judge from these values alone. Do not assume callers, configuration, requirements or behaviour outside them, and do not answer from what code like this usually does.
- Each question is about one specific thing. For a yes/no question, answer no when this hunk has nothing to do with it, and no when the visible lines give no concrete evidence either way — an unrelated hunk is a no, not a maybe.
- A question's own criteria decide the answer. Where they name exceptions, an instance of an exception is a no.`;
