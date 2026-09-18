#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  check,
  clientFromEnv,
  collectSources,
  FACETS,
  find,
  findMarkdown,
  findPulls,
  findText,
  pullsMarkdown,
  pullsText,
  type Facet,
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
  diffExcerpt,
  unreviewableFiles,
  toWorkflowCommands,
  underPaths,
  inScope,
  rulesFor,
  windowHunk,
  type Hunk,
  type JevClient,
  type Lock,
  type RepoReader,
} from "../../core/src/index.js";
import { spawnSync } from "node:child_process";
import { branchDiff, localRepo, gitRepo, git } from "./local.js";
import { GENERAL_TEMPLATE, GITHUB_WORKFLOW, TOML_TEMPLATE, TS_TEMPLATE } from "./templates.js";
import { runAppCommand } from "./setup/command.js";
import { resolveConfig } from "./inline.js";
import { VERSION } from "./version.js";
import { chooseCompiler } from "./pick.js";
import { compilerId, describeChoice, extractorFor } from "./compilers.js";
import { diagnose, parseRemote, report } from "./doctor.js";
import { askWizard, clackIo, detectPreset, existingKey, ghReady, hasGuidance, interactive, nextSteps, setRepoSecret, writeKey, type WizardAnswers } from "./setup/wizard.js";


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

type Opts = Record<string, any>;

/**
 * One command, one set of flags. Everything used to come through a single parseArgs call listing
 * every option in the tool, so `hunch init --facet edit --min 0.9` parsed cleanly and did nothing,
 * and `hunch eval` with no directory failed later with an ENOENT instead of saying what was
 * missing. Commander scopes options to the command that reads them and rejects the rest.
 */
