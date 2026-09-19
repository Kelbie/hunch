import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, isCancel, multiselect, note, outro, password, select, text } from "@clack/prompts";
import { defaultAnswers, PRESET_NAMES, type ConfigAnswers, type PresetName } from "../templates.js";

/** Where reviews run. The App needs nothing in the repository beyond a committed config. */
export type Target = "local" | "app" | "actions";
export type Preset = "ts" | "rust" | "general";
export type KeyChoice = { kind: "gateway" | "typesafe"; value: string } | { kind: "later" };

export const INSTALL_URL = "https://github.com/apps/hunch-review/installations/new";

/** The agent skill that documents Hunch for coding agents, installed by the `skills` CLI. */
export const SKILL_INSTALL = ["skills", "add", "Kelbie/hunch", "--skill", "hunch", "-y"] as const;

/** What `--preset` and the detected project type mean in presets. `general` is recommended alone. */
export function presetsFor(kind: string): PresetName[] {
  switch (kind) {
    case "ts": case "typescript": return ["recommended", "typescript"];
    case "rust": return ["recommended", "rust"];
    case "general": case "recommended": return ["recommended"];
    default: throw new Error(`Unknown preset ${kind}; choose from ts, rust, general`);
  }
}

/**
 * Everything the wizard touches outside itself, so the flow is exercised without a terminal,
 * a repository or a network. Mirrors the injected `Io` in pick.ts.
 */
export interface WizardIo {
  select: (opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValue?: string }) => Promise<string | null>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean | null>;
  password: (opts: { message: string }) => Promise<string | null>;
  multiselect: (opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValues?: string[] }) => Promise<string[] | null>;
  text: (opts: { message: string; placeholder?: string; initialValue?: string; validate?: (value: string) => string | undefined }) => Promise<string | null>;
  note: (body: string, title?: string) => void;
  outro: (message: string) => void;
}

export const clackIo = (): WizardIo => ({
  select: async (opts) => { const v = await select(opts); return isCancel(v) ? null : String(v); },
  confirm: async (opts) => { const v = await confirm(opts); return isCancel(v) ? null : v; },
  password: async (opts) => { const v = await password(opts); return isCancel(v) ? null : v; },
  multiselect: async (opts) => { const v = await multiselect({ ...opts, required: false }); return isCancel(v) ? null : v.map(String); },
  text: async (opts) => {
    const v = await text({ ...opts, validate: opts.validate && ((value) => opts.validate!(value ?? "")) });
    return isCancel(v) ? null : (v ?? "");
  },
  note: (body, title) => note(body, title),
  outro: (message) => outro(message),
});

/** Menus need a terminal on both ends; CI keeps the non-interactive flag behaviour scripts rely on. */
export function interactive(env: NodeJS.ProcessEnv = process.env, stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && !env.CI;
}

/** The preset `init` would have chosen from the project's own files, unchanged from the flag path. */
export function detectPreset(root: string): Preset {
  if (existsSync(join(root, "Cargo.toml"))) return "rust";
  if (existsSync(join(root, "package.json"))) return "ts";
  return "general";
}

/** Guidance worth compiling. Matches what `collectSources` reads, without loading a config. */
export function hasGuidance(root: string): boolean {
  return ["AGENTS.md", "skills", ".agents/skills", ".claude/skills"].some((p) => existsSync(join(root, p)));
}

const PRESET_LABELS: Record<PresetName, { label: string; hint: string }> = {
  recommended: { label: "Recommended", hint: "any language: hidden failures, edge cases, weakened tests, wrong comments" },
  typescript: { label: "TypeScript / JavaScript", hint: "async ordering, lossy serialization" },
  rust: { label: "Rust", hint: "panics on recoverable input, lost error context" },
};

export async function askPresets(io: WizardIo, detected: Preset): Promise<PresetName[] | null> {
  const value = await io.multiselect({
    message: "Which starter rules? (space to toggle, enter to confirm)",
    initialValues: presetsFor(detected),
    options: PRESET_NAMES.map((p) => ({ value: p, ...PRESET_LABELS[p] })),
  });
  return value === null ? null : PRESET_NAMES.filter((p) => value.includes(p));
}

/** Commas separate globs, except inside braces, where they are part of the glob: `**\/*.{ts,tsx}`. */
export function splitGlobs(input: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const ch of input) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(current); current = ""; } else current += ch;
  }
  out.push(current);
  return out.map((g) => g.trim()).filter(Boolean);
}

