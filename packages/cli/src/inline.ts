import { readFileSync } from "node:fs";
import { applyPresets, ConfigError, loadConfig, mergeRules, parseConfig, ruleEntrySchema, type Config, type RepoReader } from "../../core/src/index.js";

/** Where the config came from (a config file, `--config` or `--rule`) and the resolved config. */
export interface ResolvedConfig { path: string; config: Config }

export interface InlineOptions {
  /** `--config`, repeatable: JSON text, a path to a JSON file, or `-` for stdin. Later ones win. */
  config?: string[];
  /** `--rule id=text`, repeatable: plain-English rules at `warn`. */
  rules?: string[];
  /** Reads stdin; tests pass a string. */
  stdin?: () => string;
}

/**
 * The config for a run: `--config` replaces the repository's config file, and
 * `--rule` adds to whichever config applies. A repository that never installed
 * Hunch has no hunch.lock, so inline configs don't pick up skills or AGENTS.md
 * unless they ask for them.
 */
export async function resolveConfig(repo: RepoReader, opts: InlineOptions): Promise<ResolvedConfig | null> {
  let loaded: ResolvedConfig | null;
  if (opts.config?.length) loaded = { path: "--config", config: inlineConfig(opts.config.map((arg) => readConfigArg(arg, opts.stdin)).reduce(layer, {})) };
  else loaded = await loadConfig(repo);
  if (!opts.rules?.length) return loaded;
  const base: ResolvedConfig = loaded ?? { path: "--rule", config: inlineConfig({}) };
  const added = Object.fromEntries(opts.rules.map(parseRuleArg));
  return { ...base, config: { ...base.config, rules: mergeRules(base.config.rules, added) } };
}

function readConfigArg(arg: string, stdin = () => readFileSync(0, "utf8")): unknown {
  const text = arg === "-" ? stdin() : arg.trimStart().startsWith("{") ? arg : readFile(arg);
  try { return JSON.parse(text); }
  catch (e) { throw new ConfigError(`--config is not valid JSON: ${(e as Error).message}`); }
}

/** Later configs override earlier ones; `rules` and `budget` merge key by key. */
function layer(base: Record<string, unknown>, over: unknown): Record<string, unknown> {
  if (!over || typeof over !== "object" || Array.isArray(over)) throw new ConfigError("--config must be a JSON object");
  const o = over as Record<string, unknown>;
  const merged = { ...base, ...o };
  for (const key of ["rules", "budget"]) if (base[key] && o[key]) merged[key] = { ...(base[key] as object), ...(o[key] as object) };
  return merged;
}

function readFile(path: string) {
  try { return readFileSync(path, "utf8"); }
  catch { throw new ConfigError(`--config: can't read ${path}. Pass JSON, a JSON file path, or - for stdin.`); }
}

function inlineConfig(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("--config must be a JSON object");
  return applyPresets(parseConfig({ skills: [], agentsMd: false, ...raw }, "--config"));
}

function parseRuleArg(arg: string): [string, ReturnType<typeof ruleEntrySchema.parse>] {
  const m = /^([\w.:/-]+)=(.+)$/s.exec(arg.trim());
  if (!m) throw new ConfigError(`--rule "${arg.slice(0, 60)}" should look like id=Plain-English rule, e.g. api/errors=Error responses keep their code field.`);
  return [m[1]!, ruleEntrySchema.parse(["warn", m[2]!.trim()])];
}
