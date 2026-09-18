#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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


const HELP = `hunch ${VERSION}: gut-check a diff against your rules and skills with TypeSafe's Jev

Usage: npx @kelbie/hunch <command>, or hunch <command> once installed
  hunch check [--base main] [--staged] [--diff file] [paths…]   review a diff (default: this branch vs main)
  hunch check --all [--head ref] [paths…]   review whole files at a branch or the working tree
        [--dry-run]   count files, hunks and questions without calling Jev
        [--task "…"] [--reporter text|markdown|json|sarif|github]
        [--show-diff]   print the changed lines under each finding (text and json)
        [--config <json|file|->] [--rule id=text …]   rules without a config file (see below)
  hunch compile [--force]          turn skills + AGENTS.md into hunch.lock (uses an LLM once)
        [--with claude|codex|gateway] [--effort level] [--model name]
        asks which installed agent to use; --with skips the question
  hunch init [--rust|--ts|--general] [--github]  write config and optionally a PR workflow
        asks where reviews should run when it has a terminal; any flag skips the questions
  hunch find "<task>" [paths…]     find the code a change would touch, and print it
        [--facet edit,contract,caller,test,precedent]   ask only these, report only these
        [--min 0.5] [--top 12] [--concurrency 8] [--head ref] [--dry-run]
        [--reporter markdown|text|json] [--no-code] [--lines 40]
        [--prs] [--pr-max 10] [--drafts]   also ask whether an open PR already does this
        Prints the matching source, grouped by what each chunk is to the task: a
        coloured report at a terminal, Markdown when redirected to a file or a pipe,
        so it can be handed straight to a coding agent. --no-code prints locations
        only; --dry-run counts chunks and requests without sending anything.
        --top is per facet, so the one test worth updating is not crowded out by
        thirty definitions.
  hunch doctor [--app slug]        say why this repository is not being reviewed
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
      "show-diff": { type: "boolean", default: false },
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
      app: { type: "string" },
      facet: { type: "string", multiple: true },
      concurrency: { type: "string" },
      prs: { type: "boolean", default: false },
      "no-code": { type: "boolean", default: false },
      lines: { type: "string" },
      "pr-max": { type: "string" },
      drafts: { type: "boolean", default: false },
      min: { type: "string" },
      top: { type: "string" },
      cwd: { type: "string", default: process.cwd() },
    },
  });
  const root = values.cwd!;
  const repo = values["policy-ref"] ? gitRepo(root, values["policy-ref"]) : localRepo(root);

  switch (cmd) {
    case "check": {
      const loaded = await resolveConfig(repo, { config: values.config, rules: values.rule });
      if (!loaded && values["policy-ref"]) {
        // The PR that adds Hunch: its base has no config yet, so there is no trusted policy to apply.
        console.log(values.reporter === "github"
          ? "::notice title=Hunch::Hunch isn't set up on the base branch yet. PRs are reviewed once hunch.config.ts or hunch.toml is merged."
          : "hunch: no config on the base branch yet; nothing to review.");
        return;
      }
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
      const unreviewable = unreviewableFiles(diff).filter(inScope(config));
      if (unreviewable.length) { result.complete = false; result.notices.push(`Binary, rename-only or mode changes need human review: ${unreviewable.join(", ")}.`); }
      if (stale.length) result.notices.push(`hunch.lock is stale for: ${stale.join(", ")}. Run \`npx @kelbie/hunch compile\`.`);

      switch (values.reporter) {
        case "markdown":
          console.log(summaryMarkdown(result));
          break;
        case "json":
          console.log(JSON.stringify(values["show-diff"] ? { ...result, findings: result.findings.map((f) => ({ ...f, diff: excerptText(hunks, f) })) } : result, null, 2));
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
            hunks: values["show-diff"] ? hunks : undefined,
          }));
      }
      const failed = config.failOnError && result.findings.some((f) => f.level === "error");
      process.exitCode = !result.complete ? 2 : failed ? 1 : 0;
      return;
    }

    case "find": {
      const task = positionals[0];
      if (!task) return fail('find needs a task: hunch find "add a minimum-amount warning to the onchain receive screen"');
      const loaded = await loadConfig(repo);
      if (!loaded) return fail("no hunch.config.ts or hunch.toml found. Run `npx @kelbie/hunch init`.");
      const { config } = loaded;
      // A person at a terminal gets the coloured report; a redirect gets Markdown, because the
      // reason to redirect this is to hand it to something that reads Markdown. Either way the
      // code is in the output — that is what find is for.
      const chose = rest.some((a) => a === "--reporter" || a.startsWith("--reporter="));
      const reporter = chose ? values.reporter! : process.stdout.isTTY ? "text" : "markdown";
      if (!["text", "markdown", "json"].includes(reporter)) return fail("Unknown --reporter for find; use markdown, text or json");
      const style = {
        color: process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb",
        width: Math.min(process.stdout.columns || 100, 120),
      };
      const facets = (values.facet ?? []).flatMap((f) => f.split(",")).map((f) => f.trim()).filter(Boolean) as Facet[];
      const unknown = facets.filter((f) => !FACETS.includes(f));
      if (unknown.length) return fail(`Unknown --facet ${unknown.join(", ")}; choose from ${FACETS.join(", ")}`);
      const minScore = values.min === undefined ? 0.5 : Number(values.min);
      if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) return fail("--min must be between 0 and 1");
      const top = values.top === undefined ? 12 : Number(values.top);
      if (!Number.isInteger(top) || top < 1) return fail("--top must be a positive whole number");
      // Not config.budget: that is sized to keep a PR review inside a worker timeout, and
      // inheriting its request cap would end a repository sweep partway through without the
      // person having asked for that.
      const concurrency = values.concurrency === undefined ? 8 : Number(values.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return fail("--concurrency must be between 1 and 32");
      const maxLines = values.lines === undefined ? 40 : Number(values.lines);
      if (!Number.isInteger(maxLines) || maxLines < 1) return fail("--lines must be a positive whole number");

      const source = values.head ? gitRepo(root, values.head) : localRepo(root);
      const { hunks, skipped } = await repoHunks(source, config, positionals.slice(1));
      if (skipped.length) console.error(`hunch: skipped ${skipped.length} unreadable, binary or oversized file(s)`);
      const files = new Set(hunks.map((h) => h.file)).size;
      if (values["dry-run"]) {
        console.log(`hunch: dry run, nothing sent. ${files} file(s) as ${hunks.length} chunk(s): ${hunks.length} request(s), ${(facets.length || FACETS.length) * hunks.length} question(s).`);
        return;
      }
      if (!hunks.length) return fail("nothing in scope to search; check `include` and the paths you passed.");
      console.error(`hunch: searching ${files} file(s) as ${hunks.length} chunk(s) from ${values.head ?? "the working tree"}`);

      let client: JevClient | undefined;
      const jev = { evaluate: (req: Parameters<JevClient["evaluate"]>[0]) => (client ??= clientFromEnv(config)).evaluate(req) };

      // Asked first: if this work is already open as a pull request, the person should hear it
      // before reading a hundred lines of code they may not need to touch.
      let existingMd = "";
      let existingText = "";
      let existingComplete = true;
      let existingWork: Awaited<ReturnType<typeof findPulls>> | undefined;
      if (values.prs) {
        const remote = parseRemote(originUrl(root));
        if (!remote) return fail("--prs needs a github.com `origin` remote to list pull requests from.");
        const prMax = values["pr-max"] === undefined ? 10 : Number(values["pr-max"]);
        if (!Number.isInteger(prMax) || prMax < 1) return fail("--pr-max must be a positive whole number");
        console.error(`hunch: checking open pull requests on ${remote.owner}/${remote.repo}`);
        const pulls = await findPulls({
          task,
          slug: `${remote.owner}/${remote.repo}`,
          io: { gh: ghApi },
          client: jev,
          model: config.model,
          maxInspected: prMax,
          includeDrafts: values.drafts,
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
      else if (reporter === "text") console.log(findText(result, { ...style, code: !values["no-code"], maxLines, existing: existingText }));
      else console.log(findMarkdown(task, result, existingMd));
      // An unfinished sweep means the answer is "here is some of it", which callers must be able to
      // see — including an unchecked pull request list, since that cannot prove nothing is open.
      process.exitCode = result.complete && existingComplete ? 0 : 2;
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
      const existing = ["hunch.toml", "hunch.config.ts"].filter(name => existsSync(join(root, name)));
      const workflow = join(root, ".github/workflows/hunch.yml");
      if (existing.length > 1) return fail("Keep exactly one of hunch.config.ts and hunch.toml.");
      // Any explicit flag, a pipe or CI keeps the exact non-interactive behaviour scripts rely on.
      const chosen = [values.rust, values.ts, values.general, values.github].some(Boolean);
      const answers = chosen || !interactive() ? null : await askWizard(clackIo(), {
        root, detected: detectPreset(root), configExists: existing.length > 0,
        guidance: hasGuidance(root), keyPresent: existingKey(root) !== null,
      });
      if (!chosen && interactive() && !answers) return fail("setup cancelled; nothing was written.");
      const preset = answers?.preset;
      const rust = preset ? preset === "rust" : values.rust || (!values.ts && !values.general && existsSync(join(root, "Cargo.toml")));
      const ts = preset ? preset === "ts" : values.ts || (!rust && !values.general && existsSync(join(root, "package.json")));
      const file = ts ? "hunch.config.ts" : "hunch.toml";
      const wantsWorkflow = values.github || answers?.target === "actions";
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

    case "doctor": {
      const checks = await diagnose({
        gh: ghApi,
        local: (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } },
        remoteUrl: () => originUrl(root),
        env: process.env,
      }, { slug: values.app ?? "hunch-review" });
      const { text, failed } = report(checks);
      console.log(text);
      process.exitCode = failed ? 1 : 0;
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

/** A finding's diff excerpt as plain unified-diff lines, for `--reporter json --show-diff`. */
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
