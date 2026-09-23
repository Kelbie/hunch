import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getVercelOidcToken } from "@vercel/oidc";
import { isAuthError, type Provider } from "../../core/src/index.js";

export type { Provider };

/** The only secrets the store will ever hold or hand to the environment. */
export const KEY_NAMES = ["AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"] as const;
export type KeyName = (typeof KEY_NAMES)[number];
/** The providers a key signs in to. SemIf is a local program, so there is nothing to sign in to. */
export type KeyProvider = "gateway" | "typesafe";
export const isKeyProvider = (provider: Provider): provider is KeyProvider => provider !== "semif";

/** A Vercel project whose OIDC token the AI Gateway accepts, for people who sign in with `vercel login` and hold no key. */
export interface VercelLink { project: string; team?: string }
const LINK_FIELDS = ["HUNCH_VERCEL_PROJECT", "HUNCH_VERCEL_TEAM"] as const;
/**
 * Where SemIf is on this machine and which model it should load. These are settings, not secrets:
 * they are kept here because they belong to the machine rather than to any repository, the way the
 * Vercel project does, and because a person should have to say them once.
 */
export const SEMIF_FIELDS = ["SEMIF_PYTHON", "SEMIF_MODEL", "SEMIF_REVISION", "SEMIF_MODE", "SEMIF_BACKEND", "SEMIF_GGUF"] as const;
export type SemifField = (typeof SEMIF_FIELDS)[number];
export type SemifInstall = Partial<Record<SemifField, string>>;
const FIELDS = [...KEY_NAMES, ...LINK_FIELDS, ...SEMIF_FIELDS] as const;
type Field = (typeof FIELDS)[number];

export const keyNameFor = (provider: KeyProvider): KeyName => (provider === "gateway" ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY");

/**
 * One file per person, not per project, so `hunch` works in any directory after one login. It
 * sits where `gh` and `stripe` keep theirs: `$XDG_CONFIG_HOME/hunch`, `~/.config/hunch`, or
 * `%APPDATA%\hunch` on Windows. `HUNCH_CONFIG_DIR` moves it, for tests and unusual homes.
 */
export function credentialsPath(env: Record<string, string | undefined> = process.env, home = homedir(), platform: string = process.platform): string {
  if (env.HUNCH_CONFIG_DIR) return join(env.HUNCH_CONFIG_DIR, "credentials");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "hunch", "credentials");
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "hunch", "credentials");
  return join(home, ".config", "hunch", "credentials");
}

/**
 * `NAME=value` lines. Anything but the two key names is ignored rather than exported, so a
 * tampered file cannot set `NODE_OPTIONS` or a proxy for the process that holds the key.
 */
export function readCredentials(path = credentialsPath()): Partial<Record<KeyName, string>> {
  const all = readFields(path);
  return Object.fromEntries(KEY_NAMES.filter((n) => all[n]).map((n) => [n, all[n]]));
}

function readFields(path: string): Partial<Record<Field, string>> {
  if (!existsSync(path)) return {};
  const out: Partial<Record<Field, string>> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !FIELDS.includes(m[1] as Field)) continue;
    const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (value) out[m[1] as Field] = value;
  }
  return out;
}

function write(path: string, keys: Partial<Record<Field, string>>) {
  const lines = FIELDS.filter((n) => keys[n]).map((n) => `${n}=${keys[n]}\n`);
  if (!lines.length) return rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Written beside the target and renamed over it, so an interrupted login cannot leave half a key.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join(""), { mode: 0o600 });
  chmodSync(tmp, 0o600); // `mode` is masked by umask, and ignored when the file already exists.
  renameSync(tmp, path);
}

/** Owner-only, like `~/.config/gh/hosts.yml`. Replaces a key already stored under the same name. */
export function saveCredential(name: KeyName, value: string, path = credentialsPath()): string {
  const key = value.trim();
  if (!key || /\s/.test(key)) throw new Error("That does not look like a key: it is empty or contains whitespace.");
  write(path, { ...readFields(path), [name]: key });
  return path;
}

/** What `auth login --provider semif` remembered, or null when SemIf was never set up here. */
export function readSemifInstall(path = credentialsPath()): SemifInstall | null {
  const all = readFields(path);
  const install = Object.fromEntries(SEMIF_FIELDS.filter((n) => all[n]).map((n) => [n, all[n]])) as SemifInstall;
  return Object.keys(install).length ? install : null;
}

/**
 * Replaces the whole SemIf install rather than merging into it, so switching backend or model
 * cannot leave a stale checkpoint path behind to be picked up by the next run.
 */
export function saveSemifInstall(install: SemifInstall, path = credentialsPath()): string {
  for (const [name, value] of Object.entries(install)) {
    if (value && /[\n\r]/.test(value)) throw new Error(`${name} must be a single line.`);
  }
  const rest = Object.fromEntries(Object.entries(readFields(path)).filter(([n]) => !(SEMIF_FIELDS as readonly string[]).includes(n)));
  write(path, { ...rest, ...Object.fromEntries(Object.entries(install).filter(([, v]) => v)) });
  return path;
}

