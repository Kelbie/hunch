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

On Vercel Hobby, add `zeroDataRetention: false` (TOML: `zero-data-retention = false`) to your config. The zero-data-retention default requires Pro or Enterprise. AI Gateway's free tier is rate limited and can fail reviews of larger PRs; buying any amount of credits removes the limit.

## Run locally

```sh
export AI_GATEWAY_API_KEY=...
npx hunch check --base origin/main    # or --staged
```

Hunch also reads the key from `.env.local` or `.env` in the current directory, and works the same under `npx`, `bunx` and `bun run`.

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

Presets cover common problems. `hunch:recommended` works with any language, and `hunch:typescript` and `hunch:rust` add checks for those languages. See [configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md) for every option, including `when`, `reference`, `overrides` and budgets.

## Skills and AGENTS.md

Hunch can also review against your [Agent Skills](https://github.com/vercel-labs/skills) and `AGENTS.md` files. Jev only answers questions; it can't read a skill and work out what to check. So skills take two steps:

1. **`hunch compile`** (once, and again when guidance changes) sends each skill and `AGENTS.md` to a general LLM, `anthropic/claude-sonnet-5` by default (set `compileModel` to change it). The LLM writes yes/no review questions and Hunch saves them in `hunch.lock`. This step doesn't touch your code.
2. **`hunch check`** and PR reviews send those questions, along with your rules, to Jev. They never call the compile model.

```sh
npx skills add mattpocock/skills --skill codebase-design
npx hunch compile    # review the hunch.lock diff, then commit it
```

`hunch.lock` is your review policy, so read it like code. Guidance that can't be judged from a single diff hunk is listed there as needing human review, and `check` warns when the lock is out of date.

To use only specific skills, list them. A skill can be a local path, `owner/repo`, or a GitHub URL:

```ts
skills: ["./.agents/skills/codebase-design", "mattpocock/skills"],
```

## More

- [GitHub App](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md): bot comments, `/hunch recheck`, and fork PRs
- [Sample report](https://github.com/Kelbie/hunch/blob/main/docs/sample-report.md)
- [Architecture](https://github.com/Kelbie/hunch/blob/main/docs/architecture.md)

Findings are the model's judgment, not proven defects. Hunch reviews one diff hunk at a time, so bugs that span several files can be missed.
