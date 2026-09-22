import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Command, CommanderError } from "commander";
import { configSchema, evaluateConfigSource, parseConfig, tomlToConfig } from "../../core/src/index.js";
import { buildProgram } from "../src/program.js";
import { CLI_REFERENCE, renderCliReference } from "../../../scripts/sync-skill.ts";

/**
 * The skill is the user documentation, so it is held to the code the way tests hold code to a spec:
 * every command it tells an agent to run must parse, every config it shows must load, every link
 * must land, and the generated parts must be current.
 */

const ROOT = join(import.meta.dir, "../../..");
const SKILL = join(ROOT, "skills/hunch");

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? markdown(path) : name.endsWith(".md") ? [path] : [];
  });
}
const docs = [...markdown(SKILL), join(ROOT, "README.md")];
/** Hand-written pages; examples/ and cli.md are generated from the CLI and checked separately. */
const written = docs.filter((f) => !f.includes("/examples/") && !f.endsWith("cli.md"));

test("the CLI reference is generated from the current program", () => {
  expect(readFileSync(CLI_REFERENCE, "utf8")).toBe(renderCliReference());
});

test("the captured examples are current for every offline case", () => {
  const r = spawnSync("bun", [join(ROOT, "scripts/skill-examples.ts"), "--check"], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
}, 120_000);

const COMMANDS = new Set(buildProgram().commands.map((c) => c.name()));

/** Splits a command line the way a POSIX shell would for these simple cases: quotes, no expansion. */
function argv(line: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, any = false;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Every Hunch command line a doc tells someone to run: code spans and shell blocks. */
function commandLines(text: string): string[] {
  const candidates = [
    ...[...text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split("\n")),
    ...[...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!),
  ];
  const lines: string[] = [];
  for (let c of candidates) {
    // Drop a trailing comment, redirect or pipe, but not the `>` of a `<placeholder>`.
    c = c.replace(/\s+#.*$/, "").replace(/\s+(?:\d?>|\|)\s.*$/, "").trim();
    const m = /^(?:npx (?:-y )?(?:--min-release-age=0 )?@kelbie\/hunch(?:@[\w.]+)?|bun run hunch|hunch)\s+(.*)$/.exec(c);
    const rest = m ? m[1]! : c;
    const first = rest.split(/\s+/)[0]!;
    if (!COMMANDS.has(first)) continue;
    if (!m && !rest.includes(" ")) continue; // a bare word like `check` in prose
    if (/\\\||<command>|<verb>/.test(rest)) continue; // alternatives written for people, not a runnable line
    if (/^app(\s+(register|connect))?$/.test(rest)) continue; // naming the subcommand in prose
    lines.push(rest);
  }
  return lines;
}

/** Placeholders a person fills in become a value commander accepts in that position. */
const fill = (line: string) => line.replace(/<[^>]+>/g, "x").replace(/\[[^\]]*…?\]/g, "").replace(/…/g, "x").replace(/="x"/g, '="x"');

/**
 * Prose names a flag or command without a value ("read `config --explain` for…"). That is a
 * mention, not a line to run, so a value missing from the very end is allowed; anything else is not.
 */
function mention(line: string, error: CommanderError): boolean {
  const last = argv(line).at(-1) ?? "";
  if (error.code === "commander.optionMissingArgument") return last.startsWith("--");
  if (error.code === "commander.missingArgument") return COMMANDS.has(last);
  return false;
}

function parses(line: string): string | null {
  const program = buildProgram();
  const quiet = (c: Command) => {
    c.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} }).action(() => {});
    c.commands.forEach(quiet);
  };
  quiet(program);
  try { program.parse(["node", "hunch", ...argv(fill(line))]); return null; }
  catch (e) {
    if (e instanceof CommanderError) return mention(line, e) ? null : e.message;
    return String(e);
  }
}

test("every command the docs tell someone to run is one the CLI accepts", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const file of written) {
    for (const line of commandLines(readFileSync(file, "utf8"))) {
      checked++;
      const error = parses(line);
      if (error) failures.push(`${relative(ROOT, file)}: hunch ${line}\n    ${error}`);
    }
  }
  expect(failures).toEqual([]);
  expect(checked).toBeGreaterThan(60);
});

test("the command-line checker notices a flag that does not exist", () => {
  expect(parses("check --not-a-flag")).toContain("unknown option");
  expect(parses("find --prs")).toContain("missing required argument");
  expect(parses("check --only x --dry-run")).toBeNull();
});

