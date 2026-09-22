import picomatch from "picomatch";
import { applyPresets, mergeRules } from "./load/index.js";
import { sha256, type LockPack } from "./lock.js";
import { ConfigError, packSelection, packSpec, parseConfig, type Config, type PackSource } from "./schema.js";

/**
 * A rule pack is a config file published in a repository's `rules/` folder, the way a skill is
 * published in `skills/`. It lets a repository that never installed Hunch be reviewed against a
 * shared policy, by name, without cloning anything.
 *
 *   "nuts-spec"                  rules/nuts-spec.json in Kelbie/hunch
 *   "owner/repo/name"            rules/name.json in owner/repo, on its default branch
 *   "owner/repo/name@v2"         the same, at a tag, branch or commit
 *   "nuts-spec#nut11/*,nut12/*"  only the rules whose ids match, by id or glob
 *
 * The selection is separated by `#`, not `/`, because `a/b/c` is already a whole pack name: a
 * rule path joined with slashes could not be told from a pack named `c` in the repository `a/b`.
 */
export interface PackSpec {
  repo: string;
  name: string;
  ref: string;
  path: string;
  /** Rule ids or globs the spec selected; empty means every rule in the pack. */
  select: string[];
}

/** Where official packs live. */
export const OFFICIAL_PACKS = "Kelbie/hunch";
export const PACK_DIR = "rules";

const SEGMENT = /^[\w.-]+$/;

const RULE_PATTERN = /^[\w.:*/-]+$/;

export function parsePackSpec(spec: string): PackSpec {
  const hash = spec.indexOf("#");
  const selected = hash === -1 ? "" : spec.slice(hash + 1).trim();
  const [target = "", ref = "HEAD", ...extra] = (hash === -1 ? spec : spec.slice(0, hash)).trim().split("@");
  const parts = target.split("/");
  const ok = !extra.length && (parts.length === 1 || parts.length === 3) && parts.every((p) => SEGMENT.test(p) && !/^\.+$/.test(p)) && /^[\w./-]+$/.test(ref) && !ref.includes("..");
  if (!ok) throw new ConfigError(`--pack "${spec.slice(0, 80)}" should be a pack name (nuts-spec), or owner/repo/name, optionally with @ref and #rule,rule.`);
  const select = selected.split(",").map((p) => p.trim()).filter(Boolean);
  if (hash !== -1 && !select.length) throw new ConfigError(`--pack "${spec.slice(0, 80)}" names no rule after "#". Write the ids or globs to keep, e.g. nuts-spec#nut11/*, or drop the "#" for the whole pack.`);
  if (!select.every((p) => RULE_PATTERN.test(p))) throw new ConfigError(`--pack "${spec.slice(0, 80)}": a rule selection is an id or a glob, e.g. nut11/* or nut11/locktime-boundary.`);
  const [owner, repo, name] = parts.length === 3 ? parts : [...OFFICIAL_PACKS.split("/"), parts[0]!];
  return { repo: `${owner}/${repo}`, name: name!, ref, path: `${PACK_DIR}/${name}.json`, select };
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
    const chosen = spec.select.length ? selectPackRules(config.rules, spec.select, label) : config.rules;
    rules = mergeRules(rules, Object.fromEntries(Object.entries(chosen).map(([id, entry]) => [id, {
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
    sources.push(`${label}@${spec.ref}${spec.select.length ? `#${spec.select.join(",")}` : ""}`);
  }
  settings.include = [...include];
  settings.ignore = [...ignore];
  return { rules, settings, sources };
}

/** Resolves a ref to the exact commit a pack is copied from. GitHub's API, or a test's stub. */
export interface PackPinner {
  commit(repo: string, ref?: string): Promise<string>;
}

/**
 * Keeps the rules whose ids a config selected, by exact id or glob. A pattern that matches nothing
 * is an error rather than an empty selection: a mistyped id would otherwise silently review nothing,
 * and the run would still look complete.
 */
export function selectPackRules(rules: Config["rules"], patterns: readonly string[], label: string): Config["rules"] {
  const out: Config["rules"] = {};
  const unmatched: string[] = [];
  for (const pattern of patterns) {
    const matched = Object.keys(rules).filter((id) => id === pattern || (pattern.includes("*") && picomatch.isMatch(id, pattern)));
    if (!matched.length) unmatched.push(pattern);
    for (const id of matched) out[id] = rules[id]!;
  }
  if (unmatched.length) {
    throw new ConfigError(
      `pack ${label} has no rule matching ${unmatched.map((p) => `"${p}"`).join(", ")}. ` +
        `See its ids with \`hunch config --pack ${label.split("/").at(-1)}\`, or use a glob such as "nut11/*".`,
    );
  }
  return out;
}

/**
 * Copies each configured pack into lock entries: fetched once, pinned to a commit, rules kept
 * verbatim. Nothing is compiled, because a pack is written as rules already; the agent is only
 * needed for prose guidance.
 */
export async function resolvePacks(
  sources: readonly PackSource[],
  deps: { pin: PackPinner; fetch?: PackFetcher },
): Promise<LockPack[]> {
  const fetch = deps.fetch ?? githubPackFetcher();
  const out: LockPack[] = [];
  for (const source of sources) {
    const spec = packSpec(source);
    const { repo, name, ref, path, select: inSpec } = parsePackSpec(spec);
    const listed = packSelection(source);
    if (listed && inSpec.length) throw new ConfigError(`packs: ${spec} selects rules twice, after "#" and in "rules". Keep one.`);
    const select = listed ?? (inSpec.length ? inSpec : undefined);
    const label = `${repo}/${name}`;
    const commit = await deps.pin.commit(repo, ref === "HEAD" ? undefined : ref);
    const text = await fetch({ repo, ref: commit, path });
    if (text == null) {
      throw new ConfigError(`packs: no ${path} in ${repo}@${ref}. Packs live in a repository's ${PACK_DIR}/ folder: https://github.com/${repo}/tree/${ref}/${PACK_DIR}`);
    }
    const loaded = await loadPacks([`${repo}/${name}@${commit}`], async () => text);
    const missing = Object.entries(loaded.rules).filter(([, e]) => !e.question).map(([id]) => id);
    if (missing.length) throw new ConfigError(`packs: ${label} sets a level for ${missing.join(", ")} but defines no question; a pack cannot re-level rules it does not define.`);
    const kept = select ? selectPackRules(loaded.rules, select, label) : loaded.rules;
    if (out.some((p) => p.id === `pack/${name}`)) throw new ConfigError(`packs: ${name} is named twice; a pack applies once.`);
    out.push({
      id: `pack/${name}`,
      spec,
      origin: label,
      commit,
      path,
      hash: await sha256(text),
      select: select ?? [],
      rules: Object.fromEntries(Object.entries(kept).map(([id, e]) => [id, { level: e.level, question: e.question! }])),
    });
  }
  return out;
}
