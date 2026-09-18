# Hunch 🔮

Code review for the mistakes type checkers and linters miss. You write rules in plain English, and [Jev](https://docs.typesafe.ai) checks your code against them, locally or on every PR.

![Hunch reviewing a branch with check --all](docs/images/check-all.png)

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

Commit the config and workflow. PRs then get a review under **Checks → Hunch**. For bot comments and fork PRs, use the [GitHub App](docs/cli-setup.md) instead.

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

## Rules

Rules live in `hunch.config.ts` or `hunch.toml`. Each has a level: `"warn"`, `"error"` or `"off"`.

```ts
import { defineConfig, noul } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  rules: {
    "api/stable-errors": ["warn", "Changing an error returned to API clients must not remove information they rely on to recover."],
    "tests/weakened": ["error", noul({
      files: ["**/*.test.ts"],
      instructions: "Does `hunk` remove or loosen an assertion without adding an equivalent check?",
      threshold: 0.8,
    })],
  },
});
```

| Rule type | Flags a change when… |
| --- | --- |
| Plain English | Jev thinks the change likely breaks the sentence. |
| `noul` | The answer to your yes/no question is likely "yes". |
| `choice` | Jev picks one of the labels you listed in `report`. |
| `score` | The change scores below (or above) your threshold on a scale you define. |

Presets: `hunch:recommended` (any language), `hunch:typescript`, `hunch:rust`. Every option is in [configuration](docs/configuration.md).

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

- [Configuration](docs/configuration.md): every option, presets and budgets
- [GitHub App](docs/cli-setup.md): bot comments, `/hunch recheck` and fork PRs
- [Sample PR report](docs/sample-report.md)
- [Architecture](docs/architecture.md)
