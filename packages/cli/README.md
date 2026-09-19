# Hunch 🔮

Code review for the mistakes type checkers and linters miss. You write rules in plain English, and
[Jev](https://docs.typesafe.ai) checks your code against them — locally, or on every pull request.

![Hunch reviewing a branch with check --all](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/check-all.png)

## Let your coding agent drive

The documentation is an [Agent Skill](https://github.com/Kelbie/hunch/blob/main/skills/hunch/SKILL.md). Install it, and your coding agent knows
every command, every flag, what the output means, and how to turn "flag changes that…" into a rule
Jev can answer:

```sh
npx skills add Kelbie/hunch
```

| Ask your agent | It will |
| --- | --- |
| `/hunch install` on GitHub | pick the App or Actions path, write the config, and tell you the one click only you can do |
| `/hunch rules` flag retries that could double-charge a customer | choose `noul`, `choice` or `score`, write it, and prove it valid with `hunch config --explain` |
| `/hunch rules` no `console.log` in src | tell you that's a lint rule, not a Hunch rule, and write the lint rule instead |
| `/hunch check` this branch | dry-run first, then review, and report what was and wasn't covered |
| `/hunch find` add a rate limit to uploads | hand itself the code that change touches, and any open PR already doing it |
| `/hunch doctor` my PR got no review | name the missing piece |

`npx @kelbie/hunch init` offers to install the skill too.

## Try it on a repository that has never heard of Hunch

No config, no install, no setup. Describe a rule on the command line and review the branch you are on:

![Reviewing a branch with two rules passed on the command line](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/check-rules.png)

```sh
npx @kelbie/hunch check --rule api/errors="Error responses keep their code field."
npx @kelbie/hunch check --config rules.json          # the same options as a config file, as JSON
npx @kelbie/hunch check --dry-run                    # what would be sent; spends nothing
```

## Install

**Node 22+.** Then pick where reviews run. `npx @kelbie/hunch init` asks, with arrow keys, or takes
every answer as a flag.

| Path | You do | You need |
| --- | --- | --- |
| **Every PR, via the GitHub App** | [install the App](https://github.com/apps/hunch-review/installations/new), `npx @kelbie/hunch init --target app`, merge the config to your default branch | nothing else: no key, no workflow |
| **Every PR, via GitHub Actions** | `npx @kelbie/hunch init --target actions`, `gh secret set AI_GATEWAY_API_KEY`, merge both files | a [Vercel AI Gateway](https://vercel.com/ai-gateway) key |
| **On your machine** | `npx @kelbie/hunch init --target local`, then `npx @kelbie/hunch check` | a model key in `AI_GATEWAY_API_KEY` |

Hunch reads its rules from the PR's base branch, so the PR that adds Hunch is skipped. That is
expected. No review after that? `npx @kelbie/hunch doctor` names the missing piece. Details:
[install](https://github.com/Kelbie/hunch/blob/main/skills/hunch/references/install.md).

## Commands

| You have | You want | Run |
| --- | --- | --- |
| a repo and an idea | set Hunch up | `hunch init` |
| a config you edited | know it is valid, and what each rule asks | `hunch config`, `hunch config --explain <rule>` |
| `hunch.config.ts` in the repo | review this branch | `hunch check` |
| `hunch.config.ts` in the repo | review whole files, not just changes | `hunch check --all src` |
| a new rule | try just that rule | `hunch check --only <rule> --dry-run` |
| skills or `AGENTS.md` | turn them into rules | `hunch compile` |
| a change to make | find the code it touches | `hunch find "…"` |
| a PR with no review on it | find out why | `hunch doctor` |
| labelled example diffs | measure a rule's precision | `hunch eval <dir>` |

Run any of them as `npx @kelbie/hunch <command>`. Each takes `--help`. The skill's
[CLI reference](https://github.com/Kelbie/hunch/blob/main/skills/hunch/references/cli.md) is generated from the CLI, and
[examples](https://github.com/Kelbie/hunch/blob/main/skills/hunch/examples) are captured from real runs.

![hunch find ranking a repository against a task, and checking open PRs for the same work](https://raw.githubusercontent.com/Kelbie/hunch/main/docs/images/find.png)

## Rules

```ts
import { choice, defineConfig, noul } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  rules: {
    "api/stable-errors": ["error", "Error responses keep their code field, because clients branch on it."],
    "payments/retry-safety": ["error", choice({
      instructions: "If the payment call in `hunk` is retried, what happens to the customer?",
      criteria: {
        "safe": "Retries reuse the same idempotency key, so the customer is charged once.",
        "duplicate-charge": "A retry can charge the customer again.",
        "not-applicable": "The change does not retry a payment.",
      },
      report: ["duplicate-charge"],
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

Rust and other projects use `hunch.toml` with the same options. Writing good rules is covered in
[rules](https://github.com/Kelbie/hunch/blob/main/skills/hunch/references/rules.md), and every setting in [config](https://github.com/Kelbie/hunch/blob/main/skills/hunch/references/config.md).

## On pull requests

- **Not relevant?** Resolve the conversation. Hunch won't raise that rule in that file again on this
  PR. Only resolutions by people with write access count.
- **Fixed it?** Push. Hunch resolves its own comments for concerns that are gone.
- **Want a fresh look?** Comment `/hunch recheck`.

## Good to know

Findings are model judgments, not proven bugs. Treat them as a second reader, not a gate, until you
have tuned your rules with `hunch eval`. Incomplete coverage is always reported, never
hidden. Your code is sent to the model provider you configure; no key is ever written into your
config.

## More

[Skill](https://github.com/Kelbie/hunch/blob/main/skills/hunch/SKILL.md) · [Architecture](https://github.com/Kelbie/hunch/blob/main/docs/architecture.md) ·
[Run your own App](https://github.com/Kelbie/hunch/blob/main/skills/hunch/references/operator.md) · [Deploy](https://github.com/Kelbie/hunch/blob/main/docs/deploy.md) · [Sample report](https://github.com/Kelbie/hunch/blob/main/docs/sample-report.md)