function buildProgram(): Command {
  const program = new Command();
  program
    .name("hunch")
    .description("Code review for the mistakes type checkers and linters miss.\nWrite rules in plain English; Jev checks your code against them.")
    .version(VERSION, "-v, --version", "print the version")
    .option("--cwd <dir>", "run as if started in this directory")
    .showHelpAfterError('(run "hunch <command> --help" for that command\'s options)')
    .configureHelp({ showGlobalOptions: true });

  const root = () => (program.opts().cwd as string | undefined) ?? process.cwd();
  const repoFor = (opts: Opts) => (opts.policyRef ? gitRepo(root(), opts.policyRef) : localRepo(root()));

  program
    .command("check")
    .description("review the lines this branch changed, against your rules")
    .argument("[paths...]", "only review changes under these paths")
    .option("--base <ref>", "branch to compare against", process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main")
    .option("--head <ref>", "compare against this ref instead of the working tree")
    .option("--staged", "review staged changes only", false)
    .option("--diff <file>", "review a saved unified diff instead of git")
    .option("--all", "review whole files, not just what changed", false)
    .option("--task <text>", "what the change is meant to do; sent with every hunk")
    .option("--reporter <format>", "text, markdown, json, sarif or github", process.env.GITHUB_ACTIONS ? "github" : "text")
    .option("--code", "print the changed lines under each finding", false)
    .option("--dry-run", "count files, hunks and questions without calling Jev", false)
    .option("--config <json|file|->", "rules as JSON instead of a config file; repeatable", collect, [])
    .option("--rule <id=text>", "add one plain-English rule for this run; repeatable", collect, [])
    .option("--policy-ref <ref>", "read config and lock from this ref (the App uses the base commit)")
    .addHelpText("after", `
Examples:
  hunch check                                 review this branch against origin/main
  hunch check --staged                        review what you are about to commit
  hunch check --base main --head feature/x    review one branch against another
  hunch check --all app/features              review whole files under a path
  hunch check --rule api/errors="Keep the code field on error responses."
  hunch check --config rules.json --reporter json`)
    .action((paths: string[], opts: Opts, command: Command) =>
      runCheck(paths, { ...opts, baseGiven: command.getOptionValueSource("base") === "cli" }, root(), repoFor(opts)));

  program
    .command("find")
    .description("find the code a change would touch, anywhere in the repo, and print it")
    .argument("<task>", "what you are about to do, in your own words")
    .argument("[paths...]", "only search under these paths")
    .option("--head <ref>", "search a branch or tag instead of the working tree")
    .option("--facet <list>", "only ask these: edit, contract, caller, test, precedent")
    .option("--min <score>", "drop matches below this score", "0.5")
    .option("--top <n>", "keep at most this many matches per facet", "12")
    .option("--lines <n>", "lines of each passage to print in the terminal", "40")
    .option("--no-code", "print locations only")
    .option("--concurrency <n>", "requests in flight, 1 to 32", "8")
    .option("--reporter <format>", "markdown, text or json (default: text at a terminal, markdown when redirected)")
    .option("--prs", "also ask whether an open pull request already does this", false)
    .option("--pr-max <n>", "pull request diffs to read", "10")
    .option("--drafts", "include draft pull requests", false)
    .option("--dry-run", "count chunks and requests without calling Jev", false)
    .addHelpText("after", `
Examples:
  hunch find "add a rate limit to the upload endpoint"
  hunch find "warn on the onchain receive QR" --prs
  hunch find "rework the feed cache" src/feed --facet test,precedent
  hunch find "add a rate limit" > context.md      Markdown, to hand to a coding agent`)
    .action((task: string, paths: string[], opts: Opts) => runFind(task, paths, opts, root(), repoFor(opts)));

  program
    .command("compile")
    .description("turn skills and AGENTS.md into review questions, saved in hunch.lock")
    .option("--with <agent>", "claude, codex or gateway; skips the question")
    .option("--effort <level>", "how hard the agent should think")
    .option("--model <name>", "model for the compiling agent")
    .option("--force", "recompile sources that have not changed", false)
    .addHelpText("after", `
Examples:
  hunch compile                  asks which installed agent to use
  hunch compile --with claude
  hunch compile --force          rebuild every source`)
    .action((opts: Opts) => runCompile(opts, root(), localRepo(root())));

  program
    .command("init")
    .description("write a config, and optionally a pull request workflow")
    .option("--preset <kind>", "ts, rust or general; skips the question")
    .option("--github", "also write .github/workflows/hunch.yml", false)
    .addHelpText("after", `
Examples:
  hunch init                 asks where reviews should run, and for a key
  hunch init --preset ts     write hunch.config.ts and ask nothing
  hunch init --github        add the Actions workflow too`)
    .action((opts: Opts) => runInit(opts, root()));

  program
    .command("doctor")
    .description("say why this repository is not being reviewed")
    .option("--app <slug>", "the App to look for", "hunch-review")
    .action((opts: Opts) => runDoctor(opts, root()));

  program
    .command("eval")
    .description("measure each rule's precision and recall on labelled .diff examples")
    .argument("<dir>", "directory of .diff fixtures")
    .option("--config <json|file|->", "rules as JSON instead of a config file; repeatable", collect, [])
    .option("--rule <id=text>", "add one plain-English rule for this run; repeatable", collect, [])
    .action((dir: string, opts: Opts) => runEval(root(), dir, { config: opts.config, rules: opts.rule }));

  const app = program
    .command("app")
    .description("register and connect your own deployment of the GitHub App");
  app
    .command("register")
    .description("register a GitHub App from a manifest, in your browser")
    .requiredOption("--name <name>", "the App's name")
    .requiredOption("--webhook-url <url>", "https://HOST/api/webhook")
    .option("--organization <org>", "register it to an organisation instead of your account")
    .option("--public", "let any account install it", false)
    .action((opts: Opts) => runAppCommand(["register", ...flagsOf(opts)]));
  app
    .command("connect")
    .description("upload production credentials and set the webhook")
    .requiredOption("--app-id <id>", "the App ID from register")
    .requiredOption("--webhook-url <url>", "https://HOST/api/webhook")
    .requiredOption("--vercel-project <name>", "Vercel project to upload secrets to")
    .requiredOption("--scope <team>", "Vercel team scope")
    .option("--private-key <path>", "PEM file, for an App connecting for the first time")
    .action((opts: Opts) => runAppCommand(["connect", ...flagsOf(opts)]));

  program.addHelpText("after", `
Model access (no key is ever written to your config):
  AI_GATEWAY_API_KEY   Vercel AI Gateway, the default provider
  TYPESAFE_API_KEY     TypeSafe directly, with provider = "typesafe" in your config

Docs: https://github.com/Kelbie/hunch`);
  return program;
}

/** Repeatable options collect rather than overwrite, so `--rule a --rule b` keeps both. */
const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Back to the argv the App setup command already parses, so its flow is untouched. */
const flagsOf = (opts: Opts): string[] =>
  Object.entries(opts).flatMap(([k, v]) => {
    const flag = `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (v === false || v === undefined) return [];
    return v === true ? [flag] : [flag, String(v)];
  });

async function main() {
  loadEnvFiles();
  await buildProgram().parseAsync(process.argv);
}


/**
 * Side effects the wizard promised: the key, the optional compile, and the ordered next steps.
 * A failure here leaves the config in place and says what to finish by hand, so setup is resumable.
 */
async function finishWizard(root: string, answers: WizardAnswers, opts: { file: string }) {
  const io = clackIo();
  const key = answers.key;
  let keyDeferred = key.kind === "later";
  if (key.kind !== "later") {
    const name = key.kind === "gateway" ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY";
    try {
      const path = writeKey(root, name, key.value);
      console.error(`hunch: wrote ${name} to ${path.replace(`${root}/`, "")} (git-ignored).`);
    } catch (e) {
      keyDeferred = true;
      console.error(`hunch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let secretSet = false;
  if (answers.target === "actions" && key.kind === "gateway" && ghReady()) {
    try { setRepoSecret("AI_GATEWAY_API_KEY", key.value); secretSet = true; }
    catch (e) { console.error(`hunch: ${e instanceof Error ? e.message : String(e)}`); }
  }
  let compiled = false;
  if (answers.compile) {
    console.error("hunch: run `npx @kelbie/hunch compile` to turn AGENTS.md and skills into review questions, then commit hunch.lock.");
    compiled = existsSync(join(root, LOCK_FILE));
  }
  io.note(nextSteps(answers.target, { configFile: opts.file, compiled, secretSet, keyDeferred }), "Next");
  io.outro("Hunch is configured.");
}

/** A finding's diff excerpt as plain unified-diff lines, for `--reporter json --code`. */
function excerptText(hunks: Hunk[], f: Parameters<typeof diffExcerpt>[1]): string | undefined {
  const e = diffExcerpt(hunks, f);
  return e && [...e.lines.map((l) => `${l.kind}${l.text}`), ...(e.omitted ? [`… ${e.omitted} more lines`] : [])].join("\n");
}

/** A counter for someone watching. Silent when stderr is redirected, where \r is just noise. */
function progress(message: string, last: boolean) {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r  ${message}${last ? "\n" : ""}`);
}

/** `gh api`, shared by doctor and find. Any non-zero exit is "no answer", including 404. */
async function ghApi(args: string[]): Promise<{ ok: boolean; body: string }> {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, body: r.stdout ?? "" };
}

/** Not every project is a git repository; that is an answer, not an error to print. */
function originUrl(root: string): string | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
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

async function runCheck(paths: string[], opts: Opts, root: string, repo: RepoReader) {
  const loaded = await resolveConfig(repo, { config: opts.config, rules: opts.rule });
  if (!loaded && opts.policyRef) {
    // The PR that adds Hunch: its base has no config yet, so there is no trusted policy to apply.
    console.log(opts.reporter === "github"
      ? "::notice title=Hunch::Hunch isn't set up on the base branch yet. PRs are reviewed once hunch.config.ts or hunch.toml is merged."
      : "hunch: no config on the base branch yet; nothing to review.");
    return;
  }
  if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`, or pass rules with --config or --rule.");
  const { config } = loaded;
  if (!["text", "markdown", "json", "sarif", "github"].includes(opts.reporter!)) return fail("Unknown reporter");
  const under = underPaths(paths);
  let diff = "";
  let hunks: Hunk[];
  if (opts.all) {
    if (opts.diff || opts.staged || opts.baseGiven) return fail("--all reviews whole files; drop --base, --diff and --staged");
    const source = opts.head ? gitRepo(root, opts.head) : localRepo(root);
    const full = await repoHunks(source, config, paths);
    hunks = full.hunks;
    if (full.skipped.length) console.error(`hunch: skipped ${full.skipped.length} unreadable, binary or oversized file(s)`);
    const files = new Set(hunks.map((h) => h.file)).size;
    console.error(`hunch: reviewing ${files} file(s) as ${hunks.length} chunk(s) from ${opts.head ?? "the working tree"}` +
      (hunks.length > config.budget.maxHunks ? `; only the first ${config.budget.maxHunks} fit budget.maxHunks` : ""));
  } else {
  if ([opts.diff, opts.staged, opts.head].filter(Boolean).length > 1) return fail("Choose only one of --diff, --staged or --head");
  if (opts.head) {
    const base = git(root, ["rev-parse", "--verify", "--end-of-options", `${opts.base}^{commit}`]).trim();
    const head = git(root, ["rev-parse", "--verify", "--end-of-options", `${opts.head}^{commit}`]).trim();
    diff = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"]);
  } else diff = opts.diff ? readFileSync(opts.diff, "utf8") : branchDiff(root, opts.base!, opts.staged);
  if (diff.length > 16_000_000) return fail("Diff exceeds 16 MB; review a smaller change");
  hunks = parseHunks(diff).filter((h) => under(h.file));
  }
  const lockText = await repo.read(LOCK_FILE);
  const lock = lockText ? parseLock(lockText) : null;
  const stale = await staleSources(lock, config, repo);
  const task = opts.task ?? prTaskFromEvent();
  if (opts.dryRun) {
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
    onProgress: (d, t) => opts.reporter === "text" && process.stderr.write(`\r  checked ${d}/${t} hunks`),
  });
  if (opts.reporter === "text") process.stderr.write("\n");
  if (stale.length) result.complete = false;
  const unreviewable = unreviewableFiles(diff).filter(inScope(config));
  if (unreviewable.length) { result.complete = false; result.notices.push(`Binary, rename-only or mode changes need human review: ${unreviewable.join(", ")}.`); }
  if (stale.length) result.notices.push(`hunch.lock is stale for: ${stale.join(", ")}. Run \`npx @kelbie/hunch compile\`.`);

  switch (opts.reporter) {
    case "markdown":
      console.log(summaryMarkdown(result));
      break;
    case "json":
      console.log(JSON.stringify(opts.code ? { ...result, findings: result.findings.map((f) => ({ ...f, diff: excerptText(hunks, f) })) } : result, null, 2));
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
        hunks: opts.code ? hunks : undefined,
      }));
  }
  const failed = config.failOnError && result.findings.some((f) => f.level === "error");
  process.exitCode = !result.complete ? 2 : failed ? 1 : 0;
  return;
}

