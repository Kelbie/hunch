import { z } from "zod";

/** A regex as data: TS configs give RegExp literals, TOML gives strings. */
export const patternSchema = z
  .union([
    z.instanceof(RegExp).transform((r) => ({ source: r.source, flags: r.flags })),
    z.string().transform((s) => ({ source: s, flags: "" })),
    z.strictObject({ source: z.string(), flags: z.string().default("") }),
  ])
  .refine(
    (p) => {
      try {
        new RegExp(p.source, p.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid regular expression" },
  );
export type Pattern = z.output<typeof patternSchema>;

const shared = {
  instructions: z.string().min(1).max(8000),
  /** Only ask Jev when the hunk text matches (cheap code-side prefilter). */
  when: patternSchema.optional(),
  /** Repo-relative file sent alongside the hunk as `reference`. */
  reference: z.string().optional(),
  /** Shown in reports; defaults to the instructions. */
  message: z.string().optional(),
};

export const noulQuestionSchema = z.strictObject({
  kind: z.literal("noul"),
  ...shared,
  criteria: z.strictObject({ true: z.string().optional(), false: z.string().optional() }).optional(),
  /** Report when P(yes) >= threshold. */
  threshold: z.number().min(0).max(1).default(0.7),
});

export const choiceQuestionSchema = z.strictObject({
  kind: z.literal("choice"),
  ...shared,
  criteria: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length >= 2, {
    message: "choice needs at least two options",
  }),
  /** Options that produce a finding when chosen. */
  report: z.array(z.string()).min(1),
  minConfidence: z.number().min(0).max(1).default(0),
});

export const scoreQuestionSchema = z
  .strictObject({
    kind: z.literal("score"),
    ...shared,
    /** Ordered lowest → highest; descriptive sentences work best. */
    criteria: z.array(z.string()).min(2),
    /** Report when score/(levels-1) < reportBelow. */
    reportBelow: z.number().min(0).max(1).optional(),
    /** Report when score/(levels-1) > reportAbove. */
    reportAbove: z.number().min(0).max(1).optional(),
    minConfidence: z.number().min(0).max(1).default(0),
  })
  .refine((q) => q.reportBelow !== undefined || q.reportAbove !== undefined, {
    message: "score rules need reportBelow or reportAbove",
  });

export const questionSchema = z.union([noulQuestionSchema, choiceQuestionSchema, scoreQuestionSchema]);
export type Question = z.output<typeof questionSchema>;
export type NoulQuestion = z.output<typeof noulQuestionSchema>;
export type ChoiceQuestion = z.output<typeof choiceQuestionSchema>;
export type ScoreQuestion = z.output<typeof scoreQuestionSchema>;

export const levelSchema = z.enum(["off", "warn", "error"]);
export type Level = z.output<typeof levelSchema>;

/** Plain-English rule → a noul asking whether the hunk breaks it. */
export function plainRule(text: string): NoulQuestion {
  return noulQuestionSchema.parse({
    kind: "noul",
    instructions: `Does the code added or changed in \`hunk\` break this rule? Rule: ${text}`,
    criteria: {
      true: "The added or changed lines clearly break the rule.",
      false: "The rule is followed, or the hunk has nothing to do with it.",
    },
    threshold: 0.7,
    message: text,
  });
}

/**
 * Accepted rule entry shapes:
 *   "warn"                          (built-in / preset rule, just set the level)
 *   ["warn", "plain english"]       (plain rule)
 *   ["warn", noul({...})]           (typed rule, TS helpers)
 *   { level, noul|choice|score: "instructions", ...options }   (TOML table form)
 */
const tomlTableSchema = z
  .strictObject({
    level: levelSchema.default("warn"),
    rule: z.string().optional(),
    noul: z.string().optional(),
    choice: z.string().optional(),
    score: z.string().optional(),
  })
  .passthrough()
  .transform((t, ctx) => {
    const { level, rule, noul, choice, score, ...rest } = t;
    const kinds = [rule && "rule", noul && "noul", choice && "choice", score && "score"].filter(Boolean);
    if (kinds.length !== 1) {
      ctx.addIssue({ code: "custom", message: "set exactly one of rule, noul, choice, score" });
      return z.NEVER;
    }
    if (rule) return { level, question: plainRule(rule) };
    const kind = kinds[0] as "noul" | "choice" | "score";
    const parsed = questionSchema.safeParse({ ...rest, kind, instructions: t[kind] });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: "custom" } as never);
      return z.NEVER;
    }
    return { level, question: parsed.data };
  });

export const ruleEntrySchema = z.union([
  levelSchema.transform((level) => ({ level, question: undefined })),
  z.tuple([levelSchema, z.string()]).transform(([level, text]) => ({ level, question: plainRule(text) as Question })),
  z.tuple([levelSchema, questionSchema]).transform(([level, question]) => ({ level, question: question as Question | undefined })),
  tomlTableSchema,
]);
export type RuleEntry = { level: Level; question: Question | undefined };

/** Skill source, following the `npx skills add` conventions. */
export const skillSourceSchema = z.union([
  z.string(), // "./skills/*", "./skills/foo", "owner/repo", "https://github.com/o/r/tree/ref/path"
  z.strictObject({ repo: z.string(), skill: z.string().optional(), ref: z.string().optional() }),
]);
export type SkillSource = z.output<typeof skillSourceSchema>;

export const configSchema = z.strictObject({
  /** TypeSafe model id (direct provider). The gateway currently serves `typesafe-ai/jev` only. */
  model: z.string().default("jev-1.13.0"),
  provider: z.enum(["gateway", "typesafe"]).default("gateway"),
  zeroDataRetention: z.boolean().default(true),
  extends: z.array(z.string()).default([]),
  include: z.array(z.string()).default(["**/*"]),
  ignore: z.array(z.string()).default([]),
  unit: z.literal("hunk").default("hunk"),
  /** "pr" sends the PR title + body as `task`; "none" sends nothing. */
  task: z.enum(["pr", "none"]).default("pr"),
  skills: z.array(skillSourceSchema).default([]),
  /** Compile root + nested AGENTS.md into rules. */
  agentsMd: z.boolean().default(true),
  /** Extra repo docs to compile into rules (e.g. a style guide AGENTS.md links to). */
  docs: z.array(z.string()).default([]),
  /** LLM used only by `hunch compile` (via AI Gateway). PR runs use Jev alone. */
  compileModel: z.string().default("anthropic/claude-sonnet-5"),
  /** Fail the check run when an `error` finding is reported. */
  failOnError: z.boolean().default(false),
  budget: z
    .strictObject({
      maxHunks: z.number().int().min(1).max(200).default(100),
      maxRulesPerHunk: z.number().int().min(1).max(64).default(24),
      concurrency: z.number().int().min(1).max(8).default(4),
    })
    .default({ maxHunks: 100, maxRulesPerHunk: 24, concurrency: 4 }),
  rules: z.record(z.string(), ruleEntrySchema).default({}),
  overrides: z
    .array(z.strictObject({ files: z.array(z.string()).min(1), rules: z.record(z.string(), ruleEntrySchema) }))
    .default([]),
});

export type ConfigInput = z.input<typeof configSchema>;
export type Config = z.output<typeof configSchema>;

export function parseConfig(raw: unknown, origin: string): Config {
  const res = configSchema.safeParse(raw);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${origin} is invalid:\n${lines.join("\n")}`);
  }
  return res.data;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}
