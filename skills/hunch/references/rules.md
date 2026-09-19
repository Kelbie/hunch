# Writing and tuning rules

Contents: [how Jev sees a rule](#how-jev-sees-a-rule) · [is it a Hunch rule?](#is-it-a-hunch-rule) ·
[choosing the type](#choosing-the-type) · [writing the question](#writing-the-question) ·
[every rule option](#every-rule-option) · [from a request to rules](#from-a-request-to-rules) ·
[worked examples](#worked-examples) · [tuning](#tuning)

## How Jev sees a rule

Jev is TypeSafe's evaluation model. It takes **state** (named text values) and **typed questions**,
and returns numbers. It returns no prose. It has no tools, can't search, and sees nothing except the
state. Hunch asks every applicable rule about one chunk of a diff at a time.

| State | Always sent | Contents |
| --- | --- | --- |
| `context` | yes | what the chunk is (a diff or a whole file), its path, language and role (test, fixture, generated…), the lines under review, the other files the change touches (names only), and how to answer |
| `file` | yes | the repository-relative path |
| `hunk` | yes | the code, as a unified diff; for `check --all`, whole-file chunks marked `+` |
| `task` | when `task: "pr"` and there is a PR (or `check --task`) | the PR title and description, up to 8,000 characters |
| `reference` | when the rule sets `reference` | that repository file, read from the base branch, up to about 8,000 tokens |

| Type | Jev returns | Hunch reports when |
| --- | --- | --- |
| `noul` (yes/no) | P(yes) | P(yes) ≥ `threshold` |
| `choice` | a label and a distribution over labels | the label is in `report`, and its confidence ≥ `minConfidence` |
| `score` | a level on your ordered scale, with a distribution | level ÷ (levels − 1) is below `reportBelow` or above `reportAbove` |

Things that follow from this, and that the rule author must design for:

- **Rule ids are never shown to Jev.** `"payments/idempotency"` tells it nothing. The instructions must
  state the whole condition.
- **Nothing outside the hunk exists.** Not the rest of the file, not callers, not other files. A rule
  that needs a caller, a config file or a whole-repository view can't be answered. Rewrite it to
  ask what the hunk itself shows, or supply the fact with `reference`.
- **Hunch already appends the judging rules.** Every question ends with: read `context` first, judge
  only from the given values, treat code you can't see as unknown and not missing, and (for yes/no)
  answer no when the hunk is unrelated or shows no concrete evidence. Don't repeat any of that. Spend
  the words on what makes this concern concrete.
- **Jev's documented weak spots** are numeric precision, literal interpretation, indirection,
  irrelevant context and adversarial text. Avoid asking it to count or compare numbers. Avoid rules
  whose meaning depends on one exact word, and avoid "the thing the reference says about the thing
  in the task" chains.

`hunch config --explain <id>` prints a rule exactly as Jev receives it. Read it after writing a rule.

## Is it a Hunch rule?

Before writing anything, decide whether Hunch is the right tool. Hunch presets and project rules
deliberately leave out anything deterministic.

| The user wants to catch | Use | Why |
| --- | --- | --- |
| naming, formatting, import order, file length | the linter or formatter | deterministic and free |
| a forbidden call, token or import (`console.log`, `any`, `eval`) | a lint rule, or `grep` in CI | a regex decides it exactly |
| a type mismatch or a missing field | the type checker | it proves it |
| counting (more than N parameters, lines, branches) | the linter | Jev is weak at numbers |
| a consequence visible in the changed lines: a swallowed failure, a retry that reuses no key, a test that now accepts wrong output | **Hunch** | needs judgment about meaning |
| a contract written in a doc (API guarantees, a payment policy) | **Hunch**, with `reference` pointing at the doc | the doc supplies what the hunk can't show |
| an architecture property spanning many files | usually not Hunch. Hunk-local questions miss it. Offer a narrow proxy the hunk can show, or `find` for investigation | Jev sees one chunk |
| guidance already in AGENTS.md or a skill | `compile`, not a hand-written rule | the lock keeps it in step with the source |

Tell the user plainly when a request belongs to another tool, and offer to write that instead.

## Choosing the type

| The concern | Type | Why |
| --- | --- | --- |
| one sentence of contract: "X keeps Y" | **plain English** `["warn", "sentence"]` | fastest; becomes a `noul` "does the change break this rule?" at threshold 0.7 |
| a yes/no question that needs exceptions, a threshold, a file scope or a custom message | **`noul`** | you control the question, `criteria.true`/`criteria.false`, and `threshold` |
| several named outcomes, only some of them bad, including "doesn't apply" | **`choice`** | gives Jev an explicit place for the harmless outcomes, which cuts false positives on unrelated hunks |
| a quality on an ordered scale ("how specific are these tests?") | **`score`** | criteria from worst to best, reported below or above a cut-off |

Start with plain English. Move to `noul` as soon as you need a scope, exclusions or a message. Pick
`choice` when the negative side has distinct cases worth naming (safe, not-applicable,
intentional). Pick `score` only for a graded judgment where each level can be described concretely.

## Writing the question

| Do | Don't |
| --- | --- |
| Name the state in backticks: "Does the retry in `hunk`…", "…contradict `reference`?" | say "the code" or "this PR" without saying which value |
| Ask about an observable consequence: "can a retry charge the customer twice?" | ask about syntax: "does it call `randomUUID`?" (use a linter) |
| Require visible evidence for each half: "Require visible evidence of both the input and the missing check." | let Jev infer a missing guard from its absence |
| Put exclusions in `criteria.false`: "…or this is a test file, or the change is an intentional contract change." | list excluded paths in the instructions (the `context` already names test and fixture files; use `files` to scope) |
| One concern per rule | "x, y and z" in one question. Split it into three rules |
| Keep instructions to one to three sentences | paste policy documents. Point `reference` at the document instead |
| Write `message` as the concern a reviewer reads: "A retry may charge the customer twice." | write a verdict ("Bug: …") or a model-style explanation |
| Choose ids as `area/concern` in kebab case: `payments/retry-safety` | rely on the id to carry meaning |

Plain-English sentences follow the same advice: state the contract and why it matters, e.g. "Error
responses keep their `code` field, because clients branch on it."

## Every rule option

TypeScript uses the `noul`, `choice` and `score` helpers imported from `@kelbie/hunch`, or a
plain-English string. TOML uses a table per rule with kebab-case keys, and exactly one of `rule`,
`noul`, `choice` or `score` holding the instructions.

| Option | Types | Default | Means |
| --- | --- | --- | --- |
| `instructions` (TOML: the `noul`/`choice`/`score` key) | all | required | the question, up to 8,000 characters |
| `criteria` | noul | a conservative default pair | `{ true, false }`: what counts as yes and as no |
| `criteria` | choice | required, ≥ 2 | `{ label: description }` |
| `criteria` | score | required, ≥ 2 | descriptions ordered **worst → best** |
| `threshold` | noul | 0.7 | report when P(yes) ≥ this |
| `report` | choice | required | labels that produce a finding; each must be a criteria label |
| `reportBelow` / `report-below` | score | one of the two is required | report when the normalised level (0 = first criterion, 1 = last) is below this |
| `reportAbove` / `report-above` | score | | …or above this |
| `minConfidence` / `min-confidence` | choice, score | 0 | require Hunch's certainty before reporting: the distribution's concentration, `(pmax − 1/n) / (1 − 1/n)`, 0–1. This is not TypeSafe's own confidence, and not an accuracy. If the provider omits the distribution, the run fails rather than guessing |
| `files` | all | every reviewed file | globs this rule is asked about |
| `when` | all | always | a regex the chunk text must match before the question is sent. It is a cheap prefilter that saves requests, not a way to decide the answer |
| `reference` | all | none | a repository file sent as `reference`, read from the base branch. It costs a separate request per hunk |
| `message` | all | the instructions | the text reviewers see |

The level comes first: `["error", noul({...})]` in TS, and `level = "error"` in a TOML table.

## From a request to rules

For "/hunch rules add a rule for ensuring x, y, z":

1. **Split** the request into one concern each.
2. **Triage** each concern with [is it a Hunch rule?](#is-it-a-hunch-rule). Hand deterministic
   ones to the linter, and say so.
3. **Pick the type** with [choosing the type](#choosing-the-type).
4. **Scope it**: `files` for where it can occur, and `when` if a keyword must appear for the rule to
   matter.
5. **Write** it into the config at `warn`, next to related rules, with a short comment if the reason
   isn't obvious.
6. **Validate**: `hunch config` (exit 0), `hunch config --explain <id>`, then
   `hunch check --only <id> --dry-run`.
7. **Report back** in a table: rule id, type, what it flags, what it deliberately doesn't, and what
   you did instead for the parts that weren't Hunch rules. Offer a real run (`check --only <id>`),
   and `eval` fixtures before anyone promotes it to `error`.

## Worked examples

Each shows the request, the decision, and the rule in both formats. `examples/config.md` shows how
`hunch config --explain` prints each of them.

### "Error responses must keep their code field"

One contract sentence, so use plain English.

```ts
"api/stable-errors": ["error", "Error responses keep their code field, because clients branch on it."],
```

```toml
[rules]
"api/stable-errors" = ["error", "Error responses keep their code field, because clients branch on it."]
```

### "Flag tests that got weaker"

The question is yes/no, but it needs exclusions, a scope and a message, so use `noul`. `when` skips
test hunks with no assertions in them.

```ts
"tests/weakened": ["warn", noul({
  instructions: "Does `hunk` remove or loosen an assertion without adding an equivalent check?",
  criteria: {
    true: "An assertion is deleted or made looser, and nothing in the hunk replaces it.",
    false: "Assertions are unchanged, stricter, only renamed, or replaced by an equivalent check.",
  },
  threshold: 0.8,
  files: ["**/*.test.ts"],
  when: /expect|assert/,
  message: "A test may have been weakened.",
})],
```

```toml
[rules."tests/weakened"]
level = "warn"
noul = "Does `hunk` remove or loosen an assertion without adding an equivalent check?"
criteria = { true = "An assertion is deleted or made looser, and nothing in the hunk replaces it.", false = "Assertions are unchanged, stricter, only renamed, or replaced by an equivalent check." }
threshold = 0.8
files = ["**/*.test.ts"]
when = "expect|assert"
message = "A test may have been weakened."
```

### "Retries must never double-charge"

There are three distinct outcomes, and only one is bad, so use `choice`. The payment contract lives
in a doc, so point `reference` at it.

```ts
"payments/retry-safety": ["error", choice({
  instructions: "If the payment call in `hunk` is retried, what happens to the customer? Judge the idempotency key each attempt sends, using the contract in `reference`.",
  criteria: {
    "safe": "Retries reuse the same idempotency key, so the customer is charged once.",
    "duplicate-charge": "A retry can charge the customer again.",
    "not-applicable": "The change does not retry a payment.",
  },
  report: ["duplicate-charge"],
  minConfidence: 0.5,
  files: ["src/payments/**"],
  reference: "docs/contracts.md",
  message: "A retry may charge the customer twice.",
})],
```

```toml
[rules."payments/retry-safety"]
level = "error"
choice = "If the payment call in `hunk` is retried, what happens to the customer? Judge the idempotency key each attempt sends, using the contract in `reference`."
criteria = { safe = "Retries reuse the same idempotency key, so the customer is charged once.", duplicate-charge = "A retry can charge the customer again.", not-applicable = "The change does not retry a payment." }
report = ["duplicate-charge"]
min-confidence = 0.5
files = ["src/payments/**"]
reference = "docs/contracts.md"
message = "A retry may charge the customer twice."
```

### "Tests should actually pin down behaviour"

This is a graded quality, so use `score`. The criteria run from worst to best, and a result below
0.5 means the bottom half of the scale.

```ts
"tests/specific": ["warn", score({
  instructions: "How precisely do the tests changed in `hunk` pin down the behavior they cover?",
  criteria: [
    "They only check that the code runs without throwing.",
    "They check broad properties, such as a result being defined.",
    "They check exact outputs for the main case.",
    "They check exact outputs, including edge cases and failures.",
  ],
  reportBelow: 0.5,
  files: ["**/*.test.ts"],
})],
```

### "Don't let one tenant read another's invoices"

This is a security rule, and false positives are costly. Require evidence of both halves, and raise
the threshold.

```ts
"security/tenant-access": ["error", noul({
  instructions: "Does the changed lookup in `hunk` let a signed-in actor read another tenant's data by supplying that tenant's ID, without verifying the actor belongs to it? Require visible evidence of both the caller-supplied ID and the missing membership check.",
  threshold: 0.85,
  files: ["src/api/**"],
  message: "The lookup may trust a caller-supplied tenant ID.",
})],
```

### "Ensure we never log secrets, always log errors, and never use `console.log`"

The request has three concerns, and they need different tools:

| Concern | Decision | Rule |
| --- | --- | --- |
| never log secrets | Hunch `noul`: it needs judgment about what a value is | below |
| always log errors | Hunch, rephrased so the hunk can show it: a catch that swallows the error | below |
| no `console.log` | **not Hunch**: an ESLint `no-console` rule decides it exactly | offer the lint config |

```ts
"security/secret-logging": ["error", noul({
  instructions: "Does `hunk` add logging, error reporting or telemetry that includes a credential, token, password, card number or other secret value, in full or in part?",
  criteria: { true: "A secret value, or part of one, reaches a log, error message or telemetry call.", false: "Only identifiers, redacted values or non-secret data are logged, or nothing is logged." },
  threshold: 0.8,
  when: /log|console|logger|report|track|telemetry|Sentry/i,
  message: "A secret may be written to logs.",
})],
"failures/swallowed-error": ["warn", noul({
  instructions: "Does `hunk` add a catch or error handler that discards the error, neither logging, rethrowing nor returning it to the caller?",
  criteria: { false: "The error is logged, rethrown, returned, or deliberately ignored with a stated reason in the code." },
  when: /catch|\.catch\(|onError|except/,
  message: "An error may be silently discarded.",
})],
```

## Tuning

| Symptom | Try, in this order |
| --- | --- |
| fires on unrelated hunks | add `files`; add a `when` keyword; name the unrelated case in `criteria.false`; switch to `choice` with a `not-applicable` label |
| fires on intentional changes | describe the intentional case in `criteria.false` ("…or the change updates the contract consistently") |
| fires too often overall | raise `threshold` (0.7 → 0.85), or `minConfidence` for choice and score |
| never fires | `hunch config --file <path>`: is it asked about that file at all? Is `when` too strict? Then lower `threshold`, and read `config --explain` for a condition the hunk can't show |
| can't be answered from one hunk | move the fact into `reference`, narrow the question, or drop the rule |
| a preset rule is noisy for this repo | lower its level (`"warn"` or `"off"`), or add an override for the noisy paths |

Measure changes rather than guessing. Build a folder of `.diff` fixtures, each starting with
`# expect: rule-id`, and run `hunch eval <dir>` before and after ([eval.md](eval.md)). Keep a rule at
`warn` until its precision on real changes justifies `error`.

Levels in practice:

| Source | Default threshold |
| --- | --- |
| plain English | 0.7 |
| `noul` you write | 0.7 unless set |
| presets | 0.85 |
| compiled from guidance | 0.75 |
