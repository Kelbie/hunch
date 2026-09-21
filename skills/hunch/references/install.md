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
npx @kelbie/hunch init --target app                 # or the wizard
git add hunch.config.ts                             # and hunch.lock, if compiled
git commit -m "Review PRs with Hunch" && git push   # to the default branch
```

1. The user installs the App on the repositories to review. This is a browser step you can't do for
   them: <https://github.com/apps/hunch-review/installations/new>
2. `init --target app`, plus `compile` if the repository has AGENTS.md or skills
   ([compile.md](compile.md)).
3. Commit the config (and `hunch.lock`) **to the default branch**. The App reads its policy from each
   PR's base commit, so nothing is reviewed until it merges.
4. Open a PR. The PR that adds Hunch is skipped with a notice, which is expected. A repository
   writer can comment `/hunch recheck` on any PR for a fresh review.

Drafts are skipped until marked ready for review. If no review appears, run `doctor`
([doctor.md](doctor.md)).

## GitHub Actions

```sh
npx @kelbie/hunch init --target actions
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
npx @kelbie/hunch auth login      # once per machine; see Model access
npx @kelbie/hunch init --target local
npx @kelbie/hunch check
```

## Model access

Sign in once per machine and Hunch works in every directory, with or without a config. Nothing
about it lives in the project.

| The user has | They run, once | What is stored in the user config directory |
| --- | --- | --- |
| an AI Gateway or TypeSafe key | `auth login`, which asks with a hidden prompt | the key, owner-only |
| the same, but no terminal (an agent, a script) | `auth login --with-token` with the key on standard input | the key, owner-only |
| no key, but `vercel login` and a project with AI Gateway | `auth login --vercel` inside a `vercel link`ed directory, or with `--project` and `--team` | the project and team ids; no secret |

`auth status` says which of these Hunch can see from the current directory and where each comes
from, never the key; `--reporter json` for scripts. It exits 1 when there is nothing to sign in
with. `auth logout` deletes what was stored. Captured runs: [examples/auth.md](../examples/auth.md). The file is `$XDG_CONFIG_HOME/hunch/credentials`,
else `~/.config/hunch/credentials` (`%APPDATA%\hunch\credentials` on Windows).

**As an agent, never handle the key.** When a run fails with an authentication error, run
`auth status`, then ask the user to run `auth login` in their own terminal (in Claude Code:
`! npx @kelbie/hunch auth login`). Do not ask them to paste a key into the conversation, and do
not pass one as an argument. `auth login --vercel` stores no secret, so an agent may run it when
the user asks for that path.

With nothing to sign in with, `check`, `find` and `compile --with gateway` stop before the first
request and print how to sign in (exit 2). An invalid or expired key stops the run on the first
refusal, the same way. Neither is reported as a provider outage or as chunks that failed.

Hunch takes the first of these that is set:

1. the real environment: `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`;
2. `.env.<mode>.local`, `.env.local`, `.env.<mode>` and `.env` in the working directory, so a
   project can pin its own key;
3. the key stored by `auth login`;
4. for the AI Gateway with no key: the Vercel project linked in or above the working directory,
   then the one stored by `auth login --vercel`. Both need a current `vercel login`.

| Provider | Credential | Config |
| --- | --- | --- |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY`, or Vercel OIDC: on Vercel, after `vercel link`, or after `auth login --vercel` | nothing, or `provider: "gateway"` to hold every run to it |
| TypeSafe directly | `TYPESAFE_API_KEY` | nothing, or `provider: "typesafe"` to hold every run to it |

A config that names no `provider` uses what the machine is signed in with: TypeSafe directly when a
`TYPESAFE_API_KEY` is found and no `AI_GATEWAY_API_KEY` is, otherwise the Gateway. So after
`auth login --provider typesafe`, Hunch runs in any repository, with or without a Hunch config, and
nothing passes through Vercel. The hosted App and CI hold no TypeSafe key, so they are unaffected.
A config that names `provider: "gateway"` is obeyed and needs Gateway credentials; `hunch config`
shows which provider a run will use. `zeroDataRetention` is a Gateway setting and does nothing on a
direct TypeSafe run.

No config at all is fine for a trial: `check --rule id="sentence"` ([check.md](check.md)).

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
| `npx @kelbie/hunch` fails with `ENOVERSIONS: No versions available` | the user's npm has `min-release-age` (or `before`) set, and every Hunch version is newer than it allows; earlier runs worked from npx's cache | `npx --min-release-age=0 @kelbie/hunch …`, or `npm install -g @kelbie/hunch --min-release-age=0`. Leave their `.npmrc` alone: the setting guards every other package |
| `find` reports every chunk as "provider unavailable or rate limited" with 0 scored (before 0.18.1) | nobody is signed in; older versions did not say so | `auth status`, then the user runs `auth login` |
| Config was changed on a PR but reviews ignore it | reviews use the base branch's config | merge it; then `/hunch recheck` |
