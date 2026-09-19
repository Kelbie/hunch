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
| `provider` | `provider` | `"gateway"` | `"gateway"` (Vercel AI Gateway) or `"typesafe"` (direct) |
| `model` | `model` | `"jev-1.13.0"` | the TypeSafe model id, used by `provider: "typesafe"`. Gateway always serves `typesafe-ai/jev` |
| `zeroDataRetention` | `zero-data-retention` | `true` | ask Gateway to route only to zero-retention providers; see below |
| `skills` | `skills` | every installed skill | Agent Skills to compile into `hunch.lock`; `[]` for none |
| `agentsMd` | `agents-md` | `true` | compile root and nested `AGENTS.md` |
| `docs` | `docs` | `[]` | extra Markdown files to compile, e.g. a style guide |
| `compileModel` | `compile-model` | `"anthropic/claude-sonnet-5"` | model for `compile --with gateway` only |
| `budget` | `[budget]` | see [budget](#budget) | per-run limits |
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

Globs use picomatch syntax, with dotfiles matched: `src/**`, `**/*.{ts,tsx}`. Don't put a `!`
negation in `include`. A negated pattern matches every other file, so it widens the scope. Use `ignore`.

## Budget

| Key (TS / TOML) | Default | Max | Limits |
| --- | --- | --- | --- |
| `maxHunks` / `max-hunks` | 100 | 10,000 | hunks reviewed per run; the rest make the review partial |
| `maxRulesPerHunk` / `max-rules-per-hunk` | 24 | 64 | questions asked about one hunk |
| `concurrency` | 4 | 8 | requests in flight |
| `maxRequests` / `max-requests` | 100 | 10,000 | Jev requests per run: one per hunk, plus one per extra `reference` |
| `timeoutSeconds` / `timeout-seconds` | 180 | 7,200 | no new requests start after this |

The hosted App always caps a run at 3,000 hunks, 3,000 requests and 240 seconds. On a large PR the
time limit usually ends the review first, and the report says the review is partial. Raise the budget for
`check --all` on a big repository. `find` ignores the budget; it has its own `--concurrency`.

Long hunks are windowed, and Jev can't reason across windows. `check --all` splits files into
chunks of up to 150 lines, and repeats each file's imports in later chunks.

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

`compile --with gateway` uses `compileModel` through Gateway, under the same retention setting.

## Guidance

`skills`, `agentsMd` and `docs` select what `compile` turns into `hunch.lock`; see
[compile.md](compile.md). They do nothing until compiled, and a stale lock makes reviews partial.

| `skills` value | Selects |
| --- | --- |
| omitted | every skill in `.agents/skills/*`, then `.claude/skills/*` |
| `[]` | none |
| `"./.agents/skills/api-style"` or `"./skills/*"` | local directories |
| `"owner/repo"` or `{ repo: "owner/repo", skill: "name", ref: "v1" }` | skills from GitHub, pinned in the lock at compile time |
| `"https://github.com/owner/repo/tree/ref/path"` | one skill by URL; use the object form when `ref` contains `/` |

## Validate

Run `hunch config` after every edit. It exits 2 on:

- a schema error (unknown key, wrong type, threshold outside 0–1);
- a level for a rule id nothing defines;
- a `reference` file that doesn't exist;
- a `hunch.lock` that is stale for the selected guidance.

`hunch config --file <path>` lists the rules asked about one file. `--reporter json` gives `valid`,
`problems`, `settings`, `rules` and `overrides` for you to read programmatically.

## Upgrading

| From | Change |
| --- | --- |
| `@hunch/cli` (0.3.0 preview) | install `@kelbie/hunch` and import the helpers from it. The loader still accepts `@hunch/cli` imports |
| 0.1 rule ids | `entropy/weakened-test` → `tests/weakened-test`, `entropy/stale-comment` → `docs/contradictory-comment`. Delete overrides for the removed style and off-task rules |
| `init --github`, `--ts`, `--rust`, `--general` | `init --target actions`, `--preset ts\|rust\|general` (`--github` still works) |
