import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/local.js";

const BIN = join(import.meta.dir, "../src/bin.ts");

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "hunch-config-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["add", "."]);
  return root;
}

function hunch(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [BIN, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH! } });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const CONFIG = `import { choice, defineConfig, noul } from "@kelbie/hunch";
export default defineConfig({
  extends: ["hunch:recommended"],
  agentsMd: false,
  skills: [],
  rules: {
    "api/errors": ["error", "Error responses keep their code field."],
    "tests/weakened": ["warn", noul({ instructions: "Does \`hunk\` loosen an assertion?", threshold: 0.8, files: ["**/*.test.ts"], when: /expect/ })],
    "payments/retry": ["warn", choice({ instructions: "What happens on retry in \`hunk\`?", criteria: { safe: "Same key.", duplicate: "New key.", none: "No retry." }, report: ["duplicate"], reference: "docs/contracts.md" })],
    "docs/contradictory-comment": "off",
  },
  overrides: [{ files: ["scripts/**"], rules: { "api/errors": "off" } }],
});
`;

test("config lists every rule with when it reports, including the ones turned off", () => {
  const root = repo({ "hunch.config.ts": CONFIG, "docs/contracts.md": "Keys are stable." });
  try {
    const r = hunch(root, "config", "--reporter", "json");
    expect(r.status).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.valid).toBe(true);
    const byId = Object.fromEntries(report.rules.map((x: { id: string }) => [x.id, x]));
    expect(byId["api/errors"]).toMatchObject({ level: "error", type: "plain", reports: "p(yes) ≥ 0.7", source: "config" });
    expect(byId["tests/weakened"]).toMatchObject({ type: "noul", reports: "p(yes) ≥ 0.8", files: ["**/*.test.ts"], when: "/expect/" });
    expect(byId["payments/retry"]).toMatchObject({ type: "choice", reports: "answer is duplicate", reference: "docs/contracts.md" });
    expect(byId["docs/contradictory-comment"]).toMatchObject({ level: "off", source: "hunch:recommended" });
    expect(report.overrides).toEqual([{ files: ["scripts/**"], rules: { "api/errors": "off" } }]);
    expect(hunch(root, "config").out).toContain("hunch.config.ts is valid.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--file shows only the rules asked about that file, with overrides applied", () => {
  const root = repo({ "hunch.config.ts": CONFIG, "docs/contracts.md": "x" });
  try {
    const ids = (file: string) => JSON.parse(hunch(root, "config", "--file", file, "--reporter", "json").out).rules.map((r: { id: string }) => r.id);
    expect(ids("src/a.test.ts")).toContain("tests/weakened");
    expect(ids("src/a.ts")).not.toContain("tests/weakened");
    expect(ids("src/a.ts")).toContain("api/errors");
    expect(ids("scripts/run.ts")).not.toContain("api/errors");
    expect(ids("src/a.ts")).not.toContain("docs/contradictory-comment");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--explain prints the question exactly as sent, with the state it will receive", () => {
  const root = repo({ "hunch.config.ts": CONFIG, "docs/contracts.md": "x" });
  try {
    const e = JSON.parse(hunch(root, "config", "--explain", "payments/retry", "--reporter", "json").out);
    expect(e.question.type).toBe("choice");
    expect(e.question.instructions).toStartWith("What happens on retry in `hunk`?");
    expect(e.question.instructions).toContain("Read `context` first");
    expect(e.state.map((s: { name: string }) => s.name)).toEqual(["context", "file", "hunk", "surrounding", "task", "reference"]);
    const plain = JSON.parse(hunch(root, "config", "--explain", "api/errors", "--reporter", "json").out);
    expect(plain.question.criteria.true).toContain("visibly breaks the rule");
    const missing = hunch(root, "config", "--explain", "nope");
    expect(missing.status).toBe(2);
    expect(missing.err).toContain('no rule "nope"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a typo'd rule id, a missing reference and a missing config all fail before anything is spent", () => {
  const broken = CONFIG.replace('"docs/contradictory-comment": "off"', '"docs/contradictory-coment": "off"');
  const root = repo({ "hunch.config.ts": broken });
  try {
    const r = hunch(root, "config", "--reporter", "json");
    expect(r.status).toBe(2);
    const problems: string[] = JSON.parse(r.out).problems;
    expect(problems.some((p) => p.includes('"docs/contradictory-coment" in rules sets a level'))).toBe(true);
    expect(problems.some((p) => p.includes("reference docs/contracts.md does not exist"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const empty = repo({ "README.md": "x" });
  try {
    const r = hunch(empty, "config");
    expect(r.status).toBe(2);
    expect(r.err).toContain("npx @kelbie/hunch init");
    // Inline rules need no file, the same as check.
    expect(JSON.parse(hunch(empty, "config", "--rule", "a/b=Keep it.", "--reporter", "json").out).rules.map((x: { id: string }) => x.id)).toEqual(["a/b"]);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("check --only asks just the named rules, and refuses an id no rule has", () => {
  const root = repo({ "hunch.config.ts": CONFIG, "docs/contracts.md": "x", "src/a.ts": "export const a = 1;\n" });
  try {
    const all = hunch(root, "check", "--all", "--dry-run");
    const one = hunch(root, "check", "--all", "--dry-run", "--only", "api/errors");
    const questions = (out: string) => Number(/(\d+) question/.exec(out)?.[1]);
    // Three files in scope: one question each for the plain rule, many more with every rule.
    expect(questions(one.out)).toBe(3);
    expect(questions(all.out)).toBeGreaterThan(3);
    const bad = hunch(root, "check", "--all", "--dry-run", "--only", "api/eror");
    expect(bad.status).toBe(2);
    expect(bad.err).toContain("--only: no rule api/eror");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("find needs no config, and says what it is searching instead", () => {
  const root = repo({ "src/a.ts": "export const a = 1;\n", "yarn.lock": "x" });
  try {
    const r = hunch(root, "find", "add a retry", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.err).toContain("no config; searching every file");
    expect(r.out).toContain("1 file(s)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init takes every wizard answer as a flag, so an agent without a terminal can reach any config", () => {
  const root = repo({ "package.json": "{}" });
  try {
    const r = hunch(root, "init", "--preset", "ts,rust", "--target", "local", "--include", "src/**", "--no-zero-data-retention", "--fail-on-error", "--task", "none", "--rule", "api/errors=Error responses keep their code field.");
    expect(r.status).toBe(0);
    const report = JSON.parse(hunch(root, "config", "--reporter", "json").out);
    expect(report.settings).toMatchObject({ extends: ["hunch:recommended", "hunch:typescript", "hunch:rust"], include: ["src/**"], zeroDataRetention: false, failOnError: true, task: "none" });
    expect(report.rules.map((x: { id: string }) => x.id)).toContain("api/errors");
    expect(hunch(root, "init", "--yes").status).toBe(2);
    expect(hunch(root, "init", "--target", "elsewhere").err).toContain("choose from app, actions, local");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repository with no origin is told which --base to pass, not git's 'Needed a single revision'", () => {
  const root = repo({ "hunch.config.ts": CONFIG, "docs/contracts.md": "x" });
  try {
    git(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "base"]);
    const r = hunch(root, "check", "--dry-run");
    expect(r.status).toBe(2);
    expect(r.err).toContain("This repository has no `origin` remote; pass --base with a local branch, such as --base main.");
    expect(r.err).not.toContain("fatal:");
    expect(hunch(root, "check", "--base", "main", "--dry-run").status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dry run says when the real review would be incomplete for want of a compiled lock", () => {
  const root = repo({ "hunch.config.ts": CONFIG.replace("agentsMd: false", "agentsMd: true"), "docs/contracts.md": "x", "AGENTS.md": "Keep error codes stable.\n", "src/a.ts": "export const a = 1;\n" });
  try {
    const r = hunch(root, "check", "--all", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.err).toContain("hunch.lock is missing, so agents-md/root is not reviewed.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compiled path globs preserve directories while filename-only patterns match nested files", () => {
  const definitions = [
    { id: "doc/guide/app", appliesTo: ["app/**/*.tsx"] },
    { id: "doc/guide/tests", appliesTo: ["*.test.tsx"] },
  ];
  const root = repo({
    "hunch.config.ts": 'export default { agentsMd: false, skills: [], rules: {} };',
    "hunch.lock": JSON.stringify({ version: 1, compiler: { model: "fixture" }, sources: [{
      id: "doc/guide", kind: "doc", origin: "guide.md", path: "guide.md", scope: "", hash: "fixture",
      rules: definitions.map(r => ({ ...r, section: "Guide", message: "Keep the contract.", instructions: "Does this break the contract?", criteria: { true: "Broken.", false: "Preserved." } })),
    }] }),
  });
  try {
    const ids = (file: string) => JSON.parse(hunch(root, "config", "--file", file, "--reporter", "json").out).rules.map((r: { id: string }) => r.id);
    expect(ids("app/features/pay/Screen.tsx")).toEqual(["doc/guide/app"]);
    expect(ids("app/features/pay/Screen.test.tsx")).toEqual(["doc/guide/app", "doc/guide/tests"]);
    expect(ids("wallet/Screen.tsx")).toEqual([]);
    expect(ids("wallet/Screen.test.tsx")).toEqual(["doc/guide/tests"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project can budget a large compiled policy without truncating it at 64 questions", () => {
  const root = repo({
    "hunch.config.ts": `export default { agentsMd: false, skills: [], include: ["src/**"], budget: { maxRulesPerHunk: 128 }, rules: ${JSON.stringify(Object.fromEntries(Array.from({ length: 96 }, (_, i) => [`policy/r${i}`, ["warn", "Keep the contract."]])))} };`,
    "src/a.ts": "export const a = 1;\n",
  });
  try {
    const r = hunch(root, "check", "--all", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.out).toContain("96 question(s) in 1 request(s)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