export function removeSemifInstall(path = credentialsPath()): boolean {
  const install = readSemifInstall(path);
  if (install) write(path, Object.fromEntries(Object.entries(readFields(path)).filter(([n]) => !(SEMIF_FIELDS as readonly string[]).includes(n))));
  return Boolean(install);
}

/**
 * Like a stored key: it fills a `SEMIF_*` name the real environment and the project's `.env` files
 * left unset, so a project or a single command can still point at a different model or interpreter.
 */
export function applySemifInstall(env: Record<string, string | undefined> = process.env, path = credentialsPath(env)): SemifField[] {
  const applied: SemifField[] = [];
  for (const [name, value] of Object.entries(readSemifInstall(path) ?? {}) as [SemifField, string][]) {
    if (env[name]) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

/**
 * Where `auth login --provider semif --install` puts the interpreter it makes. Data, not config, so
 * it follows the data convention rather than sitting beside the credentials: `$XDG_DATA_HOME/hunch`,
 * `~/.local/share/hunch`, or `%LOCALAPPDATA%\hunch` on Windows. `HUNCH_CONFIG_DIR` moves it too, so
 * one variable still isolates a test or an unusual home.
 */
export function semifVenvPath(env: Record<string, string | undefined> = process.env, home = homedir(), platform: string = process.platform): string {
  if (env.HUNCH_CONFIG_DIR) return join(env.HUNCH_CONFIG_DIR, "semif");
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "hunch", "semif");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "hunch", "semif");
  return join(home, ".local", "share", "hunch", "semif");
}

/** The interpreter inside a virtualenv, wherever this platform keeps it. */
export const venvPython = (venv: string, platform: string = process.platform): string =>
  platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");

export function readVercelLink(path = credentialsPath()): VercelLink | null {
  const all = readFields(path);
  return all.HUNCH_VERCEL_PROJECT ? { project: all.HUNCH_VERCEL_PROJECT, ...(all.HUNCH_VERCEL_TEAM ? { team: all.HUNCH_VERCEL_TEAM } : {}) } : null;
}

/** Ids or slugs, as `vercel link` records them. They are not secrets, but they end up in a request, so they are held to a plain shape. */
export function saveVercelLink(link: VercelLink, path = credentialsPath()): string {
  checkVercelLink(link);
  const { HUNCH_VERCEL_TEAM: _team, ...rest } = readFields(path);
  write(path, { ...rest, HUNCH_VERCEL_PROJECT: link.project, ...(link.team ? { HUNCH_VERCEL_TEAM: link.team } : {}) });
  return path;
}

function checkVercelLink(link: VercelLink) {
  for (const v of [link.project, link.team]) if (v !== undefined && !/^[\w.-]+$/.test(v)) throw new Error(`"${v}" is not a Vercel project or team id or slug.`);
}

type MintToken = (link: VercelLink) => Promise<string>;

/** A short-lived AI Gateway token for the project, from the Vercel CLI login on this machine. */
export async function mintVercelToken(link: VercelLink, mint: MintToken = (l) => getVercelOidcToken(l)): Promise<string> {
  checkVercelLink(link);
  try {
    return await mint(link);
  } catch {
    // The helper's message can quote a response; the cause is nearly always an expired CLI login.
    throw new Error(`Vercel could not issue a token for project ${link.project}. Run \`vercel login\`, check the project and team, then try again.`);
  }
}

export function removeVercelLink(path = credentialsPath()): boolean {
  const { HUNCH_VERCEL_PROJECT: project, HUNCH_VERCEL_TEAM: _team, ...rest } = readFields(path);
  if (project) write(path, rest);
  return Boolean(project);
}

/** The project `vercel link` recorded in or above `dir`, which the AI SDK finds the same way. */
export function linkedVercelProject(dir: string): VercelLink | null {
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, ".vercel", "project.json");
    if (existsSync(file)) {
      try {
        const json = JSON.parse(readFileSync(file, "utf8")) as { projectId?: unknown; orgId?: unknown };
        if (typeof json.projectId === "string") return { project: json.projectId, ...(typeof json.orgId === "string" ? { team: json.orgId } : {}) };
      } catch { /* an unreadable link is no link */ }
      return null;
    }
    if (at === dirname(at)) return null;
  }
}

/**
 * Outside a linked directory the AI SDK has no project to mint an OIDC token for, which is why
 * Hunch used to work only inside one. Given the stored link, the same Vercel CLI login mints it
 * anywhere and leaves it in `VERCEL_OIDC_TOKEN`, where the SDK looks first. A key, or a link in
 * the working directory, wins: both already work without this.
 */
export async function useVercelLink(
  opts: { env?: Record<string, string | undefined>; cwd?: string; path?: string; mint?: MintToken } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (env.AI_GATEWAY_API_KEY || linkedVercelProject(opts.cwd ?? process.cwd())) return false;
  const link = readVercelLink(opts.path ?? credentialsPath(env));
  if (!link) return false;
  env.VERCEL_OIDC_TOKEN = await mintVercelToken(link, opts.mint);
  return true;
}

