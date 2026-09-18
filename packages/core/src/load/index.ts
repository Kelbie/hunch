import { parse as parseToml } from "smol-toml";
import { presets } from "../presets.js";
import { ConfigError, type Config, parseConfig } from "../schema.js";
import { evaluateConfigSource } from "./static-ts.js";

/** Read-only view of a repo at one ref. Local disk and the GitHub API both implement it. */
export interface RepoReader {
  /** Returns null when the file does not exist. */
  read(path: string): Promise<string | null>;
  /** Lists directory entries (names only). Empty when missing. */
  list(dir: string): Promise<{ name: string; type: "file" | "dir" }[]>;
  /** Every tracked file path (for finding nested AGENTS.md). */
  files(): Promise<string[]>;
}

export const CONFIG_FILES = ["hunch.config.ts", "hunch.toml"] as const;

export interface LoadedConfig {
  path: (typeof CONFIG_FILES)[number];
  config: Config;
}

/**
 * Finds and parses the repo's config. One file per repo: `hunch.config.ts`
 * (TypeScript projects) wins over `hunch.toml` (Rust and everything else).
 * The TS file is always evaluated statically; see static-ts.ts.
 */
export async function loadConfig(repo: RepoReader): Promise<LoadedConfig | null> {
  const files = await Promise.all(CONFIG_FILES.map(async (path) => ({ path, src: await repo.read(path) })));
  const present = files.filter((f) => f.src !== null);
  if (present.length > 1) throw new ConfigError("Keep exactly one of hunch.config.ts and hunch.toml.");
  for (const { path, src } of present) {
    if (src!.length > 100_000) throw new ConfigError(`${path}: config exceeds 100 KB`);
    const raw = path.endsWith(".toml") ? tomlToConfig(src!, path) : evaluateConfigSource(src!, path);
    return { path, config: applyPresets(parseConfig(raw, path)) };
  }
  return null;
}

export function tomlToConfig(src: string, path = "hunch.toml"): unknown {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(src) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return camelizeConfig(doc);
}

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * TOML is written kebab-case (Cargo/clippy/rustfmt convention). Rename keys
 * to the schema's camelCase, but leave user-chosen names alone: rule ids and
 * choice option names.
 */
function camelizeConfig(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => camelizeConfig(v, parentKey));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(value)) {
    if (parentKey === "rules") out[k] = camelizeConfig(v, "rule");
    else if (k === "criteria") out[k] = v;
    else out[camel(k)] = camelizeConfig(v, k);
  }
  return out;
}

/** Merges `extends` presets under the user's own rules (user wins). */
export function applyPresets(config: Config): Config {
  let rules: Config["rules"] = {};
  for (const name of config.extends) {
    const preset = presets[name];
    if (!preset) throw new ConfigError(`unknown preset "${name}" (available: ${Object.keys(presets).join(", ")})`);
    rules = mergeRules(rules, Object.fromEntries(Object.entries(preset).map(([id, rule]) => [id, { ...rule, source: name }])));
  }
  return { ...config, rules: mergeRules(rules, config.rules) };
}

/** A bare level (`"off"`) changes severity but keeps the inherited question. */
export function mergeRules(base: Config["rules"], over: Config["rules"]): Config["rules"] {
  const out = { ...base };
  for (const [id, entry] of Object.entries(over)) {
    out[id] = { level: entry.level, question: entry.question ?? base[id]?.question,
      source: entry.question ? entry.source ?? "config" : base[id]?.source ?? "config" };
  }
  return out;
}
