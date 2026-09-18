import { generateObject } from "ai";
import { z } from "zod";
import type { CompiledRule, Lock, LockSource } from "./lock.js";
import { hashDoc, type SourceDoc } from "./skills.js";

/**
 * Turns prose guidance into atomic yes/no rules Jev can judge from one hunk.
 * Jev cannot read a 50k-token style guide or write text, so this runs once
 * per source change (with an LLM) and the result is committed as hunch.lock.
 */
export interface RuleExtractor {
  extract(input: { sourceId: string; sourceKind: SourceDoc["kind"]; chunk: string }): Promise<Extracted>;
}

export const extractedSchema = z.object({
  rules: z.array(
    z.object({
      slug: z.string().describe("kebab-case, unique within the source, e.g. `label-every-input`"),
      section: z.string().describe("Heading path the rule came from, e.g. `Forms > Labels`"),
      message: z.string().describe("One short sentence describing the problem a breaking hunk may have, shown to PR authors, e.g. `A failed request may now be reported as success.` Describe the risk, not a command."),
      instructions: z
        .string()
        .describe("A direct yes/no question about `hunk` where YES means the hunk BREAKS the rule. Name the exact condition."),
      criteriaTrue: z.string().describe("What a breaking hunk looks like, concretely"),
      criteriaFalse: z.string().describe("What a compliant or unrelated hunk looks like"),
      appliesTo: z.array(z.string()).describe("File globs the rule can apply to, e.g. `**/*.tsx`. Empty for any file."),
      when: z.string().nullable().describe("JS regex that must match the hunk text for the rule to be relevant, or null"),
    }),
  ),
  notChecked: z.array(z.object({ section: z.string(), reason: z.string() })),
});
export type Extracted = z.output<typeof extractedSchema>;

export const EXTRACTION_SYSTEM = `You convert engineering guidance (agent skills, AGENTS.md, style guides) into rules for a code-review classifier.

The classifier sees ONE chunk of code at a time and answers a single yes/no question per rule with a probability. It reads literally, cannot count or do arithmetic, cannot follow indirection, and cannot see any other file. It is given:
- \`context\`: prose saying whether the chunk is a diff or a whole file being read, which lines are under review, what kind of file it is (including whether it is a test, fixture or config file), and which other files the change touches;
- \`file\`: the repository-relative path;
- \`hunk\`: the code, as a unified diff where + is under review, - is the code being replaced and a leading space is unchanged context.

The classifier is ALREADY told, for every rule, to judge only what is visible, to ignore callers and behaviour it cannot see, and to answer no when the chunk is unrelated or the evidence is absent. Do not spend words repeating that. Write each question about the concern itself.

Emit a rule only when a reviewer could decide it from that single chunk. Each rule must be:
- atomic: one condition, never "X and Y";
- phrased so YES means the code breaks the rule ("Does \`hunk\` add … without …?");
- concrete: name the API, pattern, or construct, not "follows best practices";
- about the code under review, not about removed code.

State the guidance's own sanctioned exceptions in criteriaFalse, since a rule with no exceptions fires on the cases the authors deliberately allowed. Prefer \`when\` and \`appliesTo\` over prose conditions: they cost nothing and keep the question short.

Put everything else in notChecked with a short reason: process rules (commits, PRs, running commands), whole-repo or cross-file rules, anything needing counts/sizes/dates, subjective taste, and rules a linter or regex does exactly. Prefer fewer, high-signal rules over many vague ones. Do not invent rules the text does not state. For effective AGENTS guidance, later directory-specific instructions override conflicting earlier ancestor instructions; emit only the effective rule, not both.`;

export function gatewayExtractor(model: string, zeroDataRetention = true): RuleExtractor {
  return {
    async extract({ sourceId, sourceKind, chunk }) {
      const { object } = await generateObject({
        model,
        abortSignal: AbortSignal.timeout(90_000),
        maxRetries: 2,
        schema: extractedSchema,
        system: EXTRACTION_SYSTEM,
        prompt: extractionPrompt({ sourceId, sourceKind, chunk }),
        providerOptions: { gateway: { zeroDataRetention } },
      });
      return object;
    },
  };
}

/** The user message for one chunk; the document is data, not instructions. */
export function extractionPrompt({ sourceId, sourceKind, chunk }: Parameters<RuleExtractor["extract"]>[0]): string {
  return `Source: ${sourceId} (${sourceKind})\n\n<document>\n${chunk}\n</document>`;
}

/** Splits markdown at `#`/`##` headings into chunks under maxChars, keeping sections whole where possible. */
export function chunkMarkdown(md: string, maxChars = 40_000): string[] {
  const sections = md.split(/\n(?=#{1,2} )/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sections) {
    if (cur && cur.length + s.length > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    if (s.length > maxChars) {
      for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars));
      continue;
    }
    cur += (cur ? "\n" : "") + s;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

export async function compileSources(
  docs: SourceDoc[],
  opts: { extractor: RuleExtractor; model: string; previous?: Lock | null; force?: boolean; onSource?: (id: string, reused: boolean) => void },
): Promise<Lock> {
  const prev = new Map((opts.previous?.sources ?? []).map((s) => [s.id, s]));
  const sources: LockSource[] = [];
  for (const doc of docs) {
    const hash = await hashDoc(doc);
    const old = prev.get(doc.id);
    if (!opts.force && old && old.hash === hash && old.origin === doc.origin && old.commit === doc.commit && opts.previous?.compiler.model === opts.model) {
      sources.push(old); // unchanged: keep reviewed rules as-is
      opts.onSource?.(doc.id, true);
      continue;
    }
    const rules: CompiledRule[] = [];
    const notChecked: LockSource["notChecked"] = [];
    const slugs = new Set<string>();
    for (const chunk of chunkMarkdown(doc.text)) {
      const out = await opts.extractor.extract({ sourceId: doc.id, sourceKind: doc.kind, chunk });
      for (const r of out.rules) {
        let slug = r.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "rule";
        for (let n = 2; slugs.has(slug); n++) slug = `${slug.replace(/-\d+$/, "")}-${n}`;
        slugs.add(slug);
        rules.push({
          id: `${doc.id}/${slug}`,
          section: r.section,
          message: r.message,
          instructions: r.instructions,
          criteria: { true: r.criteriaTrue, false: r.criteriaFalse },
          appliesTo: r.appliesTo,
          ...(r.when && isValidRegex(r.when) ? { when: r.when } : {}),
        });
      }
      notChecked.push(...out.notChecked);
    }
    sources.push({ id: doc.id, kind: doc.kind, origin: doc.origin, commit: doc.commit, path: doc.path, scope: doc.scope, hash, rules, notChecked });
    opts.onSource?.(doc.id, false);
  }
  return { version: 1, compiler: { model: opts.model }, sources };
}

function isValidRegex(s: string) {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}
