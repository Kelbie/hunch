import { choice, noul, score } from "./define.js";
import { type RuleEntry, ruleEntrySchema } from "./schema.js";

const r = (entry: unknown): RuleEntry => ruleEntrySchema.parse(entry) as RuleEntry;

/**
 * `hunch:recommended`: rules that hold for almost any codebase. Everything is
 * `warn` until you have calibrated it on your own PRs (`hunch eval`).
 * Project-specific rules (error-handling style, component variants) belong in
 * your own config; see examples/.
 */
const recommended: Record<string, RuleEntry> = {

  "entropy/off-task-change": r([
    "warn",
    score({
      instructions: "How closely is the change in `hunk` related to the change described in `task`?",
      criteria: [
        "Unrelated: it changes behaviour that `task` does not mention.",
        "Adjacent: a cleanup or refactor near the task that the task does not need.",
        "Required to do what `task` describes.",
      ],
      reportBelow: 0.25,
      minConfidence: 0.5,
    }),
  ]),

  "entropy/weakened-test": r([
    "warn",
    noul({
      instructions:
        "Does `hunk` change an existing test assertion so that it accepts more outcomes than before, " +
        "such as an exact value replaced by toBeDefined, toEqual replaced by toMatchObject, or assert_eq! replaced by assert!?",
      criteria: {
        true: "A removed assertion line is replaced by a looser one that checks less.",
        false: "Assertions are unchanged, stricter, or only newly added.",
      },
      when: /expect|assert|should|toBe|toEqual/,
      threshold: 0.75,
    }),
  ]),

  "entropy/stale-comment": r([
    "warn",
    noul({
      instructions: "Does a comment in `hunk` describe behaviour that the code in `hunk` does not do?",
      when: /\/\/|\/\*|#|"""/,
      threshold: 0.8,
    }),
  ]),

  "style/name-matches-behaviour": r([
    "warn",
    noul({
      instructions: "Does the name of a function added in `hunk` describe something different from what its body does?",
      when: /function |=>|fn |def |func /,
      threshold: 0.8,
    }),
  ]),

  "style/comment-purpose": r([
    "warn",
    choice({
      instructions: "What does the comment added in `hunk` mainly do?",
      criteria: {
        why: "Explains why the code is written this way, or documents an API.",
        restates: "Repeats what the next line of code already says.",
        none: "No comment was added.",
      },
      report: ["restates"],
      when: /^\+.*(\/\/|\/\*|#)/m,
      minConfidence: 0.75,
    }),
  ]),
};

export const presets: Record<string, Record<string, RuleEntry>> = {
  "hunch:recommended": recommended,
};
