# Configuration

Contents: [files](#files) · [every option](#every-option) · [presets](#presets) · [levels and overrides](#levels-and-overrides) ·
[scope](#scope) · [budget](#budget) · [providers and data retention](#providers-and-data-retention) ·
[guidance](#guidance) · [validate](#validate)

Writing the rules themselves is covered in [rules.md](rules.md). Real `hunch config` output is in
[examples/config.md](../examples/config.md).

## Files

A repository has exactly one of these at its root. With both present, every command fails.

| File | Used when | Keys | Rule ids and choice labels |
| --- | --- | --- | --- |
| `hunch.config.ts` | the project is TypeScript/JavaScript | camelCase | kept as written |
| `hunch.toml` | anything else, including Rust | kebab-case (`fail-on-error`) | kept as written |

`hunch.config.ts` is **parsed, never run**. Allowed: `import` from `@kelbie/hunch` (the imports are
ignored), `const` bindings, object and array literals and spreads, regex literals, string
concatenation, `as`/`satisfies`, and the helpers `defineConfig`, `noul`, `choice`, `score`. Rejected:
imports from anywhere else, `process.env`, computed keys, function calls other than the helpers, and
function definitions. Keep it that way: the App reads this file from a PR's base branch with
credentials in hand.

```ts
import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  include: ["src/**"],
  rules: { "api/stable-errors": ["error", "Error responses keep their code field."] },
});
```

```toml
extends = ["hunch:recommended", "hunch:rust"]
include = ["src/**"]
fail-on-error = true

[rules]
"api/stable-errors" = ["error", "Error responses keep their code field."]
```

## Every option

| TypeScript | TOML | Default | Means |
| --- | --- | --- | --- |
| `extends` | `extends` | `[]` | presets to start from; see [presets](#presets) |
| `include` | `include` | `["**/*"]` | globs of files to review |
| `ignore` | `ignore` | `[]` | globs to skip, on top of the files [always skipped](#scope) |
| `rules` | `[rules]` | `{}` | rule id → level, or `[level, rule]`; see [rules.md](rules.md) |
| `overrides` | `[[overrides]]` | `[]` | `{ files, rules }`: different levels or rules for some paths |
| `failOnError` | `fail-on-error` | `false` | `check` exits 1 (and the check fails) when an `error` rule reports |
| `task` | `task` | `"pr"` | `"pr"` sends the PR title and description to every question as `task`; `"none"` sends nothing |
| `provider` | `provider` | unset | `"gateway"` (Vercel AI Gateway), `"typesafe"` (direct) or `"semif"` (an open model on this machine). Unset uses the signed-in credentials: TypeSafe when only a `TYPESAFE_API_KEY` is found, SemIf when only it is set up, otherwise the Gateway ([setup.md](setup.md#model-access)). Every command takes `--provider` to override it for one run |
| `model` | `model` | `"jev-1.13.0"` | the TypeSafe model id, used by `provider: "typesafe"`. Gateway always serves `typesafe-ai/jev` |
| `semif` | `[semif]` | `{}` | settings for `provider: "semif"`; see [SemIf](#semif) |
| `zeroDataRetention` | `zero-data-retention` | `true` | ask Gateway to route only to zero-retention providers; see below |
| `packs` | `[[packs]]` | `[]` | published rule packs to review against: `"nuts-spec"`, `"owner/repo/name@v2"`, or `{ pack, rules }` to keep only some ids. `hunch install` copies them into `hunch.lock` ([packs.md](packs.md#packs-in-the-config)) |
| `skills` | `skills` | every installed skill | Agent Skills to compile into `hunch.lock`; `[]` for none |
| `agentsMd` | `agents-md` | `true` | compile root and nested `AGENTS.md` |
| `docs` | `docs` | `[]` | extra Markdown files to compile, e.g. a style guide |
| `compileModel` | `compile-model` | `"anthropic/claude-sonnet-5"` | model for `install --with gateway` only |
| `budget` | `[budget]` | see [budget](#budget) | per-run limits |
| `review` | `[review]` | see [review context](#review-context) | chunk size, source context and optional localization |
| `unit` | `unit` | `"hunk"` | reserved; only `"hunk"` exists |

Unknown keys are errors, not warnings, so a misspelt option fails `hunch config` immediately.

## Presets

Presets ask about consequences a linter cannot see. Every preset rule is a `noul` at `warn` with a
0.85 threshold. That is a conservative start, not a measured accuracy.

| Preset | Rule | Flags a change that… |
| --- | --- | --- |
| `hunch:recommended` | `failures/misleading-success` | turns a failure into something the caller treats as success |
| | `correctness/edge-case-regression` | breaks a previously supported empty, missing, zero or boundary case |
| | `tests/weakened-test` | lets an edited test accept behaviour it is still meant to reject |
| | `docs/contradictory-comment` | leaves a comment or API description contradicting the code |
| `hunch:typescript` | `typescript/async-ordering` | lets overlapping async work publish stale state or repeat an effect |
| (JS/TS files only) | `typescript/lossy-serialization` | loses meaning a consumer needs when converting data |
| `hunch:rust` | `rust/panic-on-recoverable-input` | panics on ordinary bad input the caller expects as an error |
| (`.rs` files only) | `rust/error-context` | merges errors whose difference a caller needs |

Language presets add to `recommended`; list both. A mixed repository can list all three, because each
language preset's rules only apply to that language's files. `hunch config --explain <id>` prints
any preset rule's full question.

## Levels and overrides

| Level | Effect |
| --- | --- |
| `"off"` | not asked |
| `"warn"` | reported; never fails the check |
| `"error"` | reported; fails the check (exit 1) when `failOnError` is true |

A bare level changes a rule's severity and keeps its question. That works for preset and compiled
rules too:

```ts
rules: {
  "docs/contradictory-comment": "error",     // preset rule, now an error
  "typescript/lossy-serialization": "off",   // preset rule, switched off
  "skill/seo/*": "off",                      // every compiled rule from the seo skill
},
overrides: [
  { files: ["scripts/**", "**/*.test.ts"], rules: { "api/stable-errors": "off" } },
],
```

A level for an id that no preset, config or compiled rule has is a typo. `hunch config` reports it,
and `check` would fail on it. An override that gives a whole new rule, rather than a level, replaces
the question, including its `files`.

## Scope

`include` and `ignore` decide which files `check`, `check --all` and `find` read. Rules can narrow
further with their own `files`. These are never reviewed, whatever `include` says:
`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`,
`deno.lock`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, `poetry.lock`, `uv.lock`, `go.sum`,
`*.min.js`, `*.min.css`, `*.map` and anything under `node_modules/`. Deleted files, binary files,
renames and mode changes need human review and make the review partial.

`hunch.config.ts` matches a TypeScript `include`, and its rule text contains the very words rules
look for, so `init` puts it in `ignore`. Keep it there.

Globs use picomatch syntax, with dotfiles matched: `src/**`, `**/*.{ts,tsx}`. Don't put a `!`
negation in `include`. A negated pattern matches every other file, so it widens the scope. Use `ignore`.

## Budget

| Key (TS / TOML) | Default | Max | Limits |
| --- | --- | --- | --- |
| `maxHunks` / `max-hunks` | 100 | 100,000 | hunks reviewed per run; the rest make the review partial |
| `maxRulesPerHunk` / `max-rules-per-hunk` | 24 | 1,024 | questions asked about one hunk |
| `concurrency` | 4 | 32 | requests in flight |
| `maxRequests` / `max-requests` | 100 | 1,000,000 | Jev requests per run: at least one per hunk, more when the hunk's rules do not fit one request, plus one per extra `reference` and optional localization |
| `timeoutSeconds` / `timeout-seconds` | 180 | 86,400 | deadline shared by requests and localization |

The hosted App always caps a run at 3,000 hunks, 3,000 requests, 8 requests in flight and 240 seconds. On a large PR the
time limit usually ends the review first, and the report says the review is partial. Raise the budget for
`check --all` on a big repository, and size it with `check --all --dry-run`: the dry run counts the
requests the whole review needs and exits 2 when the budget is smaller. `find` ignores the budget;
it has its own `--concurrency`.

## Review context

These settings apply to local checks, Actions and the GitHub App. They do not change `find`,
which has its own window flags. Policy and `reference` files come from the trusted base revision;
surrounding source comes from the reviewed head, index or working tree. Saved `--diff` input has
no verified source revision, so it receives no automatic surrounding source.

| Key (TS / TOML) | Default | Meaning |
| --- | --- | --- |
| `contextLines` / `context-lines` | 40 | Up to 200 lines before and after each diff window; 0 disables it. A missing, mismatched or oversized requested source makes coverage incomplete. |
| `chunkLines` / `chunk-lines` | 150 | Maximum diff-body rows or whole-file source lines per window, also subject to token limits. Range 1–2000. |
| `overlapLines` / `overlap-lines` | 0 | Repeated source lines between `check --all` windows; smaller than chunkLines. Diff windows use surrounding context instead. |
| `localize` | false | Experimental: after all baseline checks, refine positive findings into smaller changed-line ranges. |
| `compiledScope` / `compiled-scope` | `"inferred"` | Where compiled rules are asked. `"inferred"` uses each rule's `appliesTo` globs and `when` regex from `hunch.lock`, which the compiler guessed. `"everywhere"` asks every compiled rule of every reviewed chunk: no rule is lost to a wrong guess, at the price of more questions and requests. Levels (`"off"`), `include`/`ignore` and a nested `AGENTS.md`'s directory still apply, as do `files` and `when` on rules written in the config. |
| `localizationLines` / `localization-lines` | 10 | Target range size for localization, 1–100. Not a guarantee: ambiguous findings keep their broader range. |
| `maxLocalizationRequests` / `max-localization-requests` | 32 | Additional refinement requests, 0–1000, also inside the overall request/time budget. |

Localization evaluates both halves with the full parent, surrounding source, task and reference
still visible. It never skips a baseline window because a parent or neighboring window scored
low. A concern spanning both halves retains its parent if neither child supports it. Provider,
confidence, abstention or budget failures retain the original finding and mark coverage partial.
Deletion-only findings use a surviving-line anchor. Adjacent positive ranges remain independent;
a high score is not transferred to a neighboring chunk.

The [controlled live probe](https://github.com/Kelbie/hunch/blob/main/docs/benchmarks/review-localization-2026-09-19/README.md)
recovered its planted targets with shorter ranges but also added unsupported ranges. Keep
localization opt-in and inspect every candidate. Whole-file windows repeat imports; arbitrary
callers, tests and contracts are not automatically retrieved. Use task-mode `find` to investigate
those relationships, or supply a concise `reference` contract when authoring recurring rules.

## Providers and data retention

| Setting | Gateway (default) | TypeSafe direct |
| --- | --- | --- |
| Credential | `AI_GATEWAY_API_KEY`, or Vercel OIDC (deployed, or `vercel link` + login) | `TYPESAFE_API_KEY` |
| Model | `typesafe-ai/jev`, not version-pinned | `model`, default `jev-1.13.0` |
| `zeroDataRetention` | enforced routing; **fails on Vercel Hobby**, which can't enforce it | no effect; the TypeSafe account agreement governs retention |
| Timeouts | 90 s per call, with up to five retries on rate limits | 45 s |

There is no silent fallback: an enforced setting that can't be met fails the review. Turning
retention off is the user's decision. Record it in the config with a comment, as this repository's
own config does.

`install --with gateway` uses `compileModel` through Gateway, under the same retention setting.

### SemIf

`provider: "semif"` answers from an open model this machine runs, with no account, no key and
nothing leaving the machine. Installing and signing in to it is in
[setup.md](setup.md#semif-an-open-model-on-your-own-machine); its accuracy is its own project's,
so measure it on your own rules with [eval.md](eval.md) before it gates anything.

A repository fixes only the portable part. Which Python, which GPU and which checkpoint file are
properties of a machine, so they live in `SEMIF_*` — which also overrides everything below, for a
machine that cannot run what the repository assumed.

| TypeScript | TOML | Default | Means |
| --- | --- | --- | --- |
| `semif.model` | `[semif] model` | `"Qwen/Qwen3.5-4B"` | Hugging Face id or local path; SemIf's published baseline for direct option logits. `SEMIF_MODEL` |
| `semif.revision` | `[semif] revision` | that model's pinned commit | the 40-character commit SemIf requires for a remote model. `SEMIF_REVISION` |
| `semif.mode` | `[semif] mode` | `"direct"` | `direct`, `serial`, `shared` or `reranker`. `shared` and `serial` prefill one hunk's state once and answer every rule of that hunk against it, which is much faster; SemIf refuses the request when the tokenizer does not split that state off the prompt exactly, and `check` then reports those rules unanswered. `direct` never needs that. `SEMIF_MODE` |
| `semif.backend` | `[semif] backend` | `"torch"` | `torch`, `mlx` (Apple Silicon) or `llamacpp` (a local GGUF). `SEMIF_BACKEND` |
| `semif.maxTokens` | `[semif] max-tokens` | `32768` | SemIf never truncates: a longer prompt fails its request rather than losing evidence, and `check` reports those rules as unanswered. `SEMIF_MAX_TOKENS` |

```toml
provider = "semif"

[semif]
model = "Qwen/Qwen3.5-4B"
mode = "shared"
max-tokens = 32768
```

Machine-only variables: `SEMIF_PYTHON` (an interpreter that can import `semif_phase1`),
`SEMIF_GGUF`, `SEMIF_DEVICE`, `SEMIF_DTYPE`, `SEMIF_THREADS`, `SEMIF_MLX_BITS`,
`SEMIF_STARTUP_SECONDS` and `SEMIF_BRIDGE`. `hunch auth login --provider semif` stores the first of
these once, for every directory.

## Guidance

`packs`, `skills`, `agentsMd` and `docs` all feed `hunch.lock`, which `hunch install` writes; see
[install.md](install.md). Packs are copied verbatim; guidance is compiled by an agent. None of them
does anything until installed, and a stale lock makes reviews partial.

| `skills` value | Selects |
| --- | --- |
| omitted | every skill in `.agents/skills/*`, then `.claude/skills/*` |
| `[]` | none |
| `"./.agents/skills/api-style"` or `"./skills/*"` | local directories |
| `"owner/repo"` or `{ repo: "owner/repo", skill: "name", ref: "v1" }` | skills from GitHub, pinned in the lock at install time |
| `"https://github.com/owner/repo/tree/ref/path"` | one skill by URL; use the object form when `ref` contains `/` |

## Validate

Run `hunch config` after every edit. It exits 2 on:

- a schema error (unknown key, wrong type, threshold outside 0–1);
- a level for a rule id nothing defines;
- a `reference` file that doesn't exist;
- a `hunch.lock` that is stale for the selected packs or guidance.

`hunch config --file <path>` lists the rules asked about one file. `--reporter json` gives `valid`,
`problems`, `settings`, `rules` and `overrides` for you to read programmatically.

## Upgrading

| From | Change |
| --- | --- |
| `@hunch/cli` (0.3.0 preview) | install `@kelbie/hunch` and import the helpers from it. The loader still accepts `@hunch/cli` imports |
| 0.1 rule ids | `entropy/weakened-test` → `tests/weakened-test`, `entropy/stale-comment` → `docs/contradictory-comment`. Delete overrides for the removed style and off-task rules |
| `init --github`, `--ts`, `--rust`, `--general` | `init --target actions`, `--preset ts\|rust\|general` (`--github` still works) |
| 0.19 `hunch compile` | `hunch install`, which also copies the packs `packs` names. `compile` and `i` are aliases, so existing scripts keep working |
| 0.19 `check --pack` or `--config` in a repository that has a config | these now replace the whole policy, `hunch.lock` included, so compiled guidance and installed packs are no longer also asked. `--rule` still only adds |
