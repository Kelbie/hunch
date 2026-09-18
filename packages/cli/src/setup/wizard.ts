import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, isCancel, note, outro, password, select } from "@clack/prompts";

/** Where reviews run. The App needs nothing in the repository beyond a committed config. */
export type Target = "local" | "app" | "actions";
export type Preset = "ts" | "rust" | "general";
export type KeyChoice = { kind: "gateway" | "typesafe"; value: string } | { kind: "later" };

export const INSTALL_URL = "https://github.com/apps/hunch-review/installations/new";

/**
 * Everything the wizard touches outside itself, so the flow is exercised without a terminal,
 * a repository or a network. Mirrors the injected `Io` in pick.ts.
 */
export interface WizardIo {
  select: (opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValue?: string }) => Promise<string | null>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean | null>;
  password: (opts: { message: string }) => Promise<string | null>;
  note: (body: string, title?: string) => void;
  outro: (message: string) => void;
}

export const clackIo = (): WizardIo => ({
  select: async (opts) => { const v = await select(opts); return isCancel(v) ? null : String(v); },
  confirm: async (opts) => { const v = await confirm(opts); return isCancel(v) ? null : v; },
  password: async (opts) => { const v = await password(opts); return isCancel(v) ? null : v; },
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

export async function askPreset(io: WizardIo, detected: Preset): Promise<Preset | null> {
  const value = await io.select({
    message: "Which starter rules?",
    initialValue: detected,
    options: [
      { value: "ts", label: "TypeScript / JavaScript", hint: detected === "ts" ? "detected package.json" : "hunch.config.ts" },
      { value: "rust", label: "Rust", hint: detected === "rust" ? "detected Cargo.toml" : "hunch.toml" },
      { value: "general", label: "Anything else", hint: "hunch.toml" },
    ],
  });
  return value as Preset | null;
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
  preset: Preset;
  target: Target;
  key: KeyChoice;
  compile: boolean;
}

/**
 * Asks only what the flags did not already decide. Returns null when the person cancels, so the
 * caller writes nothing: a half-configured repository is worse than an unconfigured one.
 */
export async function askWizard(io: WizardIo, context: { root: string; detected: Preset; configExists: boolean; guidance: boolean; keyPresent: boolean }): Promise<WizardAnswers | null> {
  const preset = context.configExists ? context.detected : await askPreset(io, context.detected);
  if (preset === null) return null;
  const target = await askTarget(io);
  if (target === null) return null;
  // The hosted App holds its own provider credentials; only local and Actions runs need a key here.
  const key = target === "app" || context.keyPresent ? { kind: "later" as const } : await askKey(io);
  if (key === null) return null;
  let compile = false;
  if (context.guidance) {
    const answer = await io.confirm({ message: "Compile AGENTS.md and skills into review questions now?", initialValue: true });
    if (answer === null) return null;
    compile = answer;
  }
  return { preset, target, key, compile };
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
