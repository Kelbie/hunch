---
name: hunch
description: Set up, configure and run Hunch, the code reviewer that asks TypeSafe's Jev model plain-English and typed yes/no, choice and score questions about every change. Use when the user wants to review a branch or pull request against rules, write or tune a review rule in hunch.config.ts or hunch.toml ("add a rule that…", noul, choice, score), install Hunch on GitHub (the App or Actions), compile AGENTS.md or Agent Skills into hunch.lock, find the code a change will touch, work out why a PR got no Hunch review, or measure a rule's precision. Use it whenever the user says hunch or /hunch, or asks for semantic review rules that a linter can't express, even if they don't name Hunch.
argument-hint: "[install|config|rules|compile|check|find|doctor|eval|operator] [what you want]"
allowed-tools: Bash(npx @kelbie/hunch *) Bash(npx hunch *) Bash(hunch *) Bash(bun run hunch *)
compatibility: Node 22+ and git. gh for doctor and find --prs. A model key only for check, find and eval.
metadata:
  version: "0.12.0"
---

# Hunch

Hunch reviews code for the mistakes type checkers and linters miss. Each rule is one question, asked by
[Jev](https://docs.typesafe.ai) about one chunk of a diff at a time. Jev answers with a probability
or a label, not prose. A finding is a configured concern whose score crossed a threshold. It is not a
proven bug and not a generated explanation. Hunch runs locally, in GitHub Actions, or through the
hosted GitHub App.

## Running it

Work out the command prefix before running anything.

| The repository… | Run Hunch as |
| --- | --- |
| is `Kelbie/hunch` itself | `bun run hunch <command>` |
| has `@kelbie/hunch` in `package.json` | `npx hunch <command>` (the pinned local copy) |
| anything else | `npx @kelbie/hunch <command>` (latest from npm; no install needed) |

Every command takes `--cwd <dir>` and `--help`. The complete list of flags with their defaults is in
[references/cli.md](references/cli.md), which is generated from the CLI, so trust it over memory.

## Verbs

`/hunch <verb> <request>` maps to one CLI command and one reference. Read the reference before acting.
With no verb, pick one from the request and say which you picked.

| Verb | Use it to | Runs | Read |
| --- | --- | --- | --- |
| `install` | set Hunch up in a repository: App, Actions or local | `init`, `doctor` | [install.md](references/install.md) |
| `config` | see, validate or change settings: scope, presets, levels, budget, provider | `config` | [config.md](references/config.md) |
| `rules` | turn "flag changes that…" into a rule, or tune one that is noisy or silent | `config --explain`, `check --only` | [rules.md](references/rules.md) |
| `compile` | turn AGENTS.md and Agent Skills into review questions in `hunch.lock` | `compile` | [compile.md](references/compile.md) |
| `check` | review a branch, staged changes, a PR or whole files | `check` | [check.md](references/check.md) |
| `find` | find the code a planned change touches, and any open PR already doing it | `find` | [find.md](references/find.md) |
| `doctor` | explain why a PR got no review | `doctor` | [doctor.md](references/doctor.md) |
| `eval` | measure a rule's precision and recall on labelled diffs | `eval` | [eval.md](references/eval.md) |
| `operator` | run your own deployment of the GitHub App | `app register`, `app connect` | [operator.md](references/operator.md) |

Each reference links to real captured output under [examples/](examples/). Compare what you see
against it.

## By situation

| The user has | and wants | Run |
| --- | --- | --- |
| no Hunch config | to try it on this branch | `check --rule id="sentence"` |
| no Hunch config | Hunch on every PR | `init`, then follow [install.md](references/install.md) |
| a config | to review this branch | `check` (against `origin/main`), or `check --base main` |
| a config | to review only what is staged | `check --staged` |
| a config | to review whole files, not a diff | `check --all [path]` |
| a new or edited rule | to know it is valid and what it asks | `config`, then `config --explain <id>` |
| a new rule | to try it cheaply | `check --only <id> --dry-run`, then without `--dry-run` |
| AGENTS.md or skills | them enforced in review | `compile`, then commit `hunch.lock` |
| a change to make | the code it touches | `find "<task>"`, plus `--prs` to check for duplicate work |
| a PR with no review | the reason | `doctor` |
| a noisy rule | fewer false positives | [rules.md](references/rules.md#tuning), then `eval` |
| a rule that must block merges | it enforced | `"error"` + `failOnError: true` + a required check: [rules.md](references/rules.md#blocking-merges) |
| no `origin` remote | to review a branch | `check --base main` (the default base is `origin/main`) |

## Exit codes

The same on every command.

| Code | Means | Do |
| --- | --- | --- |
| 0 | done, and complete | report the result |
| 1 | a policy failure: `check` found an error-level concern with `failOnError`, or `doctor` found a fault | report the findings or the fault; it is not a crash |
| 2 | could not run, or finished incomplete | read stderr and every notice; never report a clean review |

## Always

- **Dry-run before spending.** `check`, `find` and `compile` take `--dry-run`, which prints what would be
  sent. Check the count, and get the user's consent before a large run.
- **Keys never go in config.** `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY` belongs in the environment,
  `.env.local` (git-ignored) or a repository secret. Never echo a key, or put one in argv.
- **Policy comes from the base branch.** The App and the Actions workflow read the config and
  `hunch.lock` from the PR's base commit. A config change takes effect after it merges, so the PR
  that adds or changes Hunch is not reviewed by its own rules.
- **Incomplete is not clean.** Exit 2, a notice, a stale `hunch.lock` or a skipped budget means some
  code went unreviewed. Say so, and name what was skipped.
- **Findings are judgments.** Present each one as "Hunch flagged … (rule, score)", not as a confirmed
  bug. Read the code before agreeing with it.
- **Not a linter.** Anything a regex, type checker or linter can decide (naming, formatting, a
  forbidden call, counting) belongs in that tool. Say so rather than writing a Hunch rule for it.
- **Don't run PR code.** Hunch never executes the config. Keep it that way: don't add `import`s of
  project code, environment reads or function calls to `hunch.config.ts`. The loader rejects them.

## Changing the config

Edit `hunch.config.ts` or `hunch.toml` directly; `init` only creates it. After every edit:

1. `config`. Exit 0 means valid. Any listed problem is something `check` would fail on or skip.
2. `config --explain <id>` for each rule you touched. Read the instructions and criteria exactly as
   Jev will receive them.
3. `check --only <id> --dry-run` to count what the rule costs on this branch.
4. With the user's go-ahead: `check --only <id>`, and `eval` if they have labelled fixtures.

## Files Hunch owns

| File | Written by | Commit it? |
| --- | --- | --- |
| `hunch.config.ts` or `hunch.toml` | `init`, then people and agents | yes, to the default branch |
| `hunch.lock` | `compile` | yes, after reading it: it is the policy |
| `.github/workflows/hunch.yml` | `init --target actions` | yes, for the Actions path |
| `.env.local` | the `init` wizard, when given a key | never; `init` adds it to `.gitignore` |
