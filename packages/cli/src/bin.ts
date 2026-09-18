#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  check,
  clientFromEnv,
  collectSources,
  compileSources,
  LOCK_FILE,
  loadConfig,
  parseHunks,
  parseLock,
  repoHunks,
  serializeLock,
  selectionHash,
  staleSources,
  summaryMarkdown,
  toSarif,
  toText,
  toWorkflowCommands,
  underPaths,
  inScope,
  rulesFor,
  windowHunk,
  type Hunk,
  type JevClient,
  type Lock,
} from "../../core/src/index.js";
import { branchDiff, localRepo, gitRepo, git } from "./local.js";
import { GENERAL_TEMPLATE, GITHUB_WORKFLOW, TOML_TEMPLATE, TS_TEMPLATE } from "./templates.js";
import { runAppCommand } from "./setup/command.js";
import { resolveConfig } from "./inline.js";
import { chooseCompiler } from "./pick.js";
import { compilerId, describeChoice, extractorFor } from "./compilers.js";

const VERSION = "0.7.0";

const HELP = `hunch ${VERSION}: gut-check a diff against your rules and skills with TypeSafe's Jev

Usage: npx @kelbie/hunch <command>, or hunch <command> once installed
  hunch check [--base main] [--staged] [--diff file] [paths…]   review a diff (default: this branch vs main)
  hunch check --all [--head ref] [paths…]   review whole files at a branch or the working tree
        [--dry-run]   count files, hunks and questions without calling Jev
        [--task "…"] [--reporter text|markdown|json|sarif|github]
        [--config <json|file|->] [--rule id=text …]   rules without a config file (see below)
  hunch compile [--force]          turn skills + AGENTS.md into hunch.lock (uses an LLM once)
        [--with claude|codex|gateway] [--effort level] [--model name]
        asks which installed agent to use; --with skips the question
  hunch init [--rust|--ts|--general] [--github]  write config and optionally a PR workflow
  hunch eval <dir>                 precision/recall per rule over labelled .diff fixtures
  hunch app --help                 register and connect a self-hosted GitHub App

Rules without installing
  --config takes the same options as hunch.config.ts as JSON: inline, a file path,
  or - to read stdin. It replaces the repository's config and skips skills and
  AGENTS.md unless it enables them. Repeat it to layer overrides; later values win. --rule id="plain English" adds a warn rule and
  can be repeated. Example:
    npx @kelbie/hunch check --rule api/errors="Error responses keep their code field."
    npx @kelbie/hunch check --config rules.json --config '{"zeroDataRetention":false}' 

Environment
  AI_GATEWAY_API_KEY   Vercel AI Gateway (default Jev provider; compile only with --with gateway)
  TYPESAFE_API_KEY     TypeSafe direct (provider = "typesafe")
  No key is written to your config. Export the key in your shell or secret manager.`;

/**
 * Loads `.env` files from the working directory in Bun's order, so `npx hunch` (Node) sees
 * the same credentials as `bun run hunch` or `bunx hunch`. Earlier files win; the real
 * environment always wins.
 */
