# Hunch 🔮

Code review for the mistakes type checkers and linters miss. You write rules in plain English, and [Jev](https://docs.typesafe.ai) checks your code against them, locally or on every PR.

![Hunch reviewing a branch with check --all](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/check-all.png)

## Getting started

You need Node 22+ and a [Vercel AI Gateway](https://vercel.com/ai-gateway) API key (**API Keys → Create key**). You don't deploy anything to Vercel. Hunch reads `AI_GATEWAY_API_KEY` from your environment, `.env.local` or `.env`.

```sh
npx @kelbie/hunch init            # 1. write hunch.config.ts (or hunch.toml for Rust and other languages)
npx @kelbie/hunch check           # 2. review this branch against origin/main
```

That's it. The config starts with ready-made checks (presets). Add your own rules when you're ready.

**Review every PR on GitHub:**

```sh
gh secret set AI_GATEWAY_API_KEY
npx @kelbie/hunch init --github   # adds .github/workflows/hunch.yml
```

Commit the config and workflow. PRs then get a review under **Checks → Hunch**, with each concern marked on the changed lines. For review comments and fork PRs, use the [GitHub App](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md) instead.

> On Vercel Hobby, add `zeroDataRetention: false` (TOML: `zero-data-retention = false`) to your config. The default needs Pro or Enterprise.

## Commands

| Command | What it does |
| --- | --- |
| `check` | Reviews the lines changed on this branch (and uncommitted work) vs `origin/main`. |
| `check --staged` | Reviews staged changes only. |
| `check --base main --head feature/x` | Reviews the difference between two branches, without checking out. |
| `check --all [path]` | Reviews whole files, not just changes. Use a folder to keep it small. |
| `check --all --dry-run` | Counts files and questions without sending anything. |
| `compile` | Turns your skills and `AGENTS.md` into review questions, saved in `hunch.lock`. [Why?](#skills-and-agentsmd) |
| `init [--ts\|--rust\|--general] [--github]` | Writes a starter config, and optionally a PR workflow. |
| `eval <dir>` | Measures each rule's precision and recall on labelled `.diff` examples. |
| `app --help` | Sets up a self-hosted GitHub App. |

Run each as `npx @kelbie/hunch <command>`. Every `check` also takes paths to narrow the review, and `--reporter text|markdown|json|sarif|github`.

## On pull requests

With the [GitHub App](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md), each concern is a normal review comment on the changed lines, so it shows the real diff and you can reply to it. One summary comment lists them all, errors first, linking to each thread.

- **Not relevant?** Resolve the conversation. Hunch won't raise that rule in that file again on this PR. Only resolutions by people with write access count.
- **Fixed it?** Push. Hunch resolves its own comments for concerns that are gone.
- **Want a fresh look?** Comment `/hunch recheck`.

## Rules

Rules live in `hunch.config.ts` or `hunch.toml`. Each has a level: `"warn"`, `"error"` or `"off"`. This example shows every kind of setting; you only need `extends` and a few rules to start.

```ts
import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  // Ready-made checks. Change or turn off any of them under `rules`.
  extends: ["hunch:recommended", "hunch:typescript"],

  // Which files are reviewed. Lockfiles, minified files and node_modules are always skipped.
  include: ["src/**"],
  ignore: ["src/generated/**"],

  rules: {
    // Plain English: flagged when a change likely breaks the sentence.
    "api/stable-errors": ["warn", "Changing an error returned to API clients must not remove information they rely on to recover."],

    // noul: a yes/no question, flagged when P(yes) >= threshold.
    "tests/weakened": ["error", noul({
      instructions: "Does `hunk` remove or loosen an assertion without adding an equivalent check?",
      criteria: { true: "An assertion is deleted or made looser.", false: "Assertions are unchanged, stricter or only renamed." },
      threshold: 0.8,
      files: ["**/*.test.ts"],            // only ask about these files
      when: /expect|assert/,              // only ask when the change matches (saves requests)
      message: "A test may have been weakened.",  // what reviewers see
    })],

    // choice: Jev picks one label; labels listed in `report` are flagged.
    "payments/retry-safety": ["error", choice({
      instructions: "If the payment call in `hunk` is retried, what happens to the customer?",
      criteria: {
        "safe": "Retries reuse the same idempotency key, so the customer is charged once.",
        "duplicate-charge": "A retry can charge the customer again.",
        "not-applicable": "The change does not retry a payment.",
      },
      report: ["duplicate-charge"],
      minConfidence: 0.5,
      reference: "docs/api-contracts.md",  // a file from the base branch sent along as context
    })],

    // score: ordered levels, worst to best; flagged below reportBelow (0–1).
    "tests/specific": ["warn", score({
      instructions: "How precisely do the tests changed in `hunk` pin down the behavior they cover?",
      criteria: [
        "They only check that the code runs without throwing.",
        "They check broad properties, such as a result being defined.",
        "They check exact outputs for the main case.",
        "They check exact outputs, including edge cases and failures.",
      ],
      reportBelow: 0.5,
      files: ["**/*.test.ts"],
    })],

    // Change a preset's level, or turn it off.
    "docs/contradictory-comment": "error",
    "typescript/lossy-serialization": "off",
  },

  // Different levels for some folders.
  overrides: [{ files: ["scripts/**"], rules: { "api/stable-errors": "off" } }],

  // Guidance to compile into hunch.lock (see "Skills and AGENTS.md").
  skills: ["./.agents/skills/codebase-design", "mattpocock/skills"],  // omit to use every installed skill; [] for none
  agentsMd: true,
  docs: ["docs/api-contracts.md"],

  failOnError: true,       // fail the check when an error-level concern is found
  task: "pr",              // send the PR title and description as context ("none" to skip)
  zeroDataRetention: true, // set false on Vercel Hobby
  budget: { maxHunks: 100, maxRequests: 100, timeoutSeconds: 180 },
});
```

| Rule type | Flags a change when… |
| --- | --- |
| Plain English | Jev thinks the change likely breaks the sentence. |
| `noul` | The answer to your yes/no question is likely "yes". |
| `choice` | Jev picks one of the labels you listed in `report`. |
| `score` | The change scores below (or above) your threshold on a scale you define. |

Every rule type also takes `files`, `when`, `reference` and `message`. In `hunch.toml` the same rules are tables, with kebab-case option names:

```toml
extends = ["hunch:recommended", "hunch:rust"]
fail-on-error = true

[rules."payments/retry-safety"]
level = "error"
choice = "If the payment call in `hunk` is retried, what happens to the customer?"
criteria = { safe = "...", duplicate-charge = "...", not-applicable = "..." }
report = ["duplicate-charge"]
```

Presets: `hunch:recommended` (any language), `hunch:typescript`, `hunch:rust`. Every option is explained in [configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md).

## Skills and AGENTS.md

Your [Agent Skills](https://github.com/vercel-labs/skills) and `AGENTS.md` often contain good review rules. But they're long prose written for coding agents, and **Jev can only answer short yes/no questions**. So they need converting first:

| | Config rules | Skills and `AGENTS.md` |
| --- | --- | --- |
| Written as | One question each | Pages of prose |
| Jev can use them | Directly | After `compile` |
| Stored in | `hunch.config.ts` / `hunch.toml` | `hunch.lock` |

`compile` sends each skill and `AGENTS.md` to Claude Code or Codex on your machine (you pick from a menu). It writes the questions to `hunch.lock`. Guidance that can't be checked from one change is listed there as `notChecked`.

**Why save the questions in a file instead of generating them on every run?**

- **Same questions every time.** An LLM gives a different list each run. Saved questions make reviews repeatable.
- **You can read what's enforced.** Review `hunch.lock` like code. Edit or delete questions you don't want.
- **CI only needs Jev.** No Claude or Codex login in CI, and each PR is reviewed with the lock from its base branch.

**How often do I compile?** Once, then commit `hunch.lock`. After that, just run `check`. Compile again only when `check` says the lock is stale, because you edited `AGENTS.md` or changed a skill. Only changed sources are recompiled.

```sh
npx skills add mattpocock/skills --skill codebase-design
npx @kelbie/hunch compile         # review hunch.lock, then commit it
```

Without a lock, `check` still runs your config rules and presets, but marks the review as partial because your skills weren't checked. Don't want skills reviewed? Set `skills: []` and `agentsMd: false`.

## Good to know

- Findings are Jev's judgment, not proven bugs.
- Hunch reviews one change (hunk) or chunk at a time, so it can miss bugs that depend on other files. Give a rule the file it needs with `reference`.
- Lockfiles, minified files, source maps and `node_modules` are always skipped. Add more with `ignore`.

## More

- [Configuration](https://github.com/Kelbie/hunch/blob/main/docs/configuration.md): every option, presets and budgets
- [GitHub App](https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md): bot comments, `/hunch recheck` and fork PRs
- [Sample PR report](https://github.com/Kelbie/hunch/blob/main/docs/sample-report.md)
- [Architecture](https://github.com/Kelbie/hunch/blob/main/docs/architecture.md)