/** Removes the named keys, or all of them. Returns what was actually stored, so logout can say so. */
export function removeCredentials(names: readonly KeyName[] = KEY_NAMES, path = credentialsPath()): KeyName[] {
  const current = readCredentials(path);
  const removed = names.filter((n) => current[n]);
  if (removed.length) write(path, Object.fromEntries(Object.entries(readFields(path)).filter(([n]) => !names.includes(n as KeyName))));
  return removed;
}

/**
 * The lowest-priority source: a stored key fills a name only when the real environment and the
 * project's `.env` files left it unset, so a project can still pin its own key.
 */
export function applyCredentials(env: Record<string, string | undefined> = process.env, path = credentialsPath(env)): KeyName[] {
  const applied: KeyName[] = [];
  for (const [name, value] of Object.entries(readCredentials(path)) as [KeyName, string][]) {
    if (env[name]) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

/** A key file others can read is worth saying out loud; `auth status` does. Never true on Windows. */
export function looselyPermitted(path = credentialsPath(), platform: string = process.platform): boolean {
  return platform !== "win32" && existsSync(path) && (statSync(path).mode & 0o077) !== 0;
}

export type KeySource = "environment" | "stored" | "missing";

/** Where each key would come from on the next run, without revealing any of it. */
export function keySources(env: Record<string, string | undefined>, applied: readonly KeyName[]): Record<KeyName, KeySource> {
  return Object.fromEntries(KEY_NAMES.map((n) => [n, applied.includes(n) ? "stored" : env[n] ? "environment" : "missing"])) as Record<KeyName, KeySource>;
}

/**
 * The provider SDK answers a missing key with its own sign-up instructions, which name neither
 * Hunch nor the one command that fixes it everywhere. Other errors pass through untouched.
 */
export function authHint(message: string): string | null {
  if (/hunch auth login/.test(message)) return null;
  if (!isAuthError(message)) return null;
  return [
    "Hunch has no working model key here. Store one once, for every directory. The person runs one of:",
    "  npx @kelbie/hunch auth login --provider typesafe      asks for a TypeSafe key with a hidden prompt",
    "  npx @kelbie/hunch auth login --provider gateway       asks for a Vercel AI Gateway key",
    "  npx @kelbie/hunch auth login --with-token < file      reads the key from standard input, for scripts",
    "  npx @kelbie/hunch auth login --vercel                 no key: reuse a Vercel CLI login, from a linked project",
    "  npx @kelbie/hunch auth login --provider semif --install   no account anywhere: install an open model and run it here",
    "or export TYPESAFE_API_KEY or AI_GATEWAY_API_KEY. `npx @kelbie/hunch auth status` shows what is found.",
    "An agent must not ask for the key in conversation or pass it as an argument.",
  ].join("\n");
}

/**
 * What to run next for a failure Hunch recognises, or null. Errors reach people and agents alike,
 * and an agent can only recover from one that names the command.
 */
export function nextStep(message: string): string | null {
  const auth = authHint(message);
  if (auth) return auth;
  if (/SemIf is not set up|SemIf could not start|SemIf did not load/i.test(message)) return [
    "SemIf runs an open model on this machine, and this one is not ready. The person does one of:",
    "  pip install 'semif-phase1 @ git+https://github.com/TheoLeeCJ/SemIf'   install SemIf and its model runtime",
    "  npx @kelbie/hunch auth login --provider semif         say which Python and model Hunch should use",
    "  npx @kelbie/hunch auth status                         see what Hunch found for SemIf here",
    "  add --provider gateway (or typesafe) to this command  use a hosted provider for this run instead",
    "The lines above the hint come from SemIf itself and name the missing piece.",
  ].join("\n");
  if (/Zero Data Retention|\bZDR\b/i.test(message)) return [
    "This Vercel plan cannot enforce zero data retention, which Hunch asks the Gateway for by default. The person chooses one:",
    "  npx @kelbie/hunch auth login --provider typesafe      use a TypeSafe key instead; nothing passes through the Gateway",
    "  npx @kelbie/hunch auth login --provider semif --install   run an open model here instead; no account, no routing",
    "  add --config '{\"zeroDataRetention\":false}'             accept Gateway routing without it, for this run (with --pack or --config)",
    "  set zeroDataRetention: false in the Hunch config       the same, for a configured repository",
    "Turning it off is a data-handling decision; do not make it for them.",
  ].join("\n");
  if (/HTTP 402|insufficient (credit|funds|balance)/i.test(message)) return [
    "The model provider refused the request for payment: the account behind this key has no credit or quota left. The person does one of:",
    "  add credit to the provider account the key belongs to, then run the same command again",
    "  npx @kelbie/hunch auth status                         see which key is in use, and from where",
    "  npx @kelbie/hunch auth login --provider typesafe      sign in with a different TypeSafe key (or --provider gateway)",
    "  npx @kelbie/hunch auth login --provider semif --install   stop paying anyone: an open model, on this machine",
    "Nothing was reviewed. Add --dry-run to size a run before paying for it.",
  ].join("\n");
  if (/not a git repository/i.test(message)) return "Hunch reads files through git. Run it inside a git repository, or pass --cwd <dir>. For a folder that is not one: `git init && git add -A`, then run it again.";
  return null;
}
