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
  /** Only evaluate this question for matching repository-relative file paths. */
  files: z.array(z.string()).min(1).optional(),
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
  /** Relevant but undecidable labels: coverage gaps rather than a pass or finding. */
  abstain: z.array(z.string()).default([]),
  minConfidence: z.number().min(0).max(1).default(0),
}).refine((q) => q.report.every((label) => Object.hasOwn(q.criteria, label)), {
  // A label Jev is never offered can never be chosen, so the rule would stay silent forever.
  message: "every report label must be one of the criteria",
  path: ["report"],
}).refine(q => q.abstain.every(label => Object.hasOwn(q.criteria, label) && !q.report.includes(label)), {
  message: "abstain labels must exist in criteria and must not also be report labels", path: ["abstain"],
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
    instructions: `Does the change in \`hunk\`, including a removal, break this rule? For a whole-file review, judge the existing code. Rule: ${text}`,
    criteria: {
      true: "The change (including a removal), or the existing code in a whole-file review, visibly breaks the rule.",
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
export type RuleEntry = { level: Level; question: Question | undefined; /** Assigned while resolving presets, never read from config input. */ source?: string };

/** Skill source, following the `npx skills add` conventions. */
export const skillSourceSchema = z.union([
  z.string(), // "./skills/*", "./skills/foo", "owner/repo", "https://github.com/o/r/tree/ref/path"
  z.strictObject({ repo: z.string(), skill: z.string().optional(), ref: z.string().optional() }),
]);
export type SkillSource = z.output<typeof skillSourceSchema>;

/**
 * A published rule pack this repository reviews against, named the way `--pack` names one.
 * `rules` keeps only the ids it lists, by exact id or glob (`nut11/*`), for a project that wants a
 * few checks from a large specification pack rather than all of it.
 */
export const packSourceSchema = z.union([
  z.string(), // "nuts-spec", "owner/repo/name", "owner/repo/name@v2"
  z.strictObject({ pack: z.string(), rules: z.array(z.string().min(1)).min(1).optional() }),
]);
export type PackSource = z.output<typeof packSourceSchema>;

/** The `--pack`-style spec of a configured pack, whichever shape the config used. */
export const packSpec = (src: PackSource): string => (typeof src === "string" ? src : src.pack);
/** The id patterns the config selected, or undefined for the whole pack. */
export const packSelection = (src: PackSource): string[] | undefined => (typeof src === "string" ? undefined : src.rules);

export const configSchema = z.strictObject({
  /** TypeSafe model id (direct provider). The gateway currently serves `typesafe-ai/jev` only. */
  model: z.string().default("jev-1.13.0"),
  /**
   * Omit to use what the machine is signed in with: TypeSafe directly when `TYPESAFE_API_KEY` is
   * set, SemIf when it alone is set up, otherwise the Gateway. Name one to hold every run to it.
   */
  provider: z.enum(["gateway", "typesafe", "semif"]).optional(),
  /**
   * What a repository fixes about `provider: "semif"`: which open model answers, and how it is
   * read. Which Python, which GPU and which checkpoint file are properties of a machine, not of a
   * repository, so they stay in `SEMIF_*` — which also overrides anything here, for a machine that
   * cannot run what the repository assumed.
   */
  semif: z.strictObject({
    /** Hugging Face id or local path. SemIf pins its published baseline; so does Hunch. */
    model: z.string().min(1).optional(),
    /** The 40-character commit SemIf requires for a remote model. */
    revision: z.string().min(1).optional(),
    /** `shared` prefills one hunk's state once and answers every rule against it. */
    mode: z.enum(["direct", "serial", "shared", "reranker"]).optional(),
    backend: z.enum(["torch", "mlx", "llamacpp"]).optional(),
    /** SemIf never truncates: a longer prompt fails its request rather than losing evidence. */
    maxTokens: z.number().int().min(256).max(1_000_000).optional(),
  }).default({}),
  zeroDataRetention: z.boolean().default(true),
  extends: z.array(z.string()).default([]),
  include: z.array(z.string()).default(["**/*"]),
  ignore: z.array(z.string()).default([]),
  unit: z.literal("hunk").default("hunk"),
  /** "pr" sends the PR title + body as `task`; "none" sends nothing. */
  task: z.enum(["pr", "none"]).default("pr"),
  /** Omit to use every installed skill; `[]` selects none. */
  skills: z.array(skillSourceSchema).optional(),
  /** Published rule packs to review against. `hunch install` copies their rules into hunch.lock. */
  packs: z.array(packSourceSchema).default([]),
  /** Compile root + nested AGENTS.md into rules. */
  agentsMd: z.boolean().default(true),
  /** Extra repo docs to compile into rules (e.g. a style guide AGENTS.md links to). */
  docs: z.array(z.string()).default([]),
  /** LLM used only by `hunch install --with gateway`. PR runs use Jev alone. */
  compileModel: z.string().default("anthropic/claude-sonnet-5"),
  /** Fail the check run when an `error` finding is reported. */
  failOnError: z.boolean().default(false),
  /** Source context and optional evidence localization; never a relevance prefilter. */
  review: z.strictObject({
    contextLines: z.number().int().min(0).max(200).default(40),
    chunkLines: z.number().int().min(1).max(2000).default(150),
    overlapLines: z.number().int().min(0).max(1999).default(0),
    localize: z.boolean().default(false),
    /**
     * `inferred` asks a compiled rule only where the compiler's `appliesTo` globs and `when` regex
     * match. `everywhere` asks every compiled rule of every reviewed chunk.
     */
    compiledScope: z.enum(["inferred", "everywhere"]).default("inferred"),
    localizationLines: z.number().int().min(1).max(100).default(10),
    maxLocalizationRequests: z.number().int().min(0).max(1000).default(32),
  }).refine(value => value.overlapLines < value.chunkLines, { message: "overlapLines must be less than chunkLines" })
    .default({ contextLines: 40, chunkLines: 150, overlapLines: 0, localize: false, compiledScope: "inferred", localizationLines: 10, maxLocalizationRequests: 32 }),
  budget: z
    .strictObject({
      // The ceilings admit a whole-repository audit with every rule asked of every chunk. The
      // hosted App applies its own, lower, caps.
      maxHunks: z.number().int().min(1).max(100_000).default(100),
      maxRulesPerHunk: z.number().int().min(1).max(1024).default(24),
      concurrency: z.number().int().min(1).max(32).default(4),
      /** Jev requests per run (one per hunk and reference, more when the rules need several). */
      maxRequests: z.number().int().min(1).max(1_000_000).default(100),
      /** Stop starting new requests after this long. */
      timeoutSeconds: z.number().int().min(10).max(86_400).default(180),
    })
    .default({ maxHunks: 100, maxRulesPerHunk: 24, concurrency: 4, maxRequests: 100, timeoutSeconds: 180 }),
  rules: z.record(z.string(), ruleEntrySchema).default({}),
  overrides: z
    .array(z.strictObject({ files: z.array(z.string()).min(1), rules: z.record(z.string(), ruleEntrySchema) }))
    .default([]),
});

export type ConfigInput = z.input<typeof configSchema>;
export type Config = Omit<z.output<typeof configSchema>, "rules"> & { rules: Record<string, RuleEntry> };

export function parseConfig(raw: unknown, origin: string): Config {
  const res = configSchema.safeParse(raw);
  if (!res.success) {
    const lines = res.error.issues.flatMap((i) => specific(i)).map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${origin} is invalid:\n${lines.join("\n")}`);
  }
  return res.data;
}

type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][]; expected?: string };

/**
 * A rule can be written four ways, so a mistake in one fails a union, and zod reports only
 * "Invalid input" for the whole rule. Reports the branch the author was evidently writing instead:
 * the one that got furthest before failing, rather than the shapes it was never meant to be.
 */
function specific(issue: Issue, prefix: PropertyKey[] = []): { path: PropertyKey[]; message: string }[] {
  const path = [...prefix, ...issue.path];
  if (issue.code !== "invalid_union" || !issue.errors?.length) return [{ path, message: issue.message }];
  // A wrong type at the top means "not this shape at all"; a wrong value of the right type (a
  // misspelt level) is closer; anything that got inside the value is closest.
  const rank = (i: Issue) => (i.path.length ? 1 + i.path.length : i.code === "invalid_type" ? 0 : i.code === "invalid_value" ? 0.5 : 1);
  const depth = (branch: Issue[]) => Math.min(...branch.map(rank));
  const best = issue.errors.reduce((a, b) => (depth(b) > depth(a) ? b : a));
  if (depth(best) === 0) return [{ path, message: issue.message }];
  return best.flatMap((i) => specific(i, path));
}

export class ConfigError extends Error {
  override name = "ConfigError";
}
