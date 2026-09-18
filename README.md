# Hunch 🔮

Code review for the mistakes type checkers and linters miss. You write rules in plain English, and [Jev](https://docs.typesafe.ai) checks every PR against them.

## Setup

Requires Node 22+ and the [GitHub CLI](https://cli.github.com).

1. Create a [Vercel AI Gateway](https://vercel.com/ai-gateway) API key: **API Keys → Create key**. You don't need to deploy anything to Vercel.
2. Save the key as a secret on your repository, then install Hunch:

```sh
gh secret set AI_GATEWAY_API_KEY
npm install -D @kelbie/hunch
npx hunch init --github    # add --general for languages other than TS/JS and Rust
```

3. Commit the generated config and `.github/workflows/hunch.yml`. PRs to that branch now get a review under **Checks → Hunch**.

On Vercel Hobby, add `zeroDataRetention: false` to your config. The zero-data-retention default requires Pro or Enterprise.

## Run locally

```sh
export AI_GATEWAY_API_KEY=...
npx hunch check --base origin/main    # or --staged
```

## Rules

`hunch.config.ts` (TypeScript) or `hunch.toml` (Rust and other languages) holds your rules. Each rule has a level: `"warn"`, `"error"` or `"off"`.

```ts
import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  rules: {
    // Plain English: flagged when a change likely breaks it.
    "api/stable-errors": ["warn", "Changing an error returned to API clients must not remove information they rely on to recover."],

    // noul: a yes/no question, flagged when P(yes) >= threshold.
    "tests/weakened": ["error", noul({
      files: ["**/*.test.ts"],
      instructions: "Does `hunk` remove or loosen an assertion without adding an equivalent check?",
      threshold: 0.8,
    })],

    // choice: Jev picks one label; labels listed in `report` are flagged.
    "errors/handling": ["warn", choice({
      instructions: "How does the changed code in `hunk` handle a failed operation?",
      criteria: {
        propagated: "The failure reaches the caller.",
        recovered: "The failure is handled with a deliberate, visible fallback.",
        swallowed: "The failure is ignored or logged, and execution continues as if it succeeded.",
      },
      report: ["swallowed"],
    })],

    // score: ordered levels from worst to best; flagged below reportBelow (0–1).
    "tests/specific": ["warn", score({
      files: ["**/*.test.ts"],
      instructions: "How precisely do the tests changed in `hunk` pin down the behavior they cover?",
      criteria: [
        "They only check that the code runs without throwing.",
        "They check broad properties, such as a result being defined or non-empty.",
        "They check exact outputs for the main case.",
        "They check exact outputs, including edge cases and failures.",
      ],
      reportBelow: 0.5,
    })],
  },
});
```

In `hunch.toml`, write the same rules as tables:

```toml
[rules."errors/handling"]
level = "warn"
choice = "How does the changed code in `hunk` handle a failed operation?"
criteria = { propagated = "...", recovered = "...", swallowed = "..." }
report = ["swallowed"]
```

Presets cover common problems. `hunch:recommended` works with any language, and `hunch:typescript` and `hunch:rust` add checks for those languages. See [configuration](docs/configuration.md) for every option, including `when`, `reference`, `overrides` and budgets.

## Skills and AGENTS.md

Hunch reviews against your installed [Agent Skills](https://github.com/vercel-labs/skills) and `AGENTS.md` files. `hunch compile` turns them into rules and saves them in `hunch.lock`:

```sh
npx skills add mattpocock/skills --skill codebase-design
npx hunch compile    # review and commit hunch.lock
```

To use only specific skills, list them. A skill can be a local path, `owner/repo`, or a GitHub URL:

```ts
skills: ["./.agents/skills/codebase-design", "mattpocock/skills"],
```

## More

- [GitHub App](docs/cli-setup.md): bot comments, `/hunch recheck`, and fork PRs
- [Sample report](docs/sample-report.md)
- [Architecture](docs/architecture.md)

Findings are the model's judgment, not proven defects. Hunch reviews one diff hunk at a time, so bugs that span several files can be missed.