export async function askScope(io: WizardIo, defaults: Pick<ConfigAnswers, "include" | "ignore">): Promise<Pick<ConfigAnswers, "include" | "ignore"> | null> {
  const include = await io.text({
    message: "Which files should Hunch review? Comma-separated globs; leave blank for every file.",
    initialValue: defaults.include.join(", "),
    placeholder: "every file",
  });
  if (include === null) return null;
  const ignore = await io.text({
    message: "Which files should it skip? Lockfiles, minified files and node_modules are always skipped.",
    initialValue: defaults.ignore.join(", "),
    placeholder: "nothing else",
  });
  if (ignore === null) return null;
  return { include: splitGlobs(include), ignore: splitGlobs(ignore) };
}

export async function askPolicy(io: WizardIo): Promise<Pick<ConfigAnswers, "zeroDataRetention" | "failOnError" | "task"> | null> {
  const retention = await io.select({
    message: "Zero data retention for your code on Vercel AI Gateway?",
    initialValue: "enforce",
    options: [
      { value: "enforce", label: "Enforce it", hint: "Vercel Pro or Enterprise; reviews fail rather than route elsewhere" },
      { value: "allow", label: "Don't enforce it", hint: "required on Vercel Hobby, which cannot enforce it" },
    ],
  });
  if (retention === null) return null;
  const failOnError = await io.confirm({ message: "Fail the check when an error-level concern is found?", initialValue: false });
  if (failOnError === null) return null;
  const task = await io.confirm({ message: "Send the pull request title and description along with each question?", initialValue: true });
  if (task === null) return null;
  return { zeroDataRetention: retention === "enforce", failOnError, task: task ? "pr" : "none" };
}

export const RULE_ID = /^[\w.:/-]+$/;

/** A readable id from the rule's first words, which the person can then change. */
export function ruleIdFor(sentence: string): string {
  const words = sentence.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 4);
  return `project/${words.join("-") || "rule"}`;
}

export async function askRule(io: WizardIo): Promise<Record<string, string> | null> {
  const sentence = await io.text({
    message: "Add a rule of your own? Describe, in one sentence, what a change must not break. Leave blank to skip.",
    placeholder: "Error responses keep their code field, because clients branch on it.",
  });
  if (sentence === null) return null;
  if (!sentence.trim()) return {};
  const id = await io.text({
    message: "Rule id",
    initialValue: ruleIdFor(sentence),
    validate: (v) => (RULE_ID.test(v.trim()) ? undefined : "Use letters, digits and . : / - _ only"),
  });
  if (id === null) return null;
  return { [id.trim()]: sentence.trim() };
}

export async function askTarget(io: WizardIo): Promise<Target | null> {
  const value = await io.select({
    message: "Where should Hunch review?",
    initialValue: "app",
    options: [
      { value: "app", label: "Every PR, via the GitHub App", hint: "no key, no workflow; review comments and fork PRs" },
      { value: "actions", label: "Every PR, via GitHub Actions", hint: "runs in your CI, under your own key" },
      { value: "local", label: "This machine only", hint: "hunch check; nothing committed" },
    ],
  });
  return value as Target | null;
}

/** Keys already reachable by `check`, in the order bin.ts loads them. */
export function existingKey(root: string, env: NodeJS.ProcessEnv = process.env): "AI_GATEWAY_API_KEY" | "TYPESAFE_API_KEY" | null {
  for (const name of ["AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"] as const) {
    if (env[name]) return name;
    for (const file of [".env.local", ".env"]) {
      const path = join(root, file);
      if (existsSync(path) && new RegExp(`^\\s*(export\\s+)?${name}\\s*=\\s*\\S`, "m").test(readFileSync(path, "utf8"))) return name;
    }
  }
  return null;
}

export async function askKey(io: WizardIo): Promise<KeyChoice | null> {
  const provider = await io.select({
    message: "Which model provider should review your code?",
    initialValue: "gateway",
    options: [
      { value: "gateway", label: "Vercel AI Gateway", hint: "AI_GATEWAY_API_KEY, from API Keys → Create key" },
      { value: "typesafe", label: "TypeSafe directly", hint: "TYPESAFE_API_KEY" },
      { value: "later", label: "I'll add the key later", hint: "check won't run until you do" },
    ],
  });
  if (provider === null) return null;
  if (provider === "later") return { kind: "later" };
  const value = await io.password({ message: provider === "gateway" ? "Paste your AI Gateway key" : "Paste your TypeSafe key" });
  if (value === null) return null;
  if (!value.trim()) return { kind: "later" };
  return { kind: provider as "gateway" | "typesafe", value: value.trim() };
}

/**
 * Keys belong in the environment, never in hunch.config.ts, which is committed. Writes are
 * owner-only and `.env.local` is kept out of git so a key cannot be committed by accident.
 */
export function writeKey(root: string, name: string, value: string): string {
  const path = join(root, ".env.local");
  const line = `${name}=${value}\n`;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (new RegExp(`^\\s*(export\\s+)?${name}\\s*=`, "m").test(current)) throw new Error(`.env.local already sets ${name}; leaving it alone.`);
    appendFileSync(path, current.endsWith("\n") || !current ? line : `\n${line}`, { mode: 0o600 });
  } else writeFileSync(path, line, { mode: 0o600, flag: "wx" });
  ignoreEnvLocal(root);
  return path;
}

