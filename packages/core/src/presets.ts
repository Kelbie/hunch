import { noul } from "./define.js";
import { type RuleEntry, ruleEntrySchema } from "./schema.js";

/** Presets ask about observable consequences, never syntax or a preferred style. */
const concern = (instructions: string, message: string, files?: string[]): RuleEntry =>
  ruleEntrySchema.parse(["warn", noul({
    instructions: `${instructions} Judge only behavior introduced or changed in \`hunk\`, using the visible before/after code and any stated contract. Do not invent missing callers or requirements.`,
    criteria: {
      true: "The visible change provides concrete evidence of this problem.",
      false: "The concern is absent, the change is intentional and consistent with the visible contract, or there is not enough evidence.",
    },
    message,
    threshold: 0.85,
    ...(files ? { files } : {}),
  })]);

const recommended: Record<string, RuleEntry> = {
  "failures/misleading-success": concern(
    "Does the change turn a failed operation into a result or state that the caller will interpret as successful completion? Exclude explicitly supported fallbacks and best-effort operations whose failure is allowed by the visible contract.",
    "A failed operation may now be reported as successful completion.",
  ),
  "correctness/edge-case-regression": concern(
    "Does the change break a previously supported empty, missing, zero, or boundary-value case? Require evidence in the removed behavior, a visible caller, or an explicit contract that this case must remain supported. Do not flag an intentional contract change consistently implemented in the visible code.",
    "A previously supported edge case may no longer behave correctly.",
  ),
  "tests/weakened-test": concern(
    "Does an edited test stop detecting a specific incorrect behavior that it previously rejected, while that behavior remains incorrect under the visible contract? Judge the behavior still tested, not the assertion method name. Exclude equivalent assertions, replacement coverage visible in the hunk, and tests updated for an intentional contract change.",
    "An edited test may now accept behavior it is still meant to reject.",
  ),
  "docs/contradictory-comment": concern(
    "Does a code or comment change leave a factual comment or API description in the hunk contradicting the implementation visible there? Do not judge prose style or demand extra comments.",
    "A comment or API description may contradict the changed behavior.",
  ),
};

const typescript: Record<string, RuleEntry> = {
  "typescript/async-ordering": concern(
    "Does changed JavaScript or TypeScript asynchronous code allow a concrete stale result, duplicate side effect, or out-of-order state update? Identify the overlapping operations and incorrect outcome in the visible code. Merely finding an unawaited promise, async callback, or missing cancellation is insufficient.",
    "Overlapping asynchronous operations may publish stale state or repeat a side effect.",
    ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  ),
  "typescript/lossy-serialization": concern(
    "Does changed JavaScript or TypeScript conversion between runtime values and serialized or persisted data lose meaning that a visible consumer requires, such as Date/timezone meaning, Map/Set entries, or the distinction between absent and null? Require both the changed conversion and evidence of the affected contract. Do not flag serialization or type assertions by themselves.",
    "A data conversion may discard meaning that its consumer relies on.",
    ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  ),
};

const rust: Record<string, RuleEntry> = {
  "rust/panic-on-recoverable-input": concern(
    "Does changed Rust code introduce a reachable panic for an ordinary malformed external input or recoverable runtime failure that the visible caller contract expects to receive as an error? Show why the panic is reachable from that input. Do not flag unwrap/expect/panic syntax alone, proven internal invariants, tests, or intentional fail-fast startup behavior.",
    "A recoverable input or runtime failure may now panic instead of reaching the caller as an error.",
    ["**/*.rs"],
  ),
  "rust/error-context": concern(
    "Does a changed Rust error conversion merge distinct failures whose differences a visible caller or documented recovery path needs for retry, recovery, or user action? Require evidence of the distinction and its consumer. Do not enforce any error library, forbid the ? operator, or require context on every conversion.",
    "An error conversion may erase a distinction needed for recovery.",
    ["**/*.rs"],
  ),
};

/** Language presets are additive; select recommended alongside them. */
export const presets: Record<string, Record<string, RuleEntry>> = {
  "hunch:recommended": recommended,
  "hunch:typescript": typescript,
  "hunch:rust": rust,
};
