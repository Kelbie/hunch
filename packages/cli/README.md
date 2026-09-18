# Hunch 🔮

Semantic code review for the mistakes that type checkers and linters miss: failures reported as success, broken edge cases, and tests that stop catching regressions. Powered by [Jev](https://docs.typesafe.ai).

## Get PR reviews in three steps

**1. Create an API key.** In [Vercel AI Gateway](https://vercel.com/ai-gateway), choose your team → **API Keys → Create key**. Copy the key. You don't need to deploy anything to Vercel. [Key setup](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys).

**2. Save it on the repository.** From the target repository, run the command below and paste the key at the hidden prompt. Requires [GitHub CLI](https://cli.github.com) with `gh auth login` completed.

```sh
gh secret set AI_GATEWAY_API_KEY
```

**3. Install and generate the config and workflow.** From that repository, using Node 22+. For languages other than TS/JS or Rust, add `--general` to `init`:

```sh
npm install -D https://github.com/Kelbie/hunch/releases/download/v0.3.0/hunch-cli-0.3.0.tgz
npx hunch init --github
```

The package is **`@hunch/cli`**; use the release URL until npm publication. `init` selects Rust when `Cargo.toml` exists, TypeScript when `package.json` exists, and general TOML otherwise. **For Python, Go or other languages, run `npx hunch init --general --github`** (npm may have created `package.json`). Use `--ts` or `--rust` to choose explicitly. Existing configs are preserved when adding a workflow.

Commit the generated config, `.github/workflows/hunch.yml`, and dependency changes to the branch PRs target. Subsequent same-repository, non-draft PRs receive a report under **Checks → Hunch** in the Actions run summary, plus annotations. Reviews use the base branch's policy. Fork and Dependabot PRs are skipped; for those and conversation comments, [set up a GitHub App from the CLI](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md).

**Privacy setting:** Hunch defaults to enforced zero data retention, which requires Vercel Pro/Enterprise. On Hobby, explicitly add `zeroDataRetention: false` to the TS config or `zero-data-retention = false` to TOML if that matches your data policy.

**Already have skills or `AGENTS.md`?** Set the key locally as below, run `npx hunch compile`, then review and commit `hunch.lock` too. Otherwise no compilation is needed.

## Bot comments and fork PRs

[CLI App setup](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md) provisions Vercel and Redis, registers an App with the right permissions, and uploads its credentials without copying secrets. GitHub confirmation, repository installation, and Marketplace terms still require your browser. Once installed, each repository needs only its config and any compiled guidance. The hosted App uses Vercel OIDC, so no model API key is needed in those repositories.

## Presets

| Preset | What it looks for |
| --- | --- |
| `hunch:recommended` | Failures disguised as success, regressions in supported edge cases, weakened behavioral tests, comments contradicting code. Works with any language. |
| `hunch:typescript` | Async operations publishing stale results or repeating effects; serialization losing meaning a consumer needs. TS and JS files only. |
| `hunch:rust` | Recoverable input causing a panic; error conversions erasing distinctions needed for recovery. Rust files only. |

Language presets add to the general preset. `init` selects both. Mixed repositories can select all three and remove or widen the generated `include` filter. No naming, formatting, “entropy,” blanket `unwrap` bans, or other syntax checks. Findings are advisory model judgments and should be calibrated on your own changes.

TypeScript (`hunch.config.ts`):

```ts
import { defineConfig } from "@hunch/cli";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  rules: {
    "billing/retry": ["warn", "Retrying a payment must not charge the customer twice."],
  },
});
```

Rust (`hunch.toml`):

```toml
extends = ["hunch:recommended", "hunch:rust"]
include = ["**/*.rs"]
ignore = ["target/**"]
```

Use `"rule/id": "off"` to disable a rule. [All rules and configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md).

## Review locally

Export the same key in your shell or inject it through your secret manager; Hunch never stores it in config:

```sh
export AI_GATEWAY_API_KEY='your-key'
npx hunch check --base origin/main
# Or: npx hunch check --staged
```

[Sample report](https://github.com/Kelbie/hunch/blob/main/docs/sample-report.md). Text, Markdown, JSON, SARIF and Actions summaries are supported. Reports identify configured concerns and model scores; they do not claim proven defects or hide incomplete coverage.

## Add your team's skills

```sh
npx skills add mattpocock/skills --skill codebase-design --agent codex --yes
npx hunch compile
```

Review and commit the installed skills, `skills-lock.json` and `hunch.lock`. Hunch reads standard skill Markdown and scoped `AGENTS.md`; a separate text model compiles them into review questions. Normal reviews use Jev. Local paths, `owner/repo`, and GitHub skill URLs are supported. [Guidance configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md#guidance).

Hunch uses Matt Pocock's architecture skill in [its own config](https://github.com/Kelbie/hunch/blob/main/hunch.config.ts). [Architecture](https://github.com/Kelbie/hunch/blob/main/docs/architecture.md) · [Research](https://github.com/Kelbie/hunch/blob/main/docs/research.md) · [Deployment](https://github.com/Kelbie/hunch/blob/main/docs/deploy.md) · [Verified status](https://github.com/Kelbie/hunch/blob/main/docs/status.md).
