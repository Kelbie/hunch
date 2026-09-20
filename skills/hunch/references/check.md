# hunch check

Reviews changed lines, or whole files, against the rules. Real output:
[examples/check.md](../examples/check.md). Every flag: [cli.md](cli.md#hunch-check).

## What to review

| The user wants | Command |
| --- | --- |
| this branch against `origin/main` | `check` |
| against another base | `check --base main` (a local branch) or `--base origin/develop` |
| only what is staged | `check --staged` |
| one branch against another, without checking it out | `check --base main --head feature/x` |
| a saved diff | `check --diff change.diff` |
| whole files, not a diff | `check --all [paths…]`, or `--all --head <ref>` for a branch |
| only some paths | add them as arguments: `check src/payments` |
| one or two rules | `--only payments/retry-safety,tests/weakened` |
| rules without a config file | `--rule id="sentence"` (repeatable), or `--config rules.json` / `--config '{…}'` / `--config -` |
| context for the questions | `--task "what the change is for"`. In Actions it comes from the PR automatically |

`--diff`, `--staged` and `--head` are mutually exclusive. `--all` refuses `--base`, `--diff` and
`--staged`. A `--config` replaces the repository's config file, and `--rule` adds to whichever config
applies. An inline config selects no skills or AGENTS.md unless it asks for them.

## Context and precise locations

`review` settings in [config.md](config.md#review-context) apply equally to Actions, the App and
local checks. Every question receives the window, its role, supplied task and optional trusted
reference. Diff checks can include surrounding source from the exact reviewed revision. This
helps distinguish a changed defect from an existing guard or unrelated nearby defect.

Opt-in localization narrows positive findings after baseline coverage finishes. It retains full
context and falls back to the broader finding when attribution is uncertain. Treat the indicated
range as evidence to inspect, not an exact causal proof. Actions annotations and App inline threads
use these ranges; summaries link to the reviewed head SHA. A new location gets its own thread
even if the same concern already has a thread elsewhere in the file.

## Dry runs

Reviews are cheap (see [cost](../SKILL.md#cost)), so just run `check`. `--dry-run` is for when the
user wants to see scope: it prints files, hunks, questions and requests, and sends nothing. It also
warns on stderr when `hunch.lock` is missing or stale, because the real run would then be incomplete:

```text
hunch: dry run, nothing sent. 2 file(s) as 2 hunk(s): 15 question(s) in 2 request(s). Budget: 100 hunks, 100 requests, 180s.
```

The dry run counts baseline requests; optional localization uses the remaining budget.

A request carries every question for one hunk, plus one more request per distinct `reference`. What
matters on a large branch is `budget.maxRequests`, not money: anything past the budget is skipped
and the review is marked partial. Raise the budget rather than accept a partial review.

Credentials are needed only when something is actually sent, so `--dry-run` works without them.
An authentication error means this machine has not signed in: see
[Model access](install.md#model-access) (`auth login`, once, for every directory).

## Reading the result

| `--reporter` | For | Notes |
| --- | --- | --- |
| `text` (default) | a person at a terminal | findings grouped by file, each with its rule, level, lines and score; `--code` adds the changed lines |
| `json` | you | the full result; parse this rather than the text |
| `markdown` | a PR comment or a file | the same summary the App posts |
| `sarif` | code-scanning upload | findings only |
| `github` | Actions | workflow annotations and a job summary; the default when `GITHUB_ACTIONS` is set |

JSON shape (`CheckResult` in `packages/core/src/check.ts`):

```ts
{
  findings: {
    rule: string;             // e.g. "payments/retry-safety"
    level: "warn" | "error";
    file: string; line: number; endLine: number;
    message: string;          // the rule's message
    evidence: string;         // why it fired: "p(yes)=0.91 ≥ 0.8", "choice=duplicate-charge (confidence 0.82)", "score 0.33 < 0.5: …"
    source: string;           // "config", "hunch:recommended", "skill/<name>", "agents-md/<scope>"
    diff?: string;            // with --code
  }[];
  stats: { hunks: number; skippedHunks: number; requests: number; questions: number; inputTokens: number; modelIds: string[] };
  notices: string[];          // gaps in this review: anything here means something wasn't checked
  info: string[];             // standing facts about the policy, e.g. guidance the lock can't check
  complete: boolean;
}
```

How to report it to the user:

1. Lead with completeness. If `complete` is false or the exit code is 2, say what was skipped: read
   every notice.
2. Group findings by file. For each, give the message, the rule id, the level and the evidence. Call
   it a flag or a concern, not a bug.
3. For each finding you are asked to act on, open the lines and judge for yourself before changing
   anything.
4. If a rule seems wrong for this code, suggest tuning it ([rules.md](rules.md#tuning)) rather than
   rewriting the code to satisfy it.

## Exit codes

| Code | When |
| --- | --- |
| 0 | the review completed, whether or not there are findings |
| 1 | `failOnError` is true and an `error`-level finding was reported |
| 2 | no config and no `--rule`/`--config`; an invalid config; an unknown `--only` id; or the review is incomplete (budget reached, provider failure, stale `hunch.lock`, deleted, binary or rename-only files) |

On the PR that adds Hunch, run in Actions with `--policy-ref`, there is no base config yet, so check
prints a notice and exits 0.

## Common errors

| stderr | Fix |
| --- | --- |
| `no hunch.config.ts or hunch.toml found` | `init`, or pass `--rule`/`--config` |
| `--base origin/main is not a commit in this repository` | no `origin` remote, or it isn't fetched: pass `--base main` (or the branch you started from), or `git fetch origin` |
| `--only: no rule …` | `hunch config` lists the ids |
| `hunch.lock is stale for: …` (a notice) | `compile`, then commit `hunch.lock` |
| a provider error mentioning zero data retention | the account can't enforce ZDR; the user decides about `zeroDataRetention: false` |
| `Review request/time budget reached` | raise `budget` or narrow the paths |
