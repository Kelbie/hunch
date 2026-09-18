# Hunch 🔮

Semantic code review with [Jev](https://docs.typesafe.ai). Write rules in plain English, reuse Agent Skills, and get a readable report locally or on a GitHub pull request.

Hunch checks concerns such as **“does this error path pretend the operation succeeded?”** or **“does this interface make callers manage internal bookkeeping?”** Keep formatting, unused imports, forbidden syntax and type errors in your linter and compiler.

## Install in a project

Requires Node 22+. Install the preview package from GitHub Releases (npm registry publication is pending):

```sh
npm install --save-dev https://github.com/Kelbie/hunch/releases/download/v0.1.0/kelbie-hunch-0.1.0.tgz
npx hunch init                        # TypeScript config; detects Cargo for Rust
# Set AI_GATEWAY_API_KEY in your shell or secret manager.
npx hunch check --base origin/main
```

Create the key in [Vercel AI Gateway](https://vercel.com/ai-gateway). No Vercel deployment is needed for local use. Hunch never writes the key to project config. Gateway-enforced zero data retention is enabled by default and requires Vercel Pro/Enterprise; Hobby users must deliberately set `zeroDataRetention: false` (`zero-data-retention = false` in TOML) or use an eligible account. Hunch never silently downgrades it.

After npm publication, the install command becomes `npm install -D @kelbie/hunch`. To build from source:

```sh
bun install --frozen-lockfile
bun run build
(cd packages/cli && npm pack --ignore-scripts)
# In your project: npm install -D /path/to/hunch/packages/cli/kelbie-hunch-0.1.0.tgz
```

The distributed CLI runs under Node; Bun is only needed to build Hunch itself.

## Plain-English configuration

TypeScript projects use **hunch.config.ts**:

```ts
import { defineConfig } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended"],
  include: ["**/*.{ts,tsx}"],
  rules: {
    "errors/preserve-failure": ["warn",
      "A failed operation must not be presented to the caller as a successful empty result."],
  },
});
```

Rust projects use **hunch.toml**, with kebab-case configuration keys:

```toml
extends = ["hunch:recommended"]
include = ["**/*.rs"]
ignore = ["target/**"]

[rules]
"errors/preserve-context" = ["warn", "Error conversions should preserve the cause needed for the caller to distinguish recovery from retry."]
```

Both formats use one engine, and TOML works for any language. TypeScript config is parsed as data: it supports literals and Hunch helpers, never arbitrary execution. Use exactly one config file. See [configuration](docs/configuration.md) for thresholds, scopes, provider options and limits.

## Reuse skills and AGENTS.md

Install standard project skills with the existing [Skills CLI](https://skills.sh/docs/cli):

```sh
npx skills add mattpocock/skills --skill codebase-design --agent codex --yes
npx hunch compile
```

Review and commit `.agents/skills/`, `skills-lock.json` and `hunch.lock`. The compiler reads selected skill Markdown and scoped `AGENTS.md`, uses a separate text model to produce atomic review questions, and records guidance it cannot check. Normal reviews use Jev only. Jev does not search, run skills, or generate explanations.

You can also select a local skill or a GitHub source directly:

```ts
skills: [
  "./.agents/skills/codebase-design",
  // Or: { repo: "mattpocock/skills", skill: "codebase-design" }
  // Or a GitHub https://github.com/owner/repo/tree/<ref>/<skill-path> URL
]
```

Remote sources resolve to commits during compilation. Installed sources and effective parent/child AGENTS guidance are hashed; outdated or missing compilation is reported. Nested AGENTS exceptions take precedence when compiling the effective guidance for their directory. Review this interpretation in the lock.

Hunch uses these conventions itself: [config](hunch.config.ts), [reviewed policy](hunch.lock), and [installed skills](.agents/skills). Its initial lock was curated from the skills by an agent and reviewed during implementation; it is explicitly labelled `human-reviewed:initial-policy`, not presented as a live compiler result.

## Reports without a pull request

```sh
npx hunch check --staged
npx hunch check --diff change.diff --reporter markdown > review.md
npx hunch check --base origin/main --task "Preserve failed payment state"
npx hunch eval examples/fixtures
```

Reports include rule, source location, concern, model score and coverage. [See a real Jev report on synthetic code](docs/sample-report.md). Text, Markdown, JSON, SARIF and GitHub Actions summaries are available. Example below is **illustrative, not a measured Jev result**:

| Level | Concern | Location | Evidence |
|---|---|---|---|
| Warning | Preserve failures that callers need to handle | `src/pay.ts:42` | `p(yes)=0.91 ≥ 0.75` |

Messages describe configured concerns; they are not model-written explanations. Locations identify the reviewed hunk, not a proven offending line. Local review includes tracked working-tree changes; stage new files or supply a diff to include them.

## Automatic PR review

Install your self-hosted Hunch GitHub App on a repository containing a committed config. It creates a check and a report per reviewed commit on opened, updated, reopened and ready-for-review PRs. Drafts are skipped. Writers can request `/hunch recheck`.

The one-time App setup uses **Vercel Functions + Queues**, a small **Upstash Redis** lease store, and GitHub App credentials. [Deployment guide](docs/deploy.md) gives the exact setup. Vercel-hosted Gateway calls use OIDC; no model key is needed there. CLI users only need a model key.

An optional [GitHub Action](action.yml) writes annotations and a job summary. It reads **all policy from the base commit**, executes no PR config, and does not need comment-write permissions. Fork PRs normally cannot access model secrets; use the App for fork reviews. [Workflow examples](docs/deploy.md#github-actions).

## What a result means

A complete review means the applicable configured checks ran. It does **not** certify the whole skill, repository architecture or correctness. Review requests are bounded; missing answers fail, and skipped work is marked partial. Findings are advisory by default. `failOnError: true` makes error-level findings fail the check. CLI exit codes: `0` completed without blocking findings, `1` blocking findings, `2` incomplete review or operational/config error.

Code and selected reference content leave your machine for the configured provider. Compilation separately sends guidance to the configured text model. Gateway calls request zero data retention; direct TypeSafe retention depends on your account agreement. Source code can influence Jev through prompt injection. Use labelled fixtures to measure your rules before making them mandatory.

## Develop

```sh
bun install --frozen-lockfile
bun run check
node scripts/package-smoke.mjs
```

[Research and API contracts](docs/research.md) · [Architecture and rejected alternatives](docs/architecture.md) · [Configuration](docs/configuration.md) · [Deployment](docs/deploy.md)
