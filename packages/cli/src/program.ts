import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  check,
  clientFromEnv,
  collectSources,
  FACETS,
  DEFAULT_IGNORE,
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
  staleNotice,
  hashDoc,
  parseConfig,
  applyPresets,
  policyRules,
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
import { branchDiff, commitOf, localRepo, gitRepo, git, readStagedFile } from "./local.js";
import { defaultAnswers, GITHUB_WORKFLOW, PRESET_NAMES, renderConfig, type ConfigAnswers, type PresetName } from "./templates.js";
import { runAppCommand } from "./setup/command.js";
import { resolveConfig } from "./inline.js";
import { configText, explainRule, explanationText, inspectConfig } from "./config.js";
import { VERSION } from "./version.js";
import { chooseCompiler } from "./pick.js";
import { compilerId, describeChoice, extractorFor } from "./compilers.js";
import { diagnose, parseRemote, report } from "./doctor.js";
import { askWizard, clackIo, detectPreset, existingKey, ghReady, hasGuidance, installSkill, interactive, nextSteps, presetsFor, setRepoSecret, SKILL_INSTALL, writeKey, type Target, type WizardAnswers } from "./setup/wizard.js";


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
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("hunch")
    .description("Search code by behavior and review changes against plain-English rules with Jev.")
    .version(VERSION, "-v, --version", "print the version")
    .option("--cwd <dir>", "run as if started in this directory")
    .showHelpAfterError('(run "hunch <command> --help" for that command\'s options)')
    .configureHelp({ showGlobalOptions: true });

  const root = () => (program.opts().cwd as string | undefined) ?? process.cwd();
  const repoFor = (opts: Opts) => (opts.policyRef ? gitRepo(root(), opts.policyRef, "--policy-ref") : localRepo(root()));

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
    .option("--only <ids>", "ask only these rules, comma-separated; to try a rule you just wrote")
    .option("--policy-ref <ref>", "read config and lock from this ref (the App uses the base commit)")
    .addHelpText("after", `
Exits 0 when the review is complete, 1 when failOnError is set and an error-level concern was
found, and 2 when the review is incomplete or could not run.

Examples:
  hunch check                                 review this branch against origin/main
  hunch check --staged                        review what you are about to commit
  hunch check --base main --head feature/x    review one branch against another
  hunch check --all app/features              review whole files under a path
  hunch check --rule api/errors="Keep the code field on error responses."
  hunch check --config rules.json --reporter json
  hunch check --only api/errors --dry-run     what one rule would cost on this branch`)
    .action((paths: string[], opts: Opts, command: Command) =>
      runCheck(paths, { ...opts, baseGiven: command.getOptionValueSource("base") === "cli" }, root(), repoFor(opts)));

  program
    .command("find")
    .description("search existing behavior or find context for a change across the repository")
    .argument("<task>", "an intended change, or a yes/no question with --mode condition")
    .option("--mode <mode>", "task (change context) or condition (existing behavior)", "task")
    .option("--chunk-lines <n>", "maximum lines per source window, 1 to 2000", "150")
    .option("--overlap-lines <n>", "repeat this many lines across source windows", "0")
    .argument("[paths...]", "only search under these paths")
    .option("--head <ref>", "search a branch or tag instead of the working tree")
    .option("--facet <list>", "only ask these: edit, contract, caller, test, precedent")
    .option("--min <score>", "drop matches below this score", "0.5")
    .option("--top <n>", "keep at most this many matches per facet; 0 returns all", "12")
    .option("--lines <n>", "lines of each passage to print in the terminal", "40")
    .option("--no-code", "print locations only")
    .option("--concurrency <n>", "requests in flight, 1 to 32", "8")
    .option("--reporter <format>", "markdown, text or json (default: text at a terminal, markdown when redirected)")
    .option("--prs", "also ask whether an open pull request already does this", false)
    .option("--pr-max <n>", "pull request diffs to read", "10")
    .option("--drafts", "include draft pull requests", false)
    .option("--dry-run", "count chunks and requests without calling Jev", false)
    .option("--config <json|file|->", "settings as JSON instead of a config file (include, ignore, provider); repeatable", collect, [])
    .addHelpText("after", `
Works without a config: it then searches every file, minus lockfiles, minified files and node_modules.
Exits 2 when any chunk or the pull request list could not be searched.

Examples:
  hunch find "add a rate limit to the upload endpoint"
  hunch find "Does this code discard a failed write?" --mode condition --top 0
  hunch find "warn on the onchain receive QR" --prs
  hunch find "rework the feed cache" src/feed --facet test,precedent
  hunch find "add a rate limit" > /tmp/hunch-context.md      Markdown, to hand to a coding agent`)
    .action((task: string, paths: string[], opts: Opts) => runFind(task, paths, opts, root(), localRepo(root())));

  program
    .command("compile")
    .description("turn skills and AGENTS.md into review questions, saved in hunch.lock")
    .option("--with <agent>", "claude, codex or gateway; skips the question")
    .option("--effort <level>", "how hard the agent should think")
    .option("--model <name>", "model for the compiling agent")
    .option("--force", "recompile sources that have not changed", false)
    .option("--dry-run", "list the sources and whether each changed since hunch.lock, without compiling", false)
    .option("--reporter <format>", "text or json", "text")
    .addHelpText("after", `
Examples:
  hunch compile                  asks which installed agent to use
  hunch compile --dry-run        what would be compiled, and what is unchanged
  hunch compile --with claude
  hunch compile --force          rebuild every source`)
    .action((opts: Opts) => runCompile(opts, root(), localRepo(root())));

  program
    .command("config")
    .description("check the config is valid and show the rules it applies; never edits it")
    .option("--file <path>", "show only the rules asked about this file, overrides applied")
    .option("--explain <rule>", "print exactly what one rule asks Jev, and when it reports")
    .option("--reporter <format>", "text or json", "text")
    .option("--config <json|file|->", "rules as JSON instead of a config file; repeatable", collect, [])
    .option("--rule <id=text>", "add one plain-English rule for this run; repeatable", collect, [])
    .addHelpText("after", `
Exits 2 when the config is invalid, a rule id or reference is missing, or hunch.lock is stale.

Examples:
  hunch config                             is it valid, and which rules are on?
  hunch config --file src/api/upload.ts    which rules are asked about this file?
  hunch config --explain tests/weakened    the question, criteria and state Jev receives
  hunch config --reporter json`)
    .action((opts: Opts) => runConfig(opts, root(), localRepo(root())));

  program
    .command("init")
    .description("write a config, and optionally a pull request workflow; asks at a terminal, or takes flags")
    .option("--preset <list>", "ts, rust or general, comma-separated (ts,rust for both)")
    .option("--target <where>", "where reviews run: app, actions or local")
    .option("--github", "shorthand for --target actions", false)
    .option("--include <glob>", "only review files matching this glob; repeatable", collect, [])
    .option("--ignore <glob>", "skip files matching this glob; repeatable", collect, [])
    .option("--fail-on-error", "fail the check when an error-level concern is found", false)
    .option("--no-zero-data-retention", "don't enforce zero data retention (needed on Vercel Hobby)")
    .option("--task <pr|none>", "send the PR title and description with each question", "pr")
    .option("--rule <id=text>", "add a plain-English rule at warn; repeatable", collect, [])
    .option("--install-skill", "also install the Hunch agent skill (npx skills add Kelbie/hunch)", false)
    .option("-y, --yes", "take the detected defaults and ask nothing", false)
    .addHelpText("after", `
Any flag skips the questions, so agents and CI get the same result every time.

Examples:
  hunch init                                   asks, with arrow keys, and writes the answers
  hunch init --yes                             detected preset, every default, no questions
  hunch init --preset ts,rust --target app     a mixed repository, reviewed by the GitHub App
  hunch init --target actions                  add .github/workflows/hunch.yml too
  hunch init --preset general --no-zero-data-retention --rule api/errors="Error responses keep their code field."`)
    .action((opts: Opts, command: Command) => runInit(opts, root(), Object.keys(opts).some((k) => command.getOptionValueSource(k) === "cli")));

  program
    .command("doctor")
    .description("say why this repository is not being reviewed")
    .option("--app <slug>", "the App to look for", "hunch-review")
    .option("--reporter <format>", "text or json", "text")
    .addHelpText("after", `
Checks the config on the default branch, the App installation, and the Actions workflow and secret,
using your gh login. Exits 1 when a check fails; a fact it cannot establish is "unknown", never "ok".

Examples:
  hunch doctor
  hunch doctor --app my-hunch-app --reporter json`)
    .action((opts: Opts) => runDoctor(opts, root()));

  program
    .command("eval")
    .description("measure each rule's precision and recall on labelled .diff examples")
    .argument("<dir>", "directory of .diff fixtures")
    .option("--config <json|file|->", "rules as JSON instead of a config file; repeatable", collect, [])
    .option("--rule <id=text>", "add one plain-English rule for this run; repeatable", collect, [])
    .option("--reporter <format>", "text or json", "text")
    .addHelpText("after", `
Each fixture is a .diff whose first line is "# expect: rule-a, rule-b" (the rules that should fire).

Examples:
  hunch eval examples/presets
  hunch eval fixtures --rule api/errors="Error responses keep their code field." --reporter json`)
    .action((dir: string, opts: Opts) => runEval(root(), dir, { config: opts.config, rules: opts.rule, root: root(), reporter: opts.reporter }));

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

