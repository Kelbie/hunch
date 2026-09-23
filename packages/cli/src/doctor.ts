/**
 * Why is nothing reviewing this repository? Every check names what is missing and the command or
 * click that fixes it. Facts that cannot be established are reported as unknown, never as passing:
 * a green checklist beside a silent PR is worse than no checklist.
 */
import { pad, painter } from "../../core/src/index.js";

export type Status = "ok" | "bad" | "unknown";
export interface Check { label: string; status: Status; detail: string; fix?: string }

export interface Remote { owner: string; repo: string }

/** Both spellings git writes for GitHub remotes. Anything else is not a GitHub repository. */
export function parseRemote(url: string | null): Remote | null {
  if (!url) return null;
  const m = /^(?:https?:\/\/[^/]*github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export interface DoctorIo {
  /** A `gh api` call. `ok` is false for any non-zero exit, including 404. */
  gh(args: string[]): Promise<{ ok: boolean; body: string }>;
  /** Repository-relative read from the working tree. */
  local(path: string): string | null;
  remoteUrl(): string | null;
  env: NodeJS.ProcessEnv;
}

export interface DoctorOptions {
  /** The App a repository is expected to use. The hosted App by default. */
  slug: string;
  /** Config files a repository may carry, in the order `loadConfig` prefers them. */
  configNames?: string[];
}

const CONFIGS = ["hunch.config.ts", "hunch.toml"];

export async function diagnose(io: DoctorIo, options: DoctorOptions): Promise<Check[]> {
  const names = options.configNames ?? CONFIGS;
  const checks: Check[] = [];
  const localConfig = names.find((n) => io.local(n) !== null) ?? null;
  checks.push(localConfig
    ? { label: "Config in working tree", status: "ok", detail: localConfig }
    : { label: "Config in working tree", status: "bad", detail: "no hunch.config.ts or hunch.toml", fix: "npx @kelbie/hunch init" });

  const remote = parseRemote(io.remoteUrl());
  if (!remote) {
    checks.push({ label: "GitHub remote", status: "unknown", detail: "no github.com origin; only local review applies here" });
    return checks;
  }
  const slug = `${remote.owner}/${remote.repo}`;
  checks.push({ label: "GitHub remote", status: "ok", detail: slug });

  const repo = await json(io, [`/repos/${slug}`]);
  if (!repo) {
    checks.push({ label: "Repository access", status: "unknown", detail: "gh could not read the repository", fix: "gh auth login" });
    return checks;
  }
  const branch = String((repo as { default_branch?: string }).default_branch ?? "main");
  const ownerType = String(((repo as { owner?: { type?: string } }).owner)?.type ?? "User");

  // The most common silent failure: reviews read rules from the base branch, not your checkout.
  let onBase: string | null = null;
  for (const name of names) {
    if ((await json(io, [`/repos/${slug}/contents/${name}?ref=${branch}`]))) { onBase = name; break; }
  }
  checks.push(onBase
    ? { label: `Config on ${branch}`, status: "ok", detail: onBase }
    : { label: `Config on ${branch}`, status: "bad", detail: `no config on ${branch}; Hunch reads its rules from the base branch`, fix: `commit ${localConfig ?? "hunch.config.ts"} and merge it into ${branch}` });

  const workflow = io.local(".github/workflows/hunch.yml") !== null
    || Boolean(await json(io, [`/repos/${slug}/contents/.github/workflows/hunch.yml?ref=${branch}`]));

  // A private App can only ever be installed on the account that owns it.
  const app = await json(io, [`/apps/${options.slug}`]);
  const appOwner = app ? String(((app as { owner?: { login?: string } }).owner)?.login ?? "") : null;
  const installed = await installedOn(io, remote, ownerType, options.slug);

  if (installed === true) checks.push({ label: "App installed", status: "ok", detail: `${options.slug} is installed on ${remote.owner}` });
  else if (installed === false && !app) {
    checks.push({
      label: "App installed", status: "bad",
      detail: `${options.slug} is a private App, so it can only be installed on the account that owns it — not ${remote.owner}`,
      fix: workflow ? "reviews will come from the Actions workflow instead" : `make the App public, or use the Actions path: npx @kelbie/hunch init --github`,
    });
  } else if (installed === false) {
    checks.push({
      label: "App installed", status: workflow ? "unknown" : "bad",
      detail: `${options.slug} is not installed on ${remote.owner}`,
      fix: `https://github.com/apps/${options.slug}/installations/new`,
    });
  } else {
    checks.push({
      label: "App installed", status: "unknown",
      detail: `cannot list installations for ${remote.owner} with this token`,
      fix: `open https://github.com/apps/${options.slug}/installations/new and confirm ${remote.repo} is selected`,
    });
  }
  if (appOwner && appOwner !== remote.owner && !app) checks.push({ label: "App owner", status: "bad", detail: `owned by ${appOwner}, which cannot install on ${remote.owner} while private` });

  checks.push(workflow
    ? { label: "Actions workflow", status: "ok", detail: ".github/workflows/hunch.yml" }
    : { label: "Actions workflow", status: "unknown", detail: "not present; only needed for the Actions path" });

  if (workflow) {
    const secrets = await json(io, [`/repos/${slug}/actions/secrets/AI_GATEWAY_API_KEY`]);
    checks.push(secrets
      ? { label: "Actions secret", status: "ok", detail: "AI_GATEWAY_API_KEY is set" }
      : { label: "Actions secret", status: "bad", detail: "AI_GATEWAY_API_KEY is not set for Actions", fix: "gh secret set AI_GATEWAY_API_KEY" });
  }
  return checks;
}

/** True/false when the token can answer; null when it cannot, which is normal for user accounts. */
async function installedOn(io: DoctorIo, remote: Remote, ownerType: string, slug: string): Promise<boolean | null> {
  const path = ownerType === "Organization" ? `/orgs/${remote.owner}/installations` : "/user/installations";
  const body = await json(io, [path]);
  if (!body) return null;
  const list = (body as { installations?: { app_slug?: string; account?: { login?: string } }[] }).installations;
  if (!Array.isArray(list)) return null;
  return list.some((i) => i.app_slug === slug && (ownerType === "Organization" || i.account?.login === remote.owner));
}

async function json(io: DoctorIo, args: string[]): Promise<unknown | null> {
  const result = await io.gh(["api", ...args]);
  if (!result.ok) return null;
  try { return JSON.parse(result.body); } catch { return null; }
}

/**
 * One line per check, then the single next action. Exit code 1 when something is actually wrong.
 * Colour follows the mark rather than replacing it: a checklist read over a pipe still reads.
 */
export function report(checks: Check[], { color = false } = {}): { text: string; failed: boolean } {
  const p = painter(color);
  const mark = { ok: p.green("✓"), bad: p.red("✗"), unknown: p.yellow("?") } as const;
  const paint = { ok: p.plain, bad: p.bold, unknown: p.dim } as const;
  const lines = checks.map((c) => `  ${mark[c.status]} ${pad(p.bold(c.label), 22)} ${paint[c.status](c.detail)}`);
  const blocking = checks.filter((c) => c.status === "bad" && c.fix);
  const text = [...lines, "", blocking.length ? `${p.bold("Next:")} ${p.cyan(blocking[0]!.fix!)}` : p.green("Nothing is missing that Hunch can see from here.")].join("\n");
  return { text, failed: checks.some((c) => c.status === "bad") };
}
