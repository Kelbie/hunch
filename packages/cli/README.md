# Hunch 🔮

Code review for the mistakes type checkers and linters miss. You write rules in plain English, and
[Jev](https://docs.typesafe.ai) checks your code against them — locally, or on every pull request.

![Hunch reviewing a branch with check --all](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/check-all.png)

## Try it on a repository that has never heard of Hunch

No config, no install, no setup. Describe a rule on the command line and review the branch you are on:

![Reviewing a branch with two rules passed on the command line](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/check-rules.png)

`--rule id="sentence"` adds one rule for this run. `--config` takes the same options as a config file
as JSON — inline, a file path, or `-` for stdin — and both are repeatable, so you can keep a
`rules.json` in a gist and point at it:

```sh
npx @kelbie/hunch check --config rules.json                    # a file
npx @kelbie/hunch check --config '{"failOnError":true}'        # inline, layered on top
cat rules.json | npx @kelbie/hunch check --config -            # stdin
```

## Examples

| You have | You want | Run |
| --- | --- | --- |
| no Hunch config | review this branch | `hunch check --rule id="…"` |
| no Hunch config | review a pull request branch | `hunch check --base main --rule id="…"` |
| rules in a JSON file | either of the above | `hunch check --config rules.json` |
| `hunch.config.ts` in the repo | review this branch | `hunch check` |
| `hunch.config.ts` in the repo | review a pull request branch | `hunch check --base origin/main` |
| `hunch.config.ts` in the repo | review whole files, not just changes | `hunch check --all src` |
| a repo and an idea | set Hunch up | `hunch init` |
| skills or `AGENTS.md` | turn them into rules | `hunch compile` |
| a PR with no review on it | find out why | `hunch doctor` |
| a change to make | find the code it touches | `hunch find "…"` |

Add `--dry-run` to any `check` or `find` to see what it would send, and spend nothing. Every command
takes `--help`, and lists its own flags and examples.

## Install

**Node 22+.** The GitHub App path needs nothing else. Two extras, only where a step says so:

- a **model key** — [Vercel AI Gateway](https://vercel.com/ai-gateway) → **API Keys → Create key** —
  to review on your own machine or in your own CI. The hosted App brings its own.
- **[Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex/cli/)**
  on your PATH, only to compile Agent Skills and `AGENTS.md` into rules. A model key works instead.

`npx @kelbie/hunch init` asks these questions interactively and does the rest. The three paths:

### 1. Every PR, via the GitHub App — no key, no workflow, no server

1. Install it on the repositories you want reviewed:
   <https://github.com/apps/hunch-review/installations/new>
2. `npx @kelbie/hunch init`
3. Only if the repo has Agent Skills or `AGENTS.md`: `npx @kelbie/hunch compile`
4. Commit to your **default branch** — Hunch reads its rules from the base branch, so nothing is
   reviewed until this is merged:
   ```sh
   git add hunch.config.ts   # and hunch.lock, if you ran compile
   git commit -m "Review PRs with Hunch"
   git push
   ```
5. Open a PR. The PR that adds Hunch is skipped with a notice — that is expected. Comment
   `/hunch recheck` for a fresh look.

No review? `npx @kelbie/hunch doctor` names the one thing that is missing.

### 2. On your machine

```sh
npx @kelbie/hunch init
export AI_GATEWAY_API_KEY=…
npx @kelbie/hunch check
```

### 3. Every PR, via GitHub Actions — your CI, your key, no App

```sh
npx @kelbie/hunch init --github
gh secret set AI_GATEWAY_API_KEY
```

Commit and merge `hunch.config.ts` **and** `.github/workflows/hunch.yml` to your default branch. The
review appears under **Checks → Hunch**. Fork PRs are not reviewed on this path — Actions withholds
secrets from forks — so use the App for those.

## Commands

| Command | What it does |
| --- | --- |
| `check` | Reviews the lines this branch changed, against your rules. |
| `check --all [path]` | Reviews whole files, not just changes. |
| `find "<task>"` | Finds the code a change would touch, anywhere in the repo, and prints it. |
| `compile` | Turns your skills and `AGENTS.md` into review questions, saved in `hunch.lock`. |
| `init` | Writes a config, and optionally a PR workflow. |
| `doctor` | Says why this repository is not being reviewed, and what to do about it. |
| `eval <dir>` | Measures each rule's precision and recall on labelled `.diff` examples. |
| `app register` / `app connect` | Sets up your own deployment of the GitHub App. |

Run any of them as `npx @kelbie/hunch <command>`. `hunch <command> --help` lists that command's flags
and shows worked examples; flags mean the same thing wherever they appear.

| Flag | On | Means |
| --- | --- | --- |
| `--base <ref>` / `--head <ref>` | `check`, `find` | What to compare against, or which ref to read. |
| `--reporter <format>` | `check`, `find` | `text`, `markdown`, `json`, and for `check` also `sarif` and `github`. |
| `--code` / `--no-code` | `check`, `find` | Print the source under each result. `check` does not by default; `find` does. |
| `--dry-run` | `check`, `find` | Count what would be sent. Nothing is sent, nothing is charged. |
| `--config` / `--rule` | `check`, `eval` | Rules without a config file. Repeatable; later values win. |
| `--cwd <dir>` | all | Run as if started in that directory. |

## Finding the code for a change

`check` asks whether code is wrong. `find` asks **where the code is**: it scores every chunk of the
repository against a change you are about to make, and prints the matching source.

![hunch find ranking a repository against a task, and checking open PRs for the same work](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/find.png)

Each chunk is asked five questions at once, because "show me the tests" and "show me where to type"
are different requests that one relevance score would blur together:

| Facet | Question asked of every chunk |
| --- | --- |
| `edit` | Would carrying out the task require editing these lines? |
| `contract` | Does this define the value, limit or type the task hinges on? |
| `caller` | Does this consume the behaviour that would change? |
| `test` | Does this test the area, so it would need updating or would catch a mistake? |
| `precedent` | Does this already solve the same kind of problem somewhere else? |

Matches group by their strongest facet, and `--top` applies **per facet**, so the one test worth
updating is not crowded out by thirty definitions. At a terminal you get the coloured report above;
redirect it and you get Markdown, because the reason to redirect it is to hand it to a coding agent:

```sh
hunch find "add a rate limit to the upload endpoint" > context.md
hunch find "…" --prs          # also: is an open PR already doing this?
hunch find "…" --dry-run      # what would this cost?
```

**What to trust.** Scores are probabilities from a classifier that saw one chunk in isolation, with
no view of callers or the rest of the file. Treat the grouping as the signal and verify before
relying on it. Relevant code can be missing. A sweep that was cut short says so and exits `2`.

## Rules

Rules live in `hunch.config.ts` or `hunch.toml`. Each has a level: `"warn"`, `"error"` or `"off"`.
This example shows every kind of setting; you only need `extends` and a few rules to start.

```ts
import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  // Ready-made checks. Change or turn off any of them under `rules`.
  extends: ["hunch:recommended", "hunch:typescript"],

  // Which files are reviewed. Lockfiles, minified files and node_modules are always skipped.
  include: ["src/**"],
  ignore: ["src/generated/**"],

  rules: {
    // Plain English: flagged when a change likely breaks the sentence.
    "api/stable-errors": ["warn", "Changing an error returned to API clients must not remove information they rely on to recover."],

    // noul: a yes/no question, flagged when P(yes) >= threshold.
    "tests/weakened": ["error", noul({
      instructions: "Does `hunk` remove or loosen an assertion without adding an equivalent check?",
      criteria: { true: "An assertion is deleted or made looser.", false: "Assertions are unchanged, stricter or only renamed." },
      threshold: 0.8,
      files: ["**/*.test.ts"],            // only ask about these files
      when: /expect|assert/,              // only ask when the change matches (saves requests)
      message: "A test may have been weakened.",  // what reviewers see
    })],

    // choice: Jev picks one label; labels listed in `report` are flagged.
    "payments/retry-safety": ["error", choice({
      instructions: "If the payment call in `hunk` is retried, what happens to the customer?",
      criteria: {
        "safe": "Retries reuse the same idempotency key, so the customer is charged once.",
        "duplicate-charge": "A retry can charge the customer again.",
        "not-applicable": "The change does not retry a payment.",
      },
      report: ["duplicate-charge"],
      minConfidence: 0.5,
      reference: "docs/api-contracts.md",  // a file from the base branch sent along as context
    })],

    // score: ordered levels, worst to best; flagged below reportBelow (0–1).
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

    // Change a preset's level, or turn it off.
    "docs/contradictory-comment": "error",
    "typescript/lossy-serialization": "off",
  },

  // Different levels for some folders.
  overrides: [{ files: ["scripts/**"], rules: { "api/stable-errors": "off" } }],

  // Guidance to compile into hunch.lock (see "Skills and AGENTS.md").
  skills: ["./.agents/skills/codebase-design", "mattpocock/skills"],  // omit to use every installed skill; [] for none
  agentsMd: true,
  docs: ["docs/api-contracts.md"],

  failOnError: true,       // fail the check when an error-level concern is found
  task: "pr",              // send the PR title and description as context ("none" to skip)
  zeroDataRetention: true, // set false on Vercel Hobby
  budget: { maxHunks: 100, maxRequests: 100, timeoutSeconds: 180 },
});
```

| Rule type | Flags a change when… |
| --- | --- |
| Plain English | Jev thinks the change likely breaks the sentence. |
| `noul` | The answer to your yes/no question is likely "yes". |
| `choice` | Jev picks one of the labels you listed in `report`. |
| `score` | The change scores below (or above) your threshold on a scale you define. |

Every rule type also takes `files`, `when`, `reference` and `message`. In `hunch.toml` the same rules
are tables, with kebab-case option names:

```toml
extends = ["hunch:recommended", "hunch:rust"]
fail-on-error = true

[rules."payments/retry-safety"]
level = "error"
choice = "If the payment call in `hunk` is retried, what happens to the customer?"
criteria = { safe = "...", duplicate-charge = "...", not-applicable = "..." }
report = ["duplicate-charge"]
```

Presets: `hunch:recommended` (any language), `hunch:typescript`, `hunch:rust`. Every option, and what
each question is given, is explained in [configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md).

## Skills and AGENTS.md

Your [Agent Skills](https://github.com/vercel-labs/skills) and `AGENTS.md` usually contain good review
rules — but as long prose written for coding agents, and **Jev only answers short yes/no questions**.
`hunch compile` converts them once, with a coding agent or a model key, and writes the result to
`hunch.lock`:

```sh
npx @kelbie/hunch compile        # asks which installed agent to use
```

Read `hunch.lock` before committing it: it is the policy that will review your PRs, and the compiler
can lose nuance. Guidance it cannot check one change at a time is recorded there too, and reported as
a limitation rather than silently dropped. Normal reviews never fetch remote skills; run `compile`
deliberately to update them.

## On pull requests

- **Not relevant?** Resolve the conversation. Hunch won't raise that rule in that file again on this
  PR. Only resolutions by people with write access count.
- **Fixed it?** Push. Hunch resolves its own comments for concerns that are gone.
- **Want a fresh look?** Comment `/hunch recheck`.

## Good to know

Findings are model judgments, not proven bugs — treat them as a second reader, not a gate, until you
have tuned your rules with `hunch eval`. Coverage that was incomplete is always reported, never
hidden. Your code is sent to the model provider you configure; no key is ever written into your
config.

## More

[Configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md) · [Architecture](https://github.com/Kelbie/hunch/blob/main/docs/architecture.md) ·
[Run your own App](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md) · [Deploy](https://github.com/Kelbie/hunch/blob/main/docs/deploy.md) · [Sample report](https://github.com/Kelbie/hunch/blob/main/docs/sample-report.md)
