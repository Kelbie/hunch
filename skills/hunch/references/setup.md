# Installing Hunch

Match the CLI, skill and Action versions. Main may contain unreleased features. A locally packed
development CLI can be used immediately, but `init --target actions` pins its version tag: confirm
that tag exists before committing the generated workflow. Until release, use a reviewed commit SHA
for `Kelbie/hunch` rather than a nonexistent version tag.

Contents: [choose a path](#choose-a-path) · [init](#init) · [GitHub App](#github-app) ·
[GitHub Actions](#github-actions) · [local](#local) · [on pull requests](#on-pull-requests) ·
[what went wrong before](#what-went-wrong-before)

## Choose a path

| Path | Reviews | Needs | Doesn't need | Pick it when |
| --- | --- | --- | --- | --- |
| **GitHub App** (hosted) | every non-draft PR, fork PRs included, as inline review comments | the App installed, and a config committed to the default branch | a key, a workflow, a server | the default: the least to set up |
| **GitHub Actions** | every same-repository PR, under Checks → Hunch | a config and `.github/workflows/hunch.yml` on the default branch, plus an `AI_GATEWAY_API_KEY` secret | the App | the user wants reviews on their own key and in their own CI |
| **Local** | whatever `check` is pointed at | a config (or `--rule`), and a model key in the environment | anything on GitHub | trying Hunch, or reviewing before pushing |
| **Your own App** | like the hosted App | a Vercel project and an App you register | | the user must own the backend: see [operator.md](operator.md) |

Ask the user which path they want if the request doesn't say. The App is the recommendation.

## init

`init` writes `hunch.config.ts` (when the presets include TypeScript) or `hunch.toml` (otherwise), and
for `--target actions` also the workflow. It never overwrites a config or workflow; it exits 2
instead. At a terminal it asks its questions with arrow keys. An agent has no terminal, so pass flags:
**any flag skips the questions**.

| Question the wizard asks | Flag | Default |
| --- | --- | --- |
| Which starter rules? | `--preset ts,rust` (`general` = recommended only) | detected: `Cargo.toml` → rust, `package.json` → ts, else general |
| Which files to review? | `--include <glob>`, repeatable | the language's own files, or every file |
| Which files to skip? | `--ignore <glob>`, repeatable | build output (`dist/**`, `target/**`, …) |
| Where should Hunch review? | `--target app\|actions\|local` (`--github` = actions) | nothing extra written |
| Zero data retention? | `--no-zero-data-retention` to turn it off | enforced |
| Fail the check on an error-level concern? | `--fail-on-error` | no |
| Send the PR title and description? | `--task none` to stop | `pr` |
| A rule of your own? | `--rule id="sentence"`, repeatable | none |
| Install the Hunch skill? | `--install-skill` | no |
| (everything) | `--yes`: all detected defaults | |

The wizard also asks for a model key on the local and Actions paths, and whether to keep it for
every project on the machine (the default) or only in this project's `.env.local`. There is
deliberately **no key flag**, because a key in argv is visible to other processes and lands in
shell history. Outside the wizard the user runs `auth login` themselves ([below](#model-access)),
or `gh secret set` for Actions.

Zero data retention: Vercel AI Gateway enforces it only on Pro and Enterprise plans. On Hobby,
every review fails until `zeroDataRetention: false` is set. That is a data-policy decision, so ask
the user rather than choosing. `docs/status.md` in the Hunch repo (2026-09-18) records that the
hosted App itself runs on Hobby, so a repository using the hosted App needs
`zeroDataRetention: false` for its reviews to run.

Examples, with their real output and the files written: [examples/init.md](../examples/init.md).

## GitHub App

```sh
npx -y --min-release-age=0 @kelbie/hunch init --target app                 # or the wizard
git add hunch.config.ts                             # and hunch.lock, if compiled
git commit -m "Review PRs with Hunch" && git push   # to the default branch
```

1. The user installs the App on the repositories to review. This is a browser step you can't do for
   them: <https://github.com/apps/hunch-review/installations/new>
2. `init --target app`, plus `install` if the repository names packs or has AGENTS.md or skills
   ([install.md](install.md)).
3. Commit the config (and `hunch.lock`) **to the default branch**. The App reads its policy from each
   PR's base commit, so nothing is reviewed until it merges.
4. Open a PR. The PR that adds Hunch is skipped with a notice, which is expected. A repository
   writer can comment `/hunch recheck` on any PR for a fresh review.

Drafts are skipped until marked ready for review. If no review appears, run `doctor`
([doctor.md](doctor.md)).

## GitHub Actions

```sh
npx -y --min-release-age=0 @kelbie/hunch init --target actions
gh secret set AI_GATEWAY_API_KEY          # the user pastes the key; never pass it as an argument
```

The workflow `init` writes (see [examples/init.md](../examples/init.md#init-actions)):

- runs on `pull_request`: opened, synchronize, reopened, ready_for_review and edited;
- skips drafts, fork PRs (Actions withholds secrets from forks, so use the App for those) and
  Dependabot;
- checks out the **base** commit with `persist-credentials: false`, so the policy comes from the base
  branch and the PR's own code never runs with credentials;
- runs `uses: Kelbie/hunch@v<version>`, pinned to the CLI version that wrote it, with the base and
  head SHAs;
- fails with a clear error when the secret is missing.

Commit the config **and** the workflow to the default branch. Reviews appear under Checks → Hunch,
as annotations plus a job summary.

This repository's own `.github/workflows/hunch.yml` is a variant that runs `uses: ./` (the checkout
itself) and prints a notice, rather than failing, when the secret is absent.

## Local

```sh
npx -y --min-release-age=0 @kelbie/hunch auth login      # once per machine; see Model access
npx -y --min-release-age=0 @kelbie/hunch init --target local
npx -y --min-release-age=0 @kelbie/hunch check
```

## Model access

Sign in once per machine and Hunch works in every directory, with or without a config. Nothing
about it lives in the project.

| The user has | They run, once | What is stored in the user config directory |
| --- | --- | --- |
| an AI Gateway or TypeSafe key | `auth login`, which asks with a hidden prompt | the key, owner-only |
| the same, but no terminal (an agent, a script) | `auth login --with-token` with the key on standard input | the key, owner-only |
| no key, but `vercel login` and a project with AI Gateway | `auth login --vercel` inside a `vercel link`ed directory, or with `--project` and `--team` | the project and team ids; no secret |
| no account anywhere, or a wish to keep code local | `auth login --provider semif --install`, which installs [SemIf](#semif-an-open-model-on-your-own-machine) first | which Python and model to run; no secret |

`auth status` says which of these Hunch can see from the current directory and where each comes
from, never the key; `--reporter json` for scripts. It exits 1 when there is nothing to sign in
with. `auth logout` deletes what was stored. Captured runs: [examples/auth.md](../examples/auth.md). The file is `$XDG_CONFIG_HOME/hunch/credentials`,
else `~/.config/hunch/credentials` (`%APPDATA%\hunch\credentials` on Windows).

**As an agent, never handle the key.** When a run fails with an authentication error, run
`auth status`, then ask the user to run `auth login` in their own terminal (in Claude Code:
`! npx -y --min-release-age=0 @kelbie/hunch auth login`). Do not ask them to paste a key into the conversation, and do
not pass one as an argument. `auth login --vercel` stores no secret, so an agent may run it when
the user asks for that path.

With nothing to sign in with, `check`, `find` and `install --with gateway` stop before the first
request and print how to sign in (exit 2). An invalid or expired key, an account with no credit
(`HTTP 402`) and a plan that cannot enforce zero data retention each stop the run on the first
refusal, and the message lists the commands that fix it. None is reported as a provider outage or as
chunks that failed. Relay those commands to the user; do not retry, install anything or ask for a key.

Hunch takes the first of these that is set:

1. the real environment: `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY` or `SEMIF_*`;
2. `.env.<mode>.local`, `.env.local`, `.env.<mode>` and `.env` in the working directory, so a
   project can pin its own key;
3. the key stored by `auth login`;
4. for the AI Gateway with no key: the Vercel project linked in or above the working directory,
   then the one stored by `auth login --vercel`. Both need a current `vercel login`.

| Provider | Credential | Config | Name it for one run |
| --- | --- | --- | --- |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY`, or Vercel OIDC: on Vercel, after `vercel link`, or after `auth login --vercel` | nothing, or `provider: "gateway"` to hold every run to it | `--provider gateway` |
| TypeSafe directly | `TYPESAFE_API_KEY` | nothing, or `provider: "typesafe"` to hold every run to it | `--provider typesafe` |
| SemIf, on this machine | none; `SEMIF_*` say which Python and model | nothing, or `provider: "semif"` to hold every run to it | `--provider semif` |

`check`, `find`, `config` and `eval` all take `--provider`, which wins over the config for that one
run. It is the quickest way to try a repository's rules against a different model, or to fall back
when one provider is refusing.

A config that names no `provider` uses what the machine is signed in with: TypeSafe directly when a
`TYPESAFE_API_KEY` is found and no `AI_GATEWAY_API_KEY` is, SemIf when it alone is set up, otherwise
the Gateway. So after `auth login --provider typesafe`, Hunch runs in any repository, with or
without a Hunch config, and nothing passes through Vercel. The hosted App and CI hold neither, so
they are unaffected. A config that names `provider: "gateway"` is obeyed and needs Gateway
credentials; `hunch config` shows which provider a run will use. `zeroDataRetention` is a Gateway
setting and does nothing on a direct TypeSafe or SemIf run.

### SemIf: an open model on your own machine

[SemIf](https://github.com/TheoLeeCJ/SemIf) answers the same yes/no, choice and score questions as
Jev, from an open model you run yourself. It is an independent project, not affiliated with TypeSafe,
and its published accuracy is its own — measure it on your own rules with `eval` before trusting it
to gate anything. There is no account and no key, and your code is scored on the machine: the only
thing fetched is the model itself, from Hugging Face, until it is cached.

```sh
npx -y --min-release-age=0 @kelbie/hunch auth login --provider semif --install
npx -y --min-release-age=0 @kelbie/hunch check --provider semif
```

`--install` makes a virtualenv of Hunch's own — `$XDG_DATA_HOME/hunch/semif`, else
`~/.local/share/hunch/semif` (`%LOCALAPPDATA%\hunch\semif` on Windows) — installs a pinned SemIf
and its model runtime into it, and records it. It uses `uv` when that is on `PATH` and `python3 -m
venv` otherwise, prints every command it runs, and downloads a few gigabytes. It is the whole setup:
after it, `check` and `find` work in every directory with no account anywhere.

To use a SemIf you installed yourself, drop `--install` and pass `--python .venv/bin/python`. Either
way the interpreter is checked for `import semif_phase1` and nothing is stored if it fails. Pass
`--backend mlx` on Apple Silicon, or `--backend llamacpp --gguf <file>` for a local GGUF checkpoint.
`--model` and `--revision` pin a different model; the default is SemIf's own published baseline,
`Qwen/Qwen3.5-4B`.

### Finishing on SemIf when a provider refuses

Once SemIf is set up, a hosted provider that refuses **every** request — no key, no credit, a
retention policy it cannot meet — no longer ends a run. `check` and `find` start again on SemIf,
warn on stderr, and name the model that answered in the report's `modelIds`. Read that: a review
finished this way was judged by a different model than the one the config names.

It only happens before the first answer, so no single review is judged half by one model and half by
another; a provider that has answered once keeps the run, failures included. `--no-fallback` fails
instead. Naming `--provider` turns the offer off for that run, because a named provider is an
instruction. `eval` never falls back: switching model mid-measurement would corrupt the number it
exists to produce.

The first question loads the model, which downloads several gigabytes the first time and then stays
loaded for the rest of the run. A dry run, an empty diff and `hunch config` never start it. The
repository can fix the portable part of this in `semif` ([config.md](config.md#every-option)); which
Python, which GPU and which checkpoint belong to the machine, so they stay in `SEMIF_*`, which also
overrides the config for a machine that cannot run what the repository assumed.

SemIf never truncates a prompt: one that exceeds `semif.maxTokens` fails its own request rather than
losing evidence, and `check` reports those rules as unanswered. Lower `review.chunkLines` or raise
`maxTokens` if that happens often.

Each question is scored on its own by default. `semif.mode` set to `shared` or `serial` prefills a
hunk's state once and answers every rule of that hunk against it, which SemIf measures as several
times faster — but only when the tokenizer splits that state off the prompt exactly. It refuses the
request when it cannot, and `check` reports those rules unanswered rather than scoring something
else, so try it on your own repository before relying on it.

No config at all is fine: `check --all --pack nuts-spec` reviews against published rules
([packs.md](packs.md)), and `check --rule id="sentence"` tries one of your own ([check.md](check.md)).

## On pull requests

| The user wants | They do |
| --- | --- |
| to dismiss a finding that doesn't apply | resolve the review conversation. Hunch won't raise that rule in that file again on this PR. Only resolutions by people with write access count |
| to confirm a fix | push. Hunch resolves its own comments for concerns that are gone |
| a fresh review | comment `/hunch recheck` |
| the reason for an error-level failure | the finding's message and rule id. `config --explain <id>` shows the question |

## What went wrong before

These happened installing Hunch on real repositories. Check for them.

| Symptom | Cause | Fix |
| --- | --- | --- |
| The first PR after setup has no review | policy comes from the base branch, and the config isn't there yet | merge the config; that PR is skipped by design |
| The App can't be installed on an organisation | a private App can only be installed on the account that owns it | install the hosted App, or register your own with `--organization` or `--public` ([operator.md](operator.md)) |
| Every Actions run fails on config options | the workflow pinned an older `Kelbie/hunch@v…` that rejects newer options | re-run `init --target actions` in a fresh checkout, or update the `uses:` tag to the CLI's version |
| Every review fails at the provider | `zeroDataRetention` is enforced on a Vercel Hobby account | the user decides whether to set `zeroDataRetention: false` |
| `npx -y --min-release-age=0 @kelbie/hunch` fails with `ENOVERSIONS: No versions available` | the user's npm has `min-release-age` (or `before`) set, and every Hunch version is newer than it allows; earlier runs worked from npx's cache | `npx --min-release-age=0 @kelbie/hunch …`, or `npm install -g @kelbie/hunch --min-release-age=0`. Leave their `.npmrc` alone: the setting guards every other package |
| Config was changed on a PR but reviews ignore it | reviews use the base branch's config | merge it; then `/hunch recheck` |