async function runFind(task: string, paths: string[], opts: Opts, root: string, repo: RepoReader) {
  const loaded = await loadConfig(repo);
  if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`.");
  const { config } = loaded;
  // A person at a terminal gets the coloured report; a redirect gets Markdown, because the
  // reason to redirect this is to hand it to something that reads Markdown. Either way the
  // code is in the output — that is what find is for.
  const reporter: string = opts.reporter ?? (process.stdout.isTTY ? "text" : "markdown");
  if (!["text", "markdown", "json"].includes(reporter)) return fail("Unknown --reporter for find; use markdown, text or json");
  const style = {
    color: process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb",
    width: Math.min(process.stdout.columns || 100, 120),
  };
  const facets = String(opts.facet ?? "").split(",").map((f: string) => f.trim()).filter(Boolean) as Facet[];
  const unknown = facets.filter((f: Facet) => !FACETS.includes(f));
  if (unknown.length) return fail(`Unknown --facet ${unknown.join(", ")}; choose from ${FACETS.join(", ")}`);
  const minScore = opts.min === undefined ? 0.5 : Number(opts.min);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) return fail("--min must be between 0 and 1");
  const top = opts.top === undefined ? 12 : Number(opts.top);
  if (!Number.isInteger(top) || top < 1) return fail("--top must be a positive whole number");
  // Not config.budget: that is sized to keep a PR review inside a worker timeout, and
  // inheriting its request cap would end a repository sweep partway through without the
  // person having asked for that.
  const concurrency = opts.concurrency === undefined ? 8 : Number(opts.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return fail("--concurrency must be between 1 and 32");
  const maxLines = opts.lines === undefined ? 40 : Number(opts.lines);
  if (!Number.isInteger(maxLines) || maxLines < 1) return fail("--lines must be a positive whole number");

  const source = opts.head ? gitRepo(root, opts.head) : localRepo(root);
  const { hunks, skipped } = await repoHunks(source, config, paths);
  if (skipped.length) console.error(`hunch: skipped ${skipped.length} unreadable, binary or oversized file(s)`);
  const files = new Set(hunks.map((h) => h.file)).size;
  if (opts.dryRun) {
    console.log(`hunch: dry run, nothing sent. ${files} file(s) as ${hunks.length} chunk(s): ${hunks.length} request(s), ${(facets.length || FACETS.length) * hunks.length} question(s).`);
    return;
  }
  if (!hunks.length) return fail("nothing in scope to search; check `include` and the paths you passed.");
  console.error(`hunch: searching ${files} file(s) as ${hunks.length} chunk(s) from ${opts.head ?? "the working tree"}`);

  let client: JevClient | undefined;
  const jev = { evaluate: (req: Parameters<JevClient["evaluate"]>[0]) => (client ??= clientFromEnv(config)).evaluate(req) };

  // Asked first: if this work is already open as a pull request, the person should hear it
  // before reading a hundred lines of code they may not need to touch.
  let existingMd = "";
  let existingText = "";
  let existingComplete = true;
  let existingWork: Awaited<ReturnType<typeof findPulls>> | undefined;
  if (opts.prs) {
    const remote = parseRemote(originUrl(root));
    if (!remote) return fail("--prs needs a github.com `origin` remote to list pull requests from.");
    const prMax = opts.prMax === undefined ? 10 : Number(opts.prMax);
    if (!Number.isInteger(prMax) || prMax < 1) return fail("--pr-max must be a positive whole number");
    console.error(`hunch: checking open pull requests on ${remote.owner}/${remote.repo}`);
    const pulls = await findPulls({
      task,
      slug: `${remote.owner}/${remote.repo}`,
      io: { gh: ghApi },
      client: jev,
      model: config.model,
      maxInspected: prMax,
      includeDrafts: opts.drafts,
      onProgress: (d, t) => progress(`read ${d}/${t} pull request titles`, d === t),
    });
    existingMd = pullsMarkdown(pulls);
    existingText = pullsText(pulls, style);
    existingComplete = pulls.complete;
    existingWork = pulls;
  }

  const result = await find({
    task,
    hunks,
    model: config.model,
    facets: facets.length ? facets : undefined,
    minScore,
    perFacet: top,
    budget: { concurrency, maxRequests: hunks.length, timeoutSeconds: 3600 },
    client: jev,
    onProgress: (d, t) => progress(`searched ${d}/${t} chunks`, d === t),
  });
  if (reporter === "json") console.log(JSON.stringify({ ...result, existingWork }, null, 2));
  else if (reporter === "text") console.log(findText(result, { ...style, code: !!opts.code, maxLines, existing: existingText }));
  else console.log(findMarkdown(task, result, existingMd));
  // An unfinished sweep means the answer is "here is some of it", which callers must be able to
  // see — including an unchecked pull request list, since that cannot prove nothing is open.
  process.exitCode = result.complete && existingComplete ? 0 : 2;
  return;
}

async function runCompile(opts: Opts, root: string, repo: RepoReader) {
  const loaded = await loadConfig(repo);
  if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`.");
  const { config } = loaded;
  const docs = await collectSources(config, repo);
  if (!docs.length) return fail("no skills, AGENTS.md or docs found to compile.");
  const previous = readLock(root);
  const choice = await chooseCompiler({ with: opts.with, effort: opts.effort, model: opts.model, previous: previous?.compiler.model });
  if (!choice) return fail("compile cancelled.");
  const model = compilerId(choice, config.compileModel);
  console.error(`hunch: compiling ${docs.length} source(s) with ${describeChoice(choice, config.compileModel)}`);
  const lock = await compileSources(docs, {
    extractor: extractorFor(choice, config),
    model,
    previous,
    force: opts.force,
    onSource: (id, reused) => console.error(`  ${reused ? "unchanged" : "compiled "}  ${id}`),
  });
  lock.selectionHash = await selectionHash(config);
  writeFileSync(join(root, LOCK_FILE), serializeLock(lock));
  const rules = lock.sources.reduce((n, s) => n + s.rules.length, 0);
  const skipped = lock.sources.reduce((n, s) => n + s.notChecked.length, 0);
  console.error(`hunch: wrote ${LOCK_FILE}: ${rules} rules, ${skipped} guidance items not checkable per hunk. Review and commit it.`);
  return;
}