function ignoreEnvLocal(root: string) {
  const path = join(root, ".gitignore");
  const entry = ".env.local";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === entry || l.trim() === ".env*")) return;
  appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}

/** `gh` is used only when it is already installed and logged in; otherwise the wizard prints the command. */
export function ghReady(run = spawnSync): boolean {
  const result = run("gh", ["auth", "status"], { stdio: "ignore", timeout: 15_000 });
  return !result.error && result.status === 0;
}

/** Secrets go over stdin, never argv, matching vercelSecrets in setup/app.ts. */
export function setRepoSecret(name: string, value: string, run = spawnSync): void {
  const result = run("gh", ["secret", "set", name], { input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`Could not set ${name} with gh. Run \`gh secret set ${name}\` yourself.`);
}

export interface WizardAnswers {
  /** Null when a config already exists: the wizard only adds a path to it, never rewrites it. */
  config: ConfigAnswers | null;
  target: Target;
  key: KeyChoice;
  compile: boolean;
  installSkill: boolean;
}

/**
 * Asks only what the flags did not already decide. Returns null when the person cancels, so the
 * caller writes nothing: a half-configured repository is worse than an unconfigured one.
 */
export async function askWizard(io: WizardIo, context: { root: string; detected: Preset; configExists: boolean; guidance: boolean; keyPresent: boolean }): Promise<WizardAnswers | null> {
  let config: ConfigAnswers | null = null;
  if (!context.configExists) {
    const presets = await askPresets(io, context.detected);
    if (presets === null) return null;
    const scope = await askScope(io, defaultAnswers(presets));
    if (scope === null) return null;
    config = { ...defaultAnswers(presets), ...scope };
  }
  const target = await askTarget(io);
  if (target === null) return null;
  // The hosted App holds its own provider credentials; only local and Actions runs need a key here.
  const key = target === "app" || context.keyPresent ? { kind: "later" as const } : await askKey(io);
  if (key === null) return null;
  if (config) {
    const policy = await askPolicy(io);
    if (policy === null) return null;
    const rules = await askRule(io);
    if (rules === null) return null;
    config = { ...config, ...policy, rules };
  }
  let compile = false;
  if (context.guidance) {
    const answer = await io.confirm({ message: "Compile AGENTS.md and skills into review questions now?", initialValue: true });
    if (answer === null) return null;
    compile = answer;
  }
  const installSkill = await io.confirm({ message: "Install the Hunch skill, so your coding agent can set up, write rules for and run Hunch?", initialValue: true });
  if (installSkill === null) return null;
  return { config, target, key, compile, installSkill };
}

/** Runs the `skills` installer in the foreground, so its own prompts and output reach the person. */
export function installSkill(root: string, run = spawnSync): boolean {
  const result = run("npx", [...SKILL_INSTALL], { cwd: root, stdio: "inherit", timeout: 300_000 });
  return !result.error && result.status === 0;
}

/** What to do next, in order, for the path chosen. Mirrors the README so the two cannot drift. */
export function nextSteps(target: Target, opts: { configFile: string; compiled: boolean; secretSet: boolean; keyDeferred: boolean }): string {
  const commit = `git add ${opts.configFile}${opts.compiled ? " hunch.lock" : ""}`;
  if (target === "app") {
    return [
      `1. Install the App on this repository:\n   ${INSTALL_URL}`,
      `2. Commit to your default branch:\n   ${commit}\n   git commit -m "Review PRs with Hunch"\n   git push`,
      "3. Open a PR. Hunch reads its rules from the base branch, so the PR that adds Hunch is skipped — that is expected.",
      "No review? Run: npx @kelbie/hunch doctor",
    ].join("\n\n");
  }
  if (target === "actions") {
    return [
      opts.secretSet ? "1. AI_GATEWAY_API_KEY is set as a repository secret." : "1. Set the model key as a repository secret:\n   gh secret set AI_GATEWAY_API_KEY",
      `2. Commit both files to your default branch:\n   ${commit} .github/workflows/hunch.yml\n   git commit -m "Review PRs with Hunch"\n   git push`,
      "3. Open a PR. The review appears under Checks → Hunch. The PR that adds Hunch is skipped — that is expected.",
    ].join("\n\n");
  }
  return [
    opts.keyDeferred ? "1. Export your model key:\n   export AI_GATEWAY_API_KEY=…" : "1. Your key is in .env.local (ignored by git).",
    "2. Review this branch:\n   npx @kelbie/hunch check",
  ].join("\n\n");
}
