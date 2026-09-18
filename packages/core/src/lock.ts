import { z } from "zod";

/**
 * `hunch.lock`: rules compiled from skills and AGENTS.md. Committed so rule
 * changes are reviewed like code, and so PR runs never need an LLM.
 */
export const compiledRuleSchema = z.object({
  /** Stable id, e.g. `skill/web-design-guidelines/label-every-input`. */
  id: z.string(),
  /** Heading path inside the source document. */
  section: z.string(),
  /** A yes/no question where "yes" means the hunk breaks the rule. */
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }),
  /** Globs of files the rule can apply to. Empty means every file. */
  appliesTo: z.array(z.string()).default([]),
  /** Optional regex prefilter over the hunk text. */
  when: z.string().refine((s) => { try { new RegExp(s); return true; } catch { return false; } }, "invalid regex").optional(),
  /** Short human summary shown in reports. */
  message: z.string(),
});
export type CompiledRule = z.output<typeof compiledRuleSchema>;

export const lockSourceSchema = z.object({
  /** `skill/<name>`, `agents-md/<dir>` or `doc/<path>` */
  id: z.string(),
  kind: z.enum(["skill", "agents-md", "doc"]),
  /** Local path, or `owner/repo` for remote skills. */
  origin: z.string(),
  /** Pinned commit for remote sources. */
  commit: z.string().optional(),
  path: z.string(),
  /** Directory the rules are scoped to (nested AGENTS.md). "" = repo root. */
  scope: z.string().default(""),
  /** sha256 of the source text(s); a mismatch means `hunch compile` is due. */
  hash: z.string(),
  rules: z.array(compiledRuleSchema),
  /** Guidance the compiler judged unsuitable for per-hunk checks. */
  notChecked: z.array(z.object({ section: z.string(), reason: z.string() })).default([]),
});
export type LockSource = z.output<typeof lockSourceSchema>;

export const lockSchema = z.object({
  version: z.literal(1),
  selectionHash: z.string().optional(),
  compiler: z.object({ model: z.string() }),
  sources: z.array(lockSourceSchema),
});
export type Lock = z.output<typeof lockSchema>;

export const LOCK_FILE = "hunch.lock";

export function parseLock(text: string): Lock {
  if (text.length > 2_000_000) throw new Error("hunch.lock exceeds 2 MB");
  const lock = lockSchema.parse(JSON.parse(text));
  const ids = lock.sources.flatMap((s) => s.rules.map((r) => r.id));
  if (new Set(ids).size !== ids.length) throw new Error("hunch.lock has duplicate rule ids");
  return lock;
}

export function serializeLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