async function runInit(opts: Opts, root: string) {
  // One choice, one flag: --rust/--ts/--general were three booleans for a single decision, and
  // nothing stopped you passing two of them.
  const PRESETS = ["ts", "rust", "general"] as const;
  if (opts.preset && !PRESETS.includes(opts.preset)) return fail(`Unknown --preset ${opts.preset}; choose from ${PRESETS.join(", ")}`);
  const existing = ["hunch.toml", "hunch.config.ts"].filter(name => existsSync(join(root, name)));
  const workflow = join(root, ".github/workflows/hunch.yml");
  if (existing.length > 1) return fail("Keep exactly one of hunch.config.ts and hunch.toml.");
  // Any explicit flag, a pipe or CI keeps the exact non-interactive behaviour scripts rely on.
  const chosen = Boolean(opts.preset) || opts.github === true;
  const answers = chosen || !interactive() ? null : await askWizard(clackIo(), {
    root, detected: detectPreset(root), configExists: existing.length > 0,
    guidance: hasGuidance(root), keyPresent: existingKey(root) !== null,
  });
  if (!chosen && interactive() && !answers) return fail("setup cancelled; nothing was written.");
  const preset = answers?.preset ?? opts.preset;
  const rust = preset ? preset === "rust" : existsSync(join(root, "Cargo.toml"));
  const ts = preset ? preset === "ts" : !rust && existsSync(join(root, "package.json"));
  const file = ts ? "hunch.config.ts" : "hunch.toml";
  const wantsWorkflow = opts.github || answers?.target === "actions";
  if (existing.length && !wantsWorkflow) return fail("a hunch config already exists. Use `npx @kelbie/hunch init --github` to add only the workflow.");
  if (wantsWorkflow && existsSync(workflow)) return fail(".github/workflows/hunch.yml already exists; it was not overwritten.");
  if (!existing.length) {
    writeFileSync(join(root, file), ts ? TS_TEMPLATE : rust ? TOML_TEMPLATE : GENERAL_TEMPLATE, { flag: "wx" });
    console.error(`hunch: wrote ${file}.`);
  }
  if (wantsWorkflow) {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(workflow, GITHUB_WORKFLOW, { flag: "wx" });
    if (!answers) console.error("hunch: wrote .github/workflows/hunch.yml. Add AI_GATEWAY_API_KEY under repository Settings > Secrets and variables > Actions, then commit the config and workflow to your base branch.");
    else console.error("hunch: wrote .github/workflows/hunch.yml.");
  }
  if (!answers) {
    console.error("hunch: if this repository has skills or AGENTS.md, run `npx @kelbie/hunch compile` and commit hunch.lock too.");
    return;
  }
  return finishWizard(root, answers, { file });
}

async function runDoctor(opts: Opts, root: string) {
  const checks = await diagnose({
    gh: ghApi,
    local: (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } },
    remoteUrl: () => originUrl(root),
    env: process.env,
  }, { slug: opts.app ?? "hunch-review" });
  const { text, failed } = report(checks);
  console.log(text);
  process.exitCode = failed ? 1 : 0;
  return;
}
