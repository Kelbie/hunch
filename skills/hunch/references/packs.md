# Rule packs

A rule pack is a set of review rules published in a GitHub repository. `--pack` reviews any
repository against one, with no Hunch config, no clone and nothing to install. Flags:
[cli.md](cli.md#hunch-check).

```sh
npx -y --min-release-age=0 @kelbie/hunch check --all --pack cashu-conformance --dry-run
npx -y --min-release-age=0 @kelbie/hunch check --all --pack cashu-conformance --reporter json --code > audit.json
```

Run the dry run first: it sends nothing, and prints how many chunks, questions and requests the
review needs. Then read the result as [check.md](check.md#reading-the-result) says: completeness
first, then findings grouped by rule.

## Naming a pack

The same spellings `npx skills add` uses for a skill.

| `--pack` | Reads |
| --- | --- |
| `cashu-nuts` | `rules/cashu-nuts.json` in `Kelbie/hunch`, the official packs |
| `owner/repo/name` | `rules/name.json` in `owner/repo`, on its default branch |
| `owner/repo/name@v2` | the same at a tag, branch or commit; pin one for a review that must be repeatable |

GitHub serves a branch's files from a cache for about five minutes, so a pack edited a moment ago
may still load as it was. A commit (`name@<sha>`) or a tag is exact.

A private repository needs `GITHUB_TOKEN`. The run prints where its rules came from:
`hunch: rules from Kelbie/hunch/cashu-conformance@HEAD`.

## Official packs

| Pack | Reviews | Rules |
| --- | --- | --- |
| `cashu-conformance` | a Cashu wallet, mint or library, in any of 12 languages, against NUT-00 to NUT-30 and the error codes | 320 |
| `cashu-nuts` | the NUTs specification text itself: `NN.md`, `tests/`, `suppl/`, `error_codes.md` | 11 |

Browse them at <https://github.com/Kelbie/hunch/tree/main/rules>.

## Several at once

Repeat `--pack`; every pack applies.

```sh
npx -y --min-release-age=0 @kelbie/hunch check --all --pack cashu-conformance --pack acme/policy/payments@v2
```

- Each pack's rules are asked only of the files that pack's `include` names, so a markdown pack
  and a TypeScript pack do not ask each other's questions.
- The run's scope is the union of the packs' `include` and `ignore`.
- The budget is the most generous any pack asks for, so adding a pack never makes a review partial.
- When two packs define the same rule id, the later `--pack` wins. Namespace ids (`nut11/…`).

## Combining with other flags

`--pack` replaces the repository's own config for that run, as `--config` does, and compiles no
skills or AGENTS.md. Layer over it:

| To | Add |
| --- | --- |
| silence a pack rule | `--config '{"rules":{"nut11/locktime-boundary":"off"}}'` (a bare level keeps the pack's question) |
| change a limit | `--config '{"budget":{"concurrency":4}}'` |
| ask one more thing | `--rule mine/extra="A plain sentence."` |
| run a few rules | `--only nut11/locktime-boundary,nut12/blindsignature-dleq-shape` |
| see every rule a pack asks | `config --pack cashu-conformance`, then `config --pack cashu-conformance --explain <id>` |
| review part of the repository | paths at the end: `check --all --pack cashu-conformance src/wallet` |

Without `--all`, `check --pack <name>` reviews only what this branch changed against `origin/main`.

## Publishing a pack

Add `rules/<name>.json` to any GitHub repository. It is a Hunch config as JSON
([config.md](config.md), [rules.md](rules.md)):

```json
{
  "include": ["**/*.ts", "**/*.rs"],
  "ignore": ["**/dist/**"],
  "budget": { "maxHunks": 100000, "maxRequests": 200000, "concurrency": 16, "timeoutSeconds": 43200 },
  "rules": {
    "pay/retry": ["error", "Does this change let a retry repeat a payment?"],
    "pay/amount": { "level": "warn", "noul": "Does an amount lose its unit?", "files": ["src/pay/**"] }
  }
}
```

- Set `include` to the files the rules are about: it becomes the scope of every rule in the pack
  that names no `files` of its own.
- Give it a budget large enough for a whole repository. People run packs on code they did not size.
- A pack may not set `provider`, `model`, `zeroDataRetention`, `compileModel`, `skills`, `docs`,
  `agentsMd` or `failOnError`. Those decide where code is sent and what a failure costs, which
  belong to whoever runs the review; a pack that sets one is refused.
- Test it before publishing: `check --all --config rules/<name>.json --dry-run`, then `config --config rules/<name>.json`.

A pack is fetched as data and validated against the config schema. Nothing in it is executed.

## Errors

| stderr | Do |
| --- | --- |
| `--pack: no rules/<name>.json in <repo>@<ref>` | check the name against the repository's `rules/` folder; the message links to it |
| `--pack "<x>" should be a pack name…` | use `name` or `owner/repo/name`, with an optional `@ref` |
| `--pack <name> may not set "<key>"` | the pack's author must remove it; set it yourself with `--config` |
| `--pack: GitHub answered 403/429/5xx` | try again shortly, or set `GITHUB_TOKEN`; a downloaded copy works with `--config <file>` |
| an authentication error | [Model access](install.md#model-access): the user runs `auth login` |
| `HTTP 402`, no credit or quota left | the user adds credit to the provider account, or signs in with another key; the message lists the commands |
