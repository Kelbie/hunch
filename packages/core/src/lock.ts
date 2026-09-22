import { z } from "zod";
import { levelSchema, questionSchema } from "./schema.js";

/**
 * `hunch.lock`: rules compiled from skills and AGENTS.md, plus the rules copied from the packs the
 * config names. Committed so rule changes are reviewed like code, and so PR runs never need an LLM
 * or a fetch: whatever a review asks, it asks from this file.
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
  /** sha256 of the source text(s); a mismatch means `hunch install` is due. */
  hash: z.string(),
  rules: z.array(compiledRuleSchema),
  /** Guidance the compiler judged unsuitable for per-hunk checks. */
  notChecked: z.array(z.object({ section: z.string(), reason: z.string() })).default([]),
});
export type LockSource = z.output<typeof lockSourceSchema>;

/**
 * One pack the config names, copied in at `hunch install` time: no agent reads it, because a pack
 * is already the rules. Pinned to the commit it was copied from, so a later `install` can say the
 * pack moved and a review never depends on what the pack says today.
 */
export const lockPackSchema = z.object({
  /** `pack/<name>`. */
  id: z.string(),
  /** The spec the config wrote, e.g. `nuts-spec` or `owner/repo/payments@v2`. */
  spec: z.string(),
  /** `owner/repo/name`, as the report names a pack. */
  origin: z.string(),
  /** The commit the rules were copied from. */
  commit: z.string(),
  path: z.string(),
  /** sha256 of the pack file; a mismatch means the pack changed at that commit. */
  hash: z.string(),
  /** Id patterns the config selected; empty means the whole pack. */
  select: z.array(z.string()).default([]),
  /** Rules copied verbatim, with the pack's own level and scope. */
  rules: z.record(z.string(), z.object({ level: levelSchema, question: questionSchema })),
});
export type LockPack = z.output<typeof lockPackSchema>;

export const lockSchema = z.object({
  version: z.literal(1),
  selectionHash: z.string().optional(),
  compiler: z.object({ model: z.string() }),
  sources: z.array(lockSourceSchema),
  /** Absent when the config names no pack, so a lock without packs is unchanged by this field. */
  packs: z.array(lockPackSchema).optional(),
});
export type Lock = z.output<typeof lockSchema>;

/** Every rule id the lock defines: compiled from guidance, or copied from a pack. */
export function lockRuleIds(lock: Lock | null | undefined): string[] {
  return [
    ...(lock?.sources ?? []).flatMap((s) => s.rules.map((r) => r.id)),
    ...(lock?.packs ?? []).flatMap((p) => Object.keys(p.rules)),
  ];
}

export const LOCK_FILE = "hunch.lock";

export function parseLock(text: string): Lock {
  if (text.length > 8_000_000) throw new Error("hunch.lock exceeds 8 MB");
  const lock = lockSchema.parse(JSON.parse(text));
  const ids = lockRuleIds(lock);
  if (new Set(ids).size !== ids.length) throw new Error("hunch.lock has duplicate rule ids");
  const packIds = (lock.packs ?? []).map((p) => p.id);
  if (new Set(packIds).size !== packIds.length) throw new Error("hunch.lock names the same pack twice");
  return lock;
}

export function serializeLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