/** Config shown in a doc: a whole file, a `rules:` fragment, or rule entries. */
function loadSnippet(lang: string, body: string) {
  if (lang === "toml") return parseConfig(tomlToConfig(body), "snippet.toml");
  const source = /export default/.test(body) ? body
    : /^\s*(rules|overrides|extends):/m.test(body) ? `export default {\n${body}\n};`
    : `export default { rules: {\n${body}\n} };`;
  return parseConfig(evaluateConfigSource(`import { choice, defineConfig, noul, score } from "@kelbie/hunch";\n${source}`), "snippet.ts");
}

test("every config snippet in the docs loads", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const file of written) {
    for (const m of readFileSync(file, "utf8").matchAll(/```(ts|toml)\n([\s\S]*?)```/g)) {
      const body = m[2]!;
      // TypeScript blocks that describe a result shape rather than configure Hunch.
      if (m[1] === "ts" && !/defineConfig|noul\(|choice\(|score\(|^\s*"[^"]+":|^\s*rules:/m.test(body)) continue;
      checked++;
      try { loadSnippet(m[1]!, body); }
      catch (e) { failures.push(`${relative(ROOT, file)}:\n${body.slice(0, 200)}\n    ${(e as Error).message}`); }
    }
  }
  expect(failures).toEqual([]);
  expect(checked).toBeGreaterThan(10);
});

const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");

test("every relative link in the skill and README lands on a file and heading that exist", () => {
  const failures: string[] = [];
  for (const file of docs) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\]\((?!https?:|mailto:)([^)\s]*)\)/g)) {
      const [path, anchor] = m[1]!.split("#") as [string, string | undefined];
      const target = path ? join(dirname(file), path) : file;
      if (!existsSync(target)) { failures.push(`${relative(ROOT, file)}: ${m[1]} (no such file)`); continue; }
      if (!anchor || statSync(target).isDirectory()) continue;
      const body = readFileSync(target, "utf8");
      const anchors = new Set([
        ...[...body.matchAll(/^#{1,6} (.+)$/gm)].map((h) => slug(h[1]!)),
        ...[...body.matchAll(/<!-- case: ([\w-]+) -->/g)].map((c) => c[1]!),
        ...[...body.matchAll(/<a id="([\w-]+)"><\/a>/g)].map((a) => a[1]!),
      ]);
      if (!anchors.has(anchor)) failures.push(`${relative(ROOT, file)}: ${m[1]} (no such heading)`);
    }
  }
  expect(failures).toEqual([]);
});

test("every verb the skill routes to has its reference and captured examples", () => {
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const verbs = [...skill.matchAll(/^\| `(\w+)` \| .* \| \[(\w+)\.md\]\(references\/\w+\.md\) \|$/gm)].map((m) => ({ verb: m[1]!, ref: m[2]! }));
  expect(verbs.map((v) => v.verb)).toEqual(["setup", "config", "rules", "install", "check", "packs", "find", "doctor", "eval", "operator"]);
  for (const { ref } of verbs) expect(existsSync(join(SKILL, "references", `${ref}.md`))).toBe(true);
  for (const command of ["init", "config", "check", "find", "install", "doctor", "eval"]) expect(existsSync(join(SKILL, "examples", `${command}.md`))).toBe(true);
  // Every CLI command is reachable from the skill.
  for (const command of COMMANDS) expect(skill.includes(`\`${command}`) || command === "app").toBe(true);
});

test("the config reference documents every option the schema accepts", () => {
  const reference = readFileSync(join(SKILL, "references/config.md"), "utf8");
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const budget = (configSchema.shape.budget as unknown as { unwrap(): { shape: Record<string, unknown> } }).unwrap().shape;
  const review = configSchema.shape.review.unwrap().shape;
  for (const key of [...Object.keys(configSchema.shape), ...Object.keys(budget), ...Object.keys(review)]) {
    expect(reference).toContain(`\`${key}\``);
    if (kebab(key) !== key) expect(reference).toContain(kebab(key));
  }
});

test("SKILL.md fits the Agent Skills limits, so installers and agents load all of it", () => {
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!;
  expect(/^name: hunch$/m.test(front)).toBe(true);
  const description = /^description: (.+)$/m.exec(front)![1]!;
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(skill.split("\n").length).toBeLessThan(500);
  const version = /version: "([^"]+)"/.exec(front)![1];
  expect(version).toBe(JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")).version);
});
