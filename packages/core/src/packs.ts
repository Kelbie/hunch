import { applyPresets, mergeRules } from "./load/index.js";
import { ConfigError, parseConfig, type Config } from "./schema.js";

/**
 * A rule pack is a config file published in a repository's `rules/` folder, the way a skill is
 * published in `skills/`. It lets a repository that never installed Hunch be reviewed against a
 * shared policy, by name, without cloning anything.
 *
 *   "cashu-nuts"                 rules/cashu-nuts.json in Kelbie/hunch
 *   "owner/repo/name"            rules/name.json in owner/repo, on its default branch
 *   "owner/repo/name@v2"         the same, at a tag, branch or commit
 */
export interface PackSpec {
  repo: string;
  name: string;
  ref: string;
  path: string;
}

/** Where official packs live. */
export const OFFICIAL_PACKS = "Kelbie/hunch";
export const PACK_DIR = "rules";

const SEGMENT = /^[\w.-]+$/;

export function parsePackSpec(spec: string): PackSpec {
  const [target = "", ref = "HEAD", ...extra] = spec.trim().split("@");
  const parts = target.split("/");
  const ok = !extra.length && (parts.length === 1 || parts.length === 3) && parts.every((p) => SEGMENT.test(p) && !/^\.+$/.test(p)) && /^[\w./-]+$/.test(ref) && !ref.includes("..");
  if (!ok) throw new ConfigError(`--pack "${spec.slice(0, 80)}" should be a pack name (cashu-nuts), or owner/repo/name, optionally with @ref.`);
  const [owner, repo, name] = parts.length === 3 ? parts : [...OFFICIAL_PACKS.split("/"), parts[0]!];
  return { repo: `${owner}/${repo}`, name: name!, ref, path: `${PACK_DIR}/${name}.json` };
}

/** Returns the file's text, or null when it does not exist. */
export type PackFetcher = (file: { repo: string; ref: string; path: string }) => Promise<string | null>;

/** Public GitHub, or a private repository with GITHUB_TOKEN. */
export const githubPackFetcher = (token = process.env.GITHUB_TOKEN): PackFetcher => async ({ repo, ref, path }) => {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new ConfigError(`--pack: GitHub answered ${res.status} for ${repo}/${path}@${ref}. Try again, or pass the rules as a file with --config.`);
  return res.text();
};

/**
 * A pack says what to ask and where. Where code is sent, what it costs to fail and what gets
 * compiled belong to the person running the review, so a fetched file may not decide them.
 */
const NOT_FOR_PACKS = ["provider", "model", "zeroDataRetention", "compileModel", "skills", "docs", "agentsMd", "failOnError"] as const;

export interface LoadedPacks {
  /** Every pack's rules, each kept to the files its own pack reviews. Later packs win an id. */
  rules: Config["rules"];
  /** The run's scope and limits: the union of the packs' scopes and the most generous budget. */
  settings: { include: string[]; ignore: string[]; budget: Partial<Config["budget"]>; review?: Config["review"]; task?: Config["task"] };
  /** `owner/repo/name@ref`, for the report. */
  sources: string[];
}

export async function loadPacks(specs: readonly string[], fetcher: PackFetcher = githubPackFetcher()): Promise<LoadedPacks> {
  let rules: Config["rules"] = {};
  const include = new Set<string>(), ignore = new Set<string>();
  const budget: Record<string, number> = {};
  const settings: LoadedPacks["settings"] = { include: [], ignore: [], budget };
  const sources: string[] = [];

  for (const spec of specs.map(parsePackSpec)) {
    const label = `${spec.repo}/${spec.name}`;
    const text = await fetcher(spec);
    if (text == null) throw new ConfigError(`--pack: no ${spec.path} in ${spec.repo}@${spec.ref}. Packs live in a repository's ${PACK_DIR}/ folder: https://github.com/${spec.repo}/tree/${spec.ref}/${PACK_DIR}`);
    if (text.length > 2_000_000) throw new ConfigError(`--pack ${label} exceeds 2 MB.`);
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text); } catch (e) { throw new ConfigError(`--pack ${label} is not valid JSON: ${(e as Error).message}`); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`--pack ${label} must be a JSON object.`);
    for (const key of NOT_FOR_PACKS) if (key in raw) throw new ConfigError(`--pack ${label} may not set "${key}": a pack is rules and their scope. Set it yourself with --config.`);

    const config = applyPresets(parseConfig({ ...raw, skills: [], agentsMd: false }, `--pack ${label}`));
    const scope = "include" in raw ? config.include : undefined;
    rules = mergeRules(rules, Object.fromEntries(Object.entries(config.rules).map(([id, entry]) => [id, {
      ...entry,
      // Packs run side by side, so a pack's scope travels with its rules instead of widening the others'.
      question: entry.question && scope && !entry.question.files ? { ...entry.question, files: scope } : entry.question,
      source: entry.source && entry.source !== "config" ? entry.source : `pack:${label}`,
    }])));
    for (const glob of config.include) include.add(glob);
    for (const glob of config.ignore) ignore.add(glob);
    if (raw.budget && typeof raw.budget === "object") for (const [k, v] of Object.entries(config.budget)) if (k in (raw.budget as object)) budget[k] = Math.max(budget[k] ?? 0, v);
    if ("review" in raw) settings.review = config.review;
    if ("task" in raw) settings.task = config.task;
    sources.push(`${label}@${spec.ref}`);
  }
  settings.include = [...include];
  settings.ignore = [...ignore];
  return { rules, settings, sources };
}