export async function main() {
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
async function runEval(root: string, dir: string, inline: { config?: string[]; rules?: string[]; root?: string; reporter?: string }) {
  if (!["text", "json"].includes(inline.reporter ?? "text")) return fail("Unknown --reporter for eval; use text or json");
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
  const fixtures: { file: string; expected: string[]; fired: string[] }[] = [];
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
    fixtures.push({ file: f, expected: [...expected], fired: [...fired] });
  }
  const rate = (a: number, b: number) => (a + b ? a / (a + b) : 1);
  if (inline.reporter === "json") {
    console.log(JSON.stringify({ fixtures, rules: [...stats].sort().map(([rule, s]) => ({ rule, precision: rate(s.tp, s.fp), recall: rate(s.tp, s.fn), ...s })) }, null, 2));
    return;
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


async function runCheck(paths: string[], opts: Opts, root: string, repo: RepoReader) {
  const loaded = await resolveConfig(repo, { config: opts.config, rules: opts.rule, root });
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
  const only = opts.only ? String(opts.only).split(",").map((id) => id.trim()).filter(Boolean) : undefined;
  const under = underPaths(paths);
  let diff = "";
  let hunks: Hunk[];
  let skippedFiles: string[] = [];
  const reviewedSha = opts.head ? commitOf(root, opts.head, "--head") : undefined;
  const changedSource = reviewedSha ? gitRepo(root, reviewedSha) : localRepo(root);
  if (opts.all) {
    if (opts.diff || opts.staged || opts.baseGiven) return fail("--all reviews whole files; drop --base, --diff and --staged");
    const source = changedSource;
    const full = await repoHunks(source, config, paths, config.review);
    hunks = full.hunks;
    skippedFiles = full.skipped;
    if (full.skipped.length) console.error(`hunch: skipped ${full.skipped.length} unreadable, binary or oversized file(s)`);
    const files = new Set(hunks.map((h) => h.file)).size;
    console.error(`hunch: reviewing ${files} file(s) as ${hunks.length} chunk(s) from ${opts.head ?? "the working tree"}` +
      (hunks.length > config.budget.maxHunks ? `; only the first ${config.budget.maxHunks} fit budget.maxHunks` : ""));
  } else {
  if ([opts.diff, opts.staged, opts.head].filter(Boolean).length > 1) return fail("Choose only one of --diff, --staged or --head");
  if (opts.head) {
    const base = commitOf(root, opts.base);
    const head = reviewedSha!;
    diff = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"]);
  } else diff = opts.diff ? readFileSync(opts.diff, "utf8") : branchDiff(root, opts.base!, opts.staged);
  if (diff.length > 16_000_000) return fail("Diff exceeds 16 MB; review a smaller change");
  hunks = parseHunks(diff).filter((h) => under(h.file));
  }
  const lockText = await repo.read(LOCK_FILE);
  const lock = lockText ? parseLock(lockText) : null;
  const stale = await staleSources(lock, config, repo);
  if (only) {
    const known = new Set(policyRules(config, lock).map((r) => r.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length) return fail(`--only: no rule ${unknown.join(", ")}. Run \`npx @kelbie/hunch config\` to list them.`);
  }
  const task = opts.task ?? prTaskFromEvent();
  if (opts.dryRun) {
    const reviewed = hunks.filter((h) => h.status !== "deleted" && inScope(config)(h.file)).flatMap((h) => h.kind === "file" ? [h] : windowHunk(h, 6000, config.review.chunkLines)).slice(0, config.budget.maxHunks);
    // The same selection check makes: a hunk no rule asks about, after `files` and `when`, sends
    // nothing, and each distinct `reference` among the rest is its own request.
    let questions = 0, requests = 0;
    for (const h of reviewed) {
      const asked = rulesFor(h.file, config, lock, only).jev
        .filter((r) => !r.question.when || new RegExp(r.question.when.source, r.question.when.flags).test(h.text))
        .slice(0, config.budget.maxRulesPerHunk);
      questions += asked.length;
      requests += new Set(asked.map((r) => r.question.reference ?? "")).size;
    }
    // The real run would be incomplete; a dry run is where someone decides whether to run it.
    if (stale.length) console.error(`hunch: ${staleNotice(lock, stale)} A review now would be incomplete.`);
    console.log(`hunch: dry run, nothing sent. ${new Set(reviewed.map((h) => h.file)).size} file(s) as ${reviewed.length} hunk(s): ${questions} question(s) in ${Math.min(requests, config.budget.maxRequests)} request(s). Budget: ${config.budget.maxHunks} hunks, ${config.budget.maxRequests} requests, ${config.budget.timeoutSeconds}s.`);
    if (config.review.localize) console.log("Optional localization runs after baseline coverage, within the remaining request/time budget.");
    if (skippedFiles.length) process.exitCode = 2;
    return;
  }
  // Created on first request, so a diff with nothing to review needs no API key.
  let client: JevClient | undefined;
  const result = await check({
    config,
    hunks,
    task,
    lock,
    only,
    client: { evaluate: (req) => (client ??= clientFromEnv(config)).evaluate(req) },
    readFile: (p) => repo.read(p),
    readChangedFile: opts.diff ? undefined : opts.staged ? (p) => readStagedFile(root, p) : (p) => changedSource.read(p),
    onProgress: (d, t) => opts.reporter === "text" && process.stderr.write(`\r  checked ${d}/${t} hunks`),
  });
  if (opts.reporter === "text") process.stderr.write("\n");
  if (stale.length) result.complete = false;
  if (skippedFiles.length) {
    result.complete = false;
    result.notices.push(`Selected files could not be reviewed (unreadable, binary or oversized): ${skippedFiles.join(", ")}.`);
  }
  const unreviewable = unreviewableFiles(diff).filter(inScope(config));
  if (unreviewable.length) { result.complete = false; result.notices.push(`Binary, rename-only or mode changes need human review: ${unreviewable.join(", ")}.`); }
  if (stale.length) result.notices.push(staleNotice(lock, stale));

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
      const repository = process.env.GITHUB_REPOSITORY;
      const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
      const blobBase = reviewedSha && repository && /^[\w.-]+\/[\w.-]+$/.test(repository) && /^https:\/\/[\w.-]+$/.test(server)
        ? `${server}/${repository}/blob/${reviewedSha}` : undefined;
      const md = summaryMarkdown(result, { blobBase });
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
  // find asks fixed questions, so a repository with no config is searched with the defaults: every
  // file except the ones no review ever reads.
  const loaded = await resolveConfig(repo, { config: opts.config, root });
  if (!loaded) console.error("hunch: no config; searching every file except lockfiles, minified files and node_modules.");
  const config = loaded?.config ?? applyPresets(parseConfig({}, "defaults"));
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
  const mode = opts.mode ?? "task";
  if (mode !== "task" && mode !== "condition") return fail("--mode must be task or condition");
  if (mode === "condition" && (opts.facet || opts.prs)) return fail("--facet and --prs apply to task mode only");
  if (!task.trim() || task.trim().length > 4000) return fail("find query must contain 1 to 4000 characters");
  const chunkLines = Number(opts.chunkLines ?? 150);
  const overlapLines = Number(opts.overlapLines ?? 0);
  if (!Number.isInteger(chunkLines) || chunkLines < 1 || chunkLines > 2000) return fail("--chunk-lines must be between 1 and 2000");
  if (!Number.isInteger(overlapLines) || overlapLines < 0 || overlapLines >= chunkLines) return fail("--overlap-lines must be nonnegative and less than --chunk-lines");
  const minScore = opts.min === undefined ? 0.5 : Number(opts.min);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) return fail("--min must be between 0 and 1");
  const top = opts.top === undefined ? 12 : Number(opts.top);
  if (!Number.isInteger(top) || top < 0) return fail("--top must be a nonnegative whole number (0 returns all)");
  // Not config.budget: that is sized to keep a PR review inside a worker timeout, and
  // inheriting its request cap would end a repository sweep partway through without the
  // person having asked for that.
  const concurrency = opts.concurrency === undefined ? 8 : Number(opts.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return fail("--concurrency must be between 1 and 32");
  const maxLines = opts.lines === undefined ? 40 : Number(opts.lines);
  if (!Number.isInteger(maxLines) || maxLines < 1) return fail("--lines must be a positive whole number");

  const revision = opts.head ? commitOf(root, opts.head, "--head") : "working-tree";
  const source = opts.head ? gitRepo(root, revision) : localRepo(root);
  const { hunks, skipped } = await repoHunks(source, config, paths, { chunkLines, overlapLines });
  if (skipped.length) console.error(`hunch: skipped ${skipped.length} unreadable, binary or oversized file(s)`);
  const files = new Set(hunks.map((h) => h.file)).size;
  if (opts.dryRun) {
    // Listing open pull requests is free, but judging them is not; how many there are is only
    // known once listed, so say the rule rather than guess a number.
    const prs = opts.prs ? ` With --prs, add one request per open pull request title, and up to ${opts.prMax ?? 10} more for the diffs whose titles match.` : "";
    console.log(`hunch: dry run, nothing sent. ${files} file(s) as ${hunks.length} chunk(s): ${hunks.length} request(s), ${(mode === "condition" ? 1 : facets.length || FACETS.length) * hunks.length} question(s).${prs}`);
    if (skipped.length) process.exitCode = 2;
    return;
  }
  if (!hunks.length && !skipped.length) return fail("nothing in scope to search; check `include` and the paths you passed.");
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
    mode,
    skippedFiles: skipped,
    hunks,
    model: config.model,
    facets: facets.length ? facets : undefined,
    minScore,
    perFacet: top,
    budget: { concurrency, maxRequests: hunks.length, timeoutSeconds: 3600 },
    client: jev,
    onProgress: (d, t) => progress(`searched ${d}/${t} chunks`, d === t),
  });
  // PR coverage is part of the requested operation, including its machine-readable status.
  if (!existingComplete) {
    result.complete = false;
    result.notices.push("The requested open pull request search was incomplete; inspect existingWork.");
  }
  const scope = { paths, include: config.include, ignore: [...DEFAULT_IGNORE, ...config.ignore], chunkLines, overlapLines, skippedFiles: skipped, revision };
  if (reporter === "json") console.log(JSON.stringify({ ...result, scope, existingWork }, null, 2));
  else if (reporter === "text") console.log(findText(result, { ...style, code: !!opts.code, maxLines, existing: existingText }));
  else console.log(findMarkdown(task, result, existingMd));
  // An unfinished sweep means the answer is "here is some of it", which callers must be able to
  // see — including an unchecked pull request list, since that cannot prove nothing is open.
  process.exitCode = result.complete && existingComplete ? 0 : 2;
  return;
}

async function runCompile(opts: Opts, root: string, repo: RepoReader) {
  if (!["text", "json"].includes(opts.reporter)) return fail("Unknown --reporter for compile; use text or json");
  const loaded = await loadConfig(repo);
  if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`.");
  const { config } = loaded;
  const docs = await collectSources(config, repo);
  if (!docs.length) return fail("no skills, AGENTS.md or docs found to compile.");
  const previous = readLock(root);
  if (opts.dryRun) {
    const byId = new Map((previous?.sources ?? []).map((s) => [s.id, s]));
    const sources = await Promise.all(docs.map(async (d) => ({ id: d.id, path: d.path, status: byId.get(d.id)?.hash === (await hashDoc(d)) ? "unchanged" : byId.has(d.id) ? "changed" : "new" })));
    const removed = [...byId.keys()].filter((id) => !docs.some((d) => d.id === id));
    if (opts.reporter === "json") console.log(JSON.stringify({ compiler: previous?.compiler.model ?? null, sources, removed }, null, 2));
    else {
      console.log(`hunch: dry run, nothing compiled. ${sources.filter((s) => s.status !== "unchanged").length} of ${sources.length} source(s) would be compiled${previous ? ` (last compiled with ${previous.compiler.model})` : ""}.`);
      for (const s of sources) console.log(`  ${s.status.padEnd(9)}  ${s.id}  ${s.path}`);
      for (const id of removed) console.log(`  removed    ${id}`);
    }
    return;
  }
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
  if (opts.reporter === "json") console.log(JSON.stringify({ lock: LOCK_FILE, compiler: model, rules, notChecked: skipped, sources: lock.sources.map((s) => ({ id: s.id, rules: s.rules.length, notChecked: s.notChecked.length })) }, null, 2));
  console.error(`hunch: wrote ${LOCK_FILE}: ${rules} rules, ${skipped} guidance items not checkable per hunk. Review and commit it.`);
  return;
}

async function runConfig(opts: Opts, root: string, repo: RepoReader) {
  if (!["text", "json"].includes(opts.reporter)) return fail("Unknown --reporter for config; use text or json");
  const loaded = await resolveConfig(repo, { config: opts.config, rules: opts.rule, root });
  if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`, or pass rules with --config or --rule.");
  const lockText = await repo.read(LOCK_FILE);
  const lock = lockText ? parseLock(lockText) : null;
  if (opts.explain) {
    const explanation = explainRule(loaded.config, lock, opts.explain);
    console.log(opts.reporter === "json" ? JSON.stringify(explanation, null, 2) : explanationText(explanation));
    return;
  }
  const report = await inspectConfig(loaded, lock, repo, opts.file);
  console.log(opts.reporter === "json" ? JSON.stringify(report, null, 2) : configText(report));
  process.exitCode = report.valid ? 0 : 2;
}

const TARGETS = ["app", "actions", "local"] as const;

async function runInit(opts: Opts, root: string, explicit: boolean) {
  let presets: PresetName[] | undefined;
  try {
    if (opts.preset) presets = PRESET_NAMES.filter((p) => String(opts.preset).split(",").map((k) => k.trim()).filter(Boolean).flatMap(presetsFor).includes(p));
  } catch (e) { return fail((e as Error).message); }
  if (opts.target && !TARGETS.includes(opts.target)) return fail(`Unknown --target ${opts.target}; choose from ${TARGETS.join(", ")}`);
  if (opts.github && opts.target && opts.target !== "actions") return fail("--github means --target actions; pass one of them");
  if (!["pr", "none"].includes(opts.task)) return fail(`Unknown --task ${opts.task}; choose pr or none`);
  const rules: Record<string, string> = {};
  for (const arg of opts.rule as string[]) {
    const m = /^([\w.:/-]+)=(.+)$/s.exec(arg.trim());
    if (!m) return fail(`--rule "${arg.slice(0, 60)}" should look like id=Plain-English rule, e.g. api/errors=Error responses keep their code field.`);
    rules[m[1]!] = m[2]!.trim();
  }

  const existing = ["hunch.toml", "hunch.config.ts"].filter(name => existsSync(join(root, name)));
  const workflow = join(root, ".github/workflows/hunch.yml");
  if (existing.length > 1) return fail("Keep exactly one of hunch.config.ts and hunch.toml.");
  // Any explicit flag, a pipe or CI keeps the exact non-interactive behaviour scripts rely on.
  const answers = explicit || !interactive() ? null : await askWizard(clackIo(), {
    root, detected: detectPreset(root), configExists: existing.length > 0,
    guidance: hasGuidance(root), keyPresent: existingKey(root) !== null,
  });
  if (!explicit && interactive() && !answers) return fail("setup cancelled; nothing was written.");
  const target: Target | undefined = answers?.target ?? (opts.github ? "actions" : opts.target);
  const wantsWorkflow = target === "actions";
  if (existing.length && !wantsWorkflow) return fail("a hunch config already exists. Edit it, or use `npx @kelbie/hunch init --target actions` to add only the workflow.");
  if (wantsWorkflow && existsSync(workflow)) return fail(".github/workflows/hunch.yml already exists; it was not overwritten.");

  let file = existing[0] ?? "";
  if (!existing.length) {
    const base = defaultAnswers(presets ?? presetsFor(detectPreset(root)));
    const chosen: ConfigAnswers = answers?.config ?? {
      ...base,
      ...(opts.include.length ? { include: opts.include } : {}),
      ...(opts.ignore.length ? { ignore: opts.ignore } : {}),
      failOnError: opts.failOnError,
      zeroDataRetention: opts.zeroDataRetention,
      task: opts.task,
      rules,
    };
    const rendered = renderConfig(chosen);
    file = rendered.file;
    writeFileSync(join(root, file), rendered.text, { flag: "wx" });
    console.error(`hunch: wrote ${file}.`);
  }
  if (wantsWorkflow) {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(workflow, GITHUB_WORKFLOW, { flag: "wx" });
    console.error("hunch: wrote .github/workflows/hunch.yml.");
  }
  if (answers?.installSkill || opts.installSkill) {
    if (!installSkill(root)) console.error(`hunch: the skill was not installed. Run \`npx ${SKILL_INSTALL.join(" ")}\` yourself.`);
  }
  if (answers) return finishWizard(root, answers, { file });
  if (target) console.error(`\nNext:\n\n${nextSteps(target, { configFile: file, compiled: false, secretSet: false, keyDeferred: true })}`);
  if (hasGuidance(root)) console.error("hunch: this repository has skills or AGENTS.md; run `npx @kelbie/hunch compile` and commit hunch.lock too.");
}

async function runDoctor(opts: Opts, root: string) {
  if (!["text", "json"].includes(opts.reporter)) return fail("Unknown --reporter for doctor; use text or json");
  const checks = await diagnose({
    gh: ghApi,
    local: (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } },
    remoteUrl: () => originUrl(root),
    env: process.env,
  }, { slug: opts.app ?? "hunch-review" });
  const { text, failed } = report(checks);
  console.log(opts.reporter === "json" ? JSON.stringify({ checks, failed }, null, 2) : text);
  process.exitCode = failed ? 1 : 0;
  return;
}
