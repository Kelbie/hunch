# Configuration

Use one `hunch.config.ts` or `hunch.toml` at the repository root. The same schema validates both. Unknown keys and invalid shapes fail. TOML uses kebab-case for Hunch options; rule IDs and choice labels keep their original spelling.

TypeScript accepts plain literals, constant bindings, object/array spreads, regex literals, string concatenation, `as`/`satisfies`, and imported `defineConfig`, `noul`, `choice`, `score` helpers from `@kelbie/hunch`. It never imports or executes the file. Environment access, computed properties, arbitrary calls and function definitions are rejected.

## Rules

A plain-English rule `["warn", "The contract to preserve"]` becomes a yes/no violation question with a 0.7 threshold. A concern reported at this threshold is a model judgment, not proof. Rules use `off`, `warn` or `error` severity. Change inherited levels with `"rule/id": "off"`; override them by matching file globs with `overrides: [{ files: ["tests/**"], rules: {...} }]`.

Typed rules can control the exact question:

```ts
import { defineConfig, noul, choice, score } from "@kelbie/hunch";
export default defineConfig({
  rules: {
    "failures/misleading-success": ["warn", noul({
      instructions: "Does `hunk` turn an unsuccessful operation into a success response?",
      threshold: 0.8,
      message: "Preserve unsuccessful operation state for the caller.",
    })],
  },
});
```

- `noul`: boolean violation probability; `threshold` defaults to 0.7.
- `choice`: named `criteria`, `report` options, optional `minConfidence`.
- `score`: ordered `criteria`, `reportBelow` and/or `reportAbove` normalized to 0–1, optional `minConfidence`.
- All support `files` (file glob scope), `when` (regex prefilter), `reference` (repository-relative trusted file), and `message` (human-readable concern).

## What each question is given

Every question is evaluated against one chunk of code and these state values:

| Name | Always sent | Contents |
| --- | --- | --- |
| `context` | yes | Prose describing this chunk: whether it is a diff or a whole file being read, the file's path, language and role (test, fixture, example, generated, config, documentation), the line range under review, what `+`/`-`/space mean here, the other files the same change touches, and the rules for answering. |
| `file` | yes | The repository-relative path. |
| `hunk` | yes | The code, as a unified diff. |
| `task` | when `task: "pr"` | The pull request title and body, truncated to 8,000 characters. |
| `reference` | when the rule sets `reference` | That repository file, read from the base ref. |

Hunch appends the same closing instruction to every question, so a rule never has to say it: read `context` first, judge only from the values given, treat code you cannot see as unknown rather than missing, and — for a yes/no rule — answer no when the hunk is unrelated or shows no concrete evidence. Repeating those caveats in your own `instructions` is redundant; spend the words on what makes *this* concern concrete instead. A `noul` rule that states no `criteria` gets a conservative default pair rather than none; criteria you do write are sent exactly as written.

Because `context` names the file's role, a rule need not enumerate test or fixture paths to exclude them — say "this is a test file" is acceptable in `criteria.false` and it will apply wherever the path says so.

Question IDs are not semantic instructions. Each question must stand alone. Hunch's confidence is distribution concentration `(pmax − 1/n)/(1 − 1/n)`, not TypeSafe's own confidence or empirical accuracy. When a configured confidence threshold needs probabilities the provider omitted, the run fails rather than quietly suppressing a finding.

## Guidance

Without an explicit `skills` selection, discovery checks `.agents/skills/*` then `.claude/skills/*`, deduplicating names. An explicit list selects only those sources; `skills: []` selects none. Use local directories or `./path/*`, `owner/repo`, `{ repo, skill?, ref? }`, or `https://github.com/owner/repo/tree/ref/path`. For refs containing `/`, use the object form rather than the ambiguous URL form. Duplicate explicit skill names are errors. Skill Markdown is loaded recursively up to four directory levels, without executing scripts or loading binary assets. Hosted policy must be committed regular files; choose copied project skill installations instead of external symlinks.

`agentsMd` defaults to true. Each directory's effective guidance includes its ancestors, with later nested instructions taking precedence. Its combined text must fit 40 KB for one compiler context. Only the deepest applicable compiled AGENTS source is applied. A missing standalone `@file.md` include is an error; this optional import convenience is not part of the AGENTS standard. `docs: ["docs/contracts.md"]` selects extra Markdown explicitly.

`hunch compile` writes `hunch.lock` using a local coding agent. In a terminal it lists the installed agents (`claude`, `codex`) with Vercel AI Gateway last, then asks for effort. `--with claude|codex|gateway`, `--effort` and `--model` skip the menus. Without a terminal it reuses the compiler recorded in `hunch.lock`, or fails asking for `--with`. Claude Code runs with `--tools ""` and no settings files; Codex runs in its read-only sandbox. Both run in an empty temporary directory and must return schema-valid rules. `compileModel`, default `anthropic/claude-sonnet-5`, applies only to `--with gateway`. It records hashes, source locations, resolved remote commits, questions and unsupported guidance. Review the lock before committing. Unchanged sources are reused only with the same compiler model/provenance. `--force` refreshes all. The lock is policy data, not executable code. Normal reviews never fetch remote skill updates. To update remote guidance, run compile deliberately.

The compiler can lose nuance. Root and nested precedence, glob inference and omitted process rules deserve review. Manually edited questions can be retained until their source changes; compiler identity should reflect manual curation. This project's initial policy is explicitly agent-curated and is not claimed to be model-calibrated.