function loadEnvFiles(dir = process.cwd()) {
  if (process.versions.bun) return; // Bun has already loaded them.
  const mode = process.env.NODE_ENV || "development";
  const files = [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"];
  for (const f of files) if (existsSync(join(dir, f))) process.loadEnvFile(join(dir, f));
}

async function main() {
  loadEnvFiles();
  const [cmd = "help", ...rest] = process.argv.slice(2);
  if (cmd === "app") return runAppCommand(rest);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      base: { type: "string", default: process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main" },
      "policy-ref": { type: "string" },
      head: { type: "string" },
      staged: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      diff: { type: "string" },
      task: { type: "string" },
      reporter: { type: "string", default: process.env.GITHUB_ACTIONS ? "github" : "text" },
      force: { type: "boolean", default: false },
      with: { type: "string" },
      effort: { type: "string" },
      model: { type: "string" },
      config: { type: "string", multiple: true },
      rule: { type: "string", multiple: true },
      general: { type: "boolean", default: false },
      github: { type: "boolean", default: false },
      rust: { type: "boolean", default: false },
      ts: { type: "boolean", default: false },
      cwd: { type: "string", default: process.cwd() },
    },
  });
  const root = values.cwd!;
  const repo = values["policy-ref"] ? gitRepo(root, values["policy-ref"]) : localRepo(root);

  switch (cmd) {
    case "check": {
      const loaded = await resolveConfig(repo, { config: values.config, rules: values.rule });
      if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`, or pass rules with --config or --rule.");
      const { config } = loaded;
      if (!["text", "markdown", "json", "sarif", "github"].includes(values.reporter!)) return fail("Unknown reporter");
      const under = underPaths(positionals);
      let diff = "";
      let hunks: Hunk[];
      if (values.all) {
        if (values.diff || values.staged || rest.some((a) => a === "--base" || a.startsWith("--base="))) return fail("--all reviews whole files; drop --base, --diff and --staged");
        const source = values.head ? gitRepo(root, values.head) : localRepo(root);
        const full = await repoHunks(source, config, positionals);
        hunks = full.hunks;
        if (full.skipped.length) console.error(`hunch: skipped ${full.skipped.length} unreadable, binary or oversized file(s)`);
        const files = new Set(hunks.map((h) => h.file)).size;
        console.error(`hunch: reviewing ${files} file(s) as ${hunks.length} chunk(s) from ${values.head ?? "the working tree"}` +
          (hunks.length > config.budget.maxHunks ? `; only the first ${config.budget.maxHunks} fit budget.maxHunks` : ""));
      } else {
      if ([values.diff, values.staged, values.head].filter(Boolean).length > 1) return fail("Choose only one of --diff, --staged or --head");
      if (values.head) {
        const base = git(root, ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`]).trim();
        const head = git(root, ["rev-parse", "--verify", "--end-of-options", `${values.head}^{commit}`]).trim();
        diff = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"]);
      } else diff = values.diff ? readFileSync(values.diff, "utf8") : branchDiff(root, values.base!, values.staged);
      if (diff.length > 16_000_000) return fail("Diff exceeds 16 MB; review a smaller change");
      hunks = parseHunks(diff).filter((h) => under(h.file));
      }
      const lockText = await repo.read(LOCK_FILE);
      const lock = lockText ? parseLock(lockText) : null;
      const stale = await staleSources(lock, config, repo);
      const task = values.task ?? prTaskFromEvent();
      if (values["dry-run"]) {
        const reviewed = hunks.filter((h) => h.status !== "deleted" && inScope(config)(h.file)).flatMap((h) => windowHunk(h)).slice(0, config.budget.maxHunks);
        const questions = reviewed.reduce((n, h) => n + Math.min(rulesFor(h.file, config, lock).jev.length, config.budget.maxRulesPerHunk), 0);
        console.log(`hunch: dry run, nothing sent. ${new Set(reviewed.map((h) => h.file)).size} file(s) as ${reviewed.length} hunk(s): up to ${questions} question(s) in ${Math.min(reviewed.length, config.budget.maxRequests)} request(s). Budget: ${config.budget.maxHunks} hunks, ${config.budget.maxRequests} requests, ${config.budget.timeoutSeconds}s.`);
        return;
      }
      // Created on first request, so a diff with nothing to review needs no API key.
      let client: JevClient | undefined;
      const result = await check({
        config,
        hunks,
        task,
        lock,
        client: { evaluate: (req) => (client ??= clientFromEnv(config)).evaluate(req) },
        readFile: (p) => repo.read(p),
        onProgress: (d, t) => values.reporter === "text" && process.stderr.write(`\r  checked ${d}/${t} hunks`),
      });
      if (values.reporter === "text") process.stderr.write("\n");
      if (stale.length) result.complete = false;
      if (/^(?:Binary files |GIT binary patch|rename from |old mode )/m.test(diff)) { result.complete = false; result.notices.push("Binary, rename metadata or mode changes require human review."); }
      if (stale.length) result.notices.push(`hunch.lock is stale for: ${stale.join(", ")}. Run \`npx @kelbie/hunch compile\`.`);

      switch (values.reporter) {
        case "markdown":
          console.log(summaryMarkdown(result));
          break;
        case "json":
          console.log(JSON.stringify(result, null, 2));
          break;
        case "sarif":
          console.log(JSON.stringify(toSarif(result.findings, VERSION), null, 2));
          break;
        case "github": {
          const cmds = toWorkflowCommands(result.findings);
          if (cmds) console.log(cmds);
          const md = summaryMarkdown(result);
          if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, { flag: "a" });
          break;
        }
        default:
          console.log(toText(result, {
            color: process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb",
            width: Math.min(process.stdout.columns || 100, 120),
          }));
      }
      const failed = config.failOnError && result.findings.some((f) => f.level === "error");
      process.exitCode = !result.complete ? 2 : failed ? 1 : 0;
      return;
    }

    case "compile": {
      const loaded = await loadConfig(repo);
      if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`.");
      const { config } = loaded;
      const docs = await collectSources(config, repo);
      if (!docs.length) return fail("no skills, AGENTS.md or docs found to compile.");
      const previous = readLock(root);
      const choice = await chooseCompiler({ with: values.with, effort: values.effort, model: values.model, previous: previous?.compiler.model });
      if (!choice) return fail("compile cancelled.");
      const model = compilerId(choice, config.compileModel);
      console.error(`hunch: compiling ${docs.length} source(s) with ${describeChoice(choice, config.compileModel)}`);
      const lock = await compileSources(docs, {
        extractor: extractorFor(choice, config),
        model,
        previous,
        force: values.force,
        onSource: (id, reused) => console.error(`  ${reused ? "unchanged" : "compiled "}  ${id}`),
      });
      lock.selectionHash = await selectionHash(config);
      writeFileSync(join(root, LOCK_FILE), serializeLock(lock));
      const rules = lock.sources.reduce((n, s) => n + s.rules.length, 0);
      const skipped = lock.sources.reduce((n, s) => n + s.notChecked.length, 0);
      console.error(`hunch: wrote ${LOCK_FILE}: ${rules} rules, ${skipped} guidance items not checkable per hunk. Review and commit it.`);
      return;
    }

    case "init": {
      if ([values.rust, values.ts, values.general].filter(Boolean).length > 1) return fail("Choose only one of --rust, --ts or --general");
      const rust = values.rust || (!values.ts && !values.general && existsSync(join(root, "Cargo.toml")));
      const ts = values.ts || (!rust && !values.general && existsSync(join(root, "package.json")));
      const file = ts ? "hunch.config.ts" : "hunch.toml";
      const existing = ["hunch.toml", "hunch.config.ts"].filter(name => existsSync(join(root, name)));
      const workflow = join(root, ".github/workflows/hunch.yml");
      if (existing.length > 1) return fail("Keep exactly one of hunch.config.ts and hunch.toml.");
      if (existing.length && !values.github) return fail("a hunch config already exists. Use `npx @kelbie/hunch init --github` to add only the workflow.");
      if (values.github && existsSync(workflow)) return fail(".github/workflows/hunch.yml already exists; it was not overwritten.");
      if (!existing.length) {
        writeFileSync(join(root, file), ts ? TS_TEMPLATE : rust ? TOML_TEMPLATE : GENERAL_TEMPLATE, { flag: "wx" });
        console.error(`hunch: wrote ${file}.`);
      }
      if (values.github) {
        mkdirSync(join(root, ".github/workflows"), { recursive: true });
        writeFileSync(workflow, GITHUB_WORKFLOW, { flag: "wx" });
        console.error("hunch: wrote .github/workflows/hunch.yml. Add AI_GATEWAY_API_KEY under repository Settings > Secrets and variables > Actions, then commit the config and workflow to your base branch.");
      }
      console.error("hunch: if this repository has skills or AGENTS.md, run `npx @kelbie/hunch compile` and commit hunch.lock too.");
      return;
    }

    case "eval":
      return runEval(root, positionals[0] ?? "hunch-fixtures", { config: values.config, rules: values.rule });

    case "version":
    case "--version":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      fail(`Unknown command: ${cmd}`);
  }
}

function readLock(root: string): Lock | null {
  const p = join(root, LOCK_FILE);
  return existsSync(p) ? parseLock(readFileSync(p, "utf8")) : null;
}

/** In GitHub Actions, use the PR title + body as `task`. */
function prTaskFromEvent(): string | undefined {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) return undefined;
  const pr = JSON.parse(readFileSync(p, "utf8")).pull_request;
  return pr ? `${pr.title}\n\n${pr.body ?? ""}`.trim() : undefined;
}

/**
 * Fixtures: `<dir>/*.diff`, each starting with `# expect: rule-a, rule-b`
 * (rules that SHOULD fire; any other rule firing counts as a false positive).
 * Prints precision/recall per rule so thresholds can be tuned before `error`.
 */
async function runEval(root: string, dir: string, inline: { config?: string[]; rules?: string[] }) {
  const repo = localRepo(root);
  const loaded = await resolveConfig(repo, inline);
  if (!loaded) return fail("no hunch config found.");
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".diff")).sort();
  if (!files.length) return fail("No .diff fixtures found");
  const lock = readLock(root);
  const stale = await staleSources(lock, loaded.config, repo);
  if (stale.length) return fail("Compile current guidance before evaluating fixtures");
  const stats = new Map<string, { tp: number; fp: number; fn: number }>();
  const bump = (rule: string, k: "tp" | "fp" | "fn") => {
    const s = stats.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
    s[k]++;
    stats.set(rule, s);
  };
  const client = clientFromEnv(loaded.config);
  for (const f of files) {
    const text = readFileSync(join(root, dir, f), "utf8");
    const expected = new Set((text.match(/^# expect:(.*)$/m)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const task = text.match(/^# task:(.*)$/m)?.[1]?.trim();
    const res = await check({ config: loaded.config, hunks: parseHunks(text), client, task, lock, readFile: (path) => repo.read(path) });
    if (!res.complete) return fail(`Fixture ${f} has incomplete coverage: ${res.notices.join("; ")}`);
    const fired = new Set(res.findings.map((x) => x.rule));
    for (const r of fired) bump(r, expected.has(r) ? "tp" : "fp");
    for (const r of expected) if (!fired.has(r)) bump(r, "fn");
    console.error(`  ${f}: fired ${[...fired].join(", ") || "nothing"}`);
  }
  console.log("\nrule                                  precision  recall   tp fp fn");
  for (const [rule, s] of [...stats].sort()) {
    const p = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 1;
    const r = s.tp + s.fn ? s.tp / (s.tp + s.fn) : 1;
    console.log(`${rule.padEnd(38)}${p.toFixed(2).padStart(9)}${r.toFixed(2).padStart(8)}   ${s.tp}  ${s.fp}  ${s.fn}`);
  }
}

function fail(msg: string) {
  console.error(`hunch: ${msg}`);
  process.exitCode = 2;
}

main().catch((e) => {
  // Provider SDK errors carry terminal colour codes; keep output plain and identical across runners.
  console.error(`hunch: ${String(e instanceof Error ? e.message : e).replace(/\x1b\[[0-9;]*m/g, "").trimEnd()}`);
  process.exitCode = 2;
});
