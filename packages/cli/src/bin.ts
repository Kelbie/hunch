#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  check,
  clientFromEnv,
  collectSources,
  compileSources,
  gatewayExtractor,
  LOCK_FILE,
  loadConfig,
  parseHunks,
  parseLock,
  serializeLock,
  selectionHash,
  staleSources,
  summaryMarkdown,
  toSarif,
  toText,
  toWorkflowCommands,
  type JevClient,
  type Lock,
} from "../../core/src/index.js";
import { branchDiff, localRepo, gitRepo, git } from "./local.js";
import { GENERAL_TEMPLATE, GITHUB_WORKFLOW, TOML_TEMPLATE, TS_TEMPLATE } from "./templates.js";
import { runAppCommand } from "./setup/command.js";

const VERSION = "0.3.3";

const HELP = `hunch ${VERSION}: gut-check a diff against your rules and skills with TypeSafe's Jev

Usage
  hunch check [--base main] [--staged] [--diff file] [--task "…"] [--reporter text|markdown|json|sarif|github]
  hunch compile [--force]          turn skills + AGENTS.md into hunch.lock (uses an LLM once)
  hunch init [--rust|--ts|--general] [--github]  write config and optionally a PR workflow
  hunch eval <dir>                 precision/recall per rule over labelled .diff fixtures
  hunch app --help                 register and connect a self-hosted GitHub App

Environment
  AI_GATEWAY_API_KEY   Vercel AI Gateway (default provider)
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
      diff: { type: "string" },
      task: { type: "string" },
      reporter: { type: "string", default: process.env.GITHUB_ACTIONS ? "github" : "text" },
      force: { type: "boolean", default: false },
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
      const loaded = await loadConfig(repo);
      if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `hunch init`.");
      const { config } = loaded;
      if (!["text", "markdown", "json", "sarif", "github"].includes(values.reporter!)) return fail("Unknown reporter");
      if ([values.diff, values.staged, values.head].filter(Boolean).length > 1) return fail("Choose only one of --diff, --staged or --head");
      let diff: string;
      if (values.head) {
        const base = git(root, ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`]).trim();
        const head = git(root, ["rev-parse", "--verify", "--end-of-options", `${values.head}^{commit}`]).trim();
        diff = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"]);
      } else diff = values.diff ? readFileSync(values.diff, "utf8") : branchDiff(root, values.base!, values.staged);
      if (diff.length > 16_000_000) return fail("Diff exceeds 16 MB; review a smaller change");
      const lockText = await repo.read(LOCK_FILE);
      const lock = lockText ? parseLock(lockText) : null;
      const stale = await staleSources(lock, config, repo);
      const task = values.task ?? prTaskFromEvent();
      // Created on first request, so a diff with nothing to review needs no API key.
      let client: JevClient | undefined;
      const result = await check({
        config,
        hunks: parseHunks(diff),
        task,
        lock,
        client: { evaluate: (req) => (client ??= clientFromEnv(config)).evaluate(req) },
        readFile: (p) => repo.read(p),
        onProgress: (d, t) => values.reporter === "text" && process.stderr.write(`\r  checked ${d}/${t} hunks`),
      });
      if (values.reporter === "text") process.stderr.write("\n");
      if (stale.length) result.complete = false;
      if (/^(?:Binary files |GIT binary patch|rename from |old mode )/m.test(diff)) { result.complete = false; result.notices.push("Binary, rename metadata or mode changes require human review."); }
      if (stale.length) result.notices.push(`hunch.lock is stale for: ${stale.join(", ")}. Run \`hunch compile\`.`);

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
          console.log(toText(result));
      }
      const failed = config.failOnError && result.findings.some((f) => f.level === "error");
      process.exitCode = !result.complete ? 2 : failed ? 1 : 0;
      return;
    }

    case "compile": {
      const loaded = await loadConfig(repo);
      if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `hunch init`.");
      const { config } = loaded;
      const docs = await collectSources(config, repo);
      if (!docs.length) return fail("no skills, AGENTS.md or docs found to compile.");
      console.error(`hunch: compiling ${docs.length} source(s) with ${config.compileModel}`);
      const lock = await compileSources(docs, {
        extractor: gatewayExtractor(config.compileModel, config.zeroDataRetention),
        model: config.compileModel,
        previous: readLock(root),
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
      if (existing.length && !values.github) return fail("a hunch config already exists. Use `hunch init --github` to add only the workflow.");
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
      console.error("hunch: if this repository has skills or AGENTS.md, run `hunch compile` and commit hunch.lock too.");
      return;
    }

    case "eval":
      return runEval(root, positionals[0] ?? "hunch-fixtures");

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
async function runEval(root: string, dir: string) {
  const repo = localRepo(root);
  const loaded = await loadConfig(repo);
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