## Limits and providers

Default budgets: `maxHunks` 100, `maxRulesPerHunk` 24 (maximum 64), `concurrency` 4 (maximum 8), `maxRequests` 100 and `timeoutSeconds` 180. Raise `maxHunks`, `maxRequests` and `timeoutSeconds` (up to 10,000, 10,000 and 7,200) for full-branch runs with `check --all`; the hosted GitHub App always caps them at 3,000 hunks, 3,000 requests and 240 seconds, so on a large PR the time limit usually ends the review first. The engine rejects requests above a conservative 80,000-character context ceiling. Oversized references are skipped explicitly. Long hunks are windowed; the model cannot reason across windows. `check --all` splits whole files into chunks of up to 150 lines, cutting at a blank line before an unindented declaration where possible, and repeats the file's import block as context in later chunks.

These files are never reviewed, whatever `include` says: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, `poetry.lock`, `uv.lock`, `go.sum`, `*.min.js`, `*.min.css`, `*.map` and anything under `node_modules/`. Use `ignore` for project-specific generated files. Budget omissions, deleted files, binary/metadata changes and stale policy make coverage partial. Unsupported guidance recorded in the lock is reported as a human-review limitation, not counted as an evaluated rule.

Gateway calls use the SDK's exponential backoff (up to five retries, respecting supported retry headers) with a 90-second timeout for the whole call. This accommodates temporary free-tier rate limits; it cannot guarantee capacity or completion within the hosted worker's 300-second limit. Persistent provider failures remain failed reviews and can be retried by the queue. Direct TypeSafe calls retain their 45-second timeout.

`provider: "gateway"` uses AI SDK 7 `experimental_evaluate`, model `typesafe-ai/jev`, `AI_GATEWAY_API_KEY`, deployed Vercel OIDC, or a linked Vercel project (`vercel link` plus a Vercel CLI login). The CLI loads `.env.<mode>.local`, `.env.local`, `.env.<mode>` and `.env` from the working directory in Bun's order under Node too; the real environment wins. The GitHub Action runs from its own directory, so it never reads env files from the reviewed repository. `zeroDataRetention` defaults to true and also applies to gateway compilation. Gateway enforcement requires Pro/Enterprise; Hobby accounts must explicitly set it to false or use an eligible plan. No silent fallback. The Gateway model is not version-pinned.

`provider: "typesafe"` uses `POST https://api.typesafe.ai/v1/systemone`, Bearer `TYPESAFE_API_KEY`, and `model` (default `jev-1.13.0`). Compilation still needs Gateway access because Jev cannot generate rules. Direct-provider data retention is governed by the account agreement, not the Gateway flag.

## Presets

`hunch:recommended` is language-independent. `hunch:typescript` and `hunch:rust` are additive; select them alongside recommended. The language questions include file scopes, so mixed repositories can select all three without sending Rust questions for TypeScript or vice versa. TypeScript includes JS, JSX, MJS, CJS, TS, TSX, MTS and CTS; Rust matches `.rs`.

| Rule | Concern beyond linting/type checking |
| --- | --- |
| `failures/misleading-success` | A failure becomes a value or state the caller treats as successful completion, outside an intentional fallback contract. |
| `correctness/edge-case-regression` | A previously supported empty/missing/zero/boundary case breaks, evidenced by visible behavior or a contract. |
| `tests/weakened-test` | An edited test accepts a specific behavior that remains incorrect; equivalent assertions and intentional contract changes are excluded. |
| `docs/contradictory-comment` | A factual description contradicts visible implementation; prose style is irrelevant. |
| `typescript/async-ordering` | Visible overlapping operations can publish stale state or duplicate effects; merely missing `await` is insufficient. |
| `typescript/lossy-serialization` | A data conversion loses meaning a visible consumer requires; serialization itself is not a violation. |
| `rust/panic-on-recoverable-input` | Ordinary recoverable input reaches a panic contrary to the visible error contract; proven invariants and test unwraps are excluded. |
| `rust/error-context` | An error conversion erases a distinction needed by visible recovery behavior; no particular error library is required. |

All default to `warn`, with a violation threshold of 0.85. This is a conservative starting point, not a measured accuracy claim. Questions require evidence in the hunk and instruct the model not to invent missing callers or requirements. Reviews are hunk-local; cross-file or long-range bugs can be missed. Validate thresholds on your own labelled changes with `hunch eval`.

The previous entropy/off-task, naming and comment-style defaults were removed in 0.2. A task description remains available to custom questions, but no default rule infers that nearby changes are out of scope.

Change severity or disable a rule in `rules`; use `overrides` for directory-specific choices. A severity-only override preserves the question's language scope. Replacing the entire question replaces its scope too; include `files` on a custom question when needed.

## Upgrading

0.3.1 renames the package back to `@kelbie/hunch`, because publishing under `@hunch` requires owning that npm organization. If you installed the 0.3.0 preview as `@hunch/cli`, remove it, install `@kelbie/hunch`, and change helper imports to `@kelbie/hunch`. The static parser still accepts `@hunch/cli` imports during migration.

From 0.1: replace `entropy/weakened-test` with `tests/weakened-test` and `entropy/stale-comment` with `docs/contradictory-comment`; delete overrides for removed style/off-task defaults. Review changed questions before enabling them as merge gates.
