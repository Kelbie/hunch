# Rule packs

A rule pack is a set of review rules published in a GitHub repository. There are two ways to use
one: `--pack` reviews any repository against a pack with no Hunch config, no clone and nothing to
install, and a project that has a config [names its packs in it](#packs-in-the-config) so the rules
are installed into `hunch.lock` and reviewed like code. Flags: [cli.md](cli.md#hunch-check).

```sh
npx -y --min-release-age=0 @kelbie/hunch check --all --pack nuts-spec --dry-run
npx -y --min-release-age=0 @kelbie/hunch check --all --pack nuts-spec --reporter json --code > audit.json
```

Run the dry run first: it sends nothing, and prints how many chunks, questions and requests the
review needs. Then read the result as [check.md](check.md#reading-the-result) says: completeness
first, then findings grouped by rule.

## Naming a pack

The same spellings `npx skills add` uses for a skill.

| `--pack` | Reads |
| --- | --- |
| `nuts-spec` | `rules/nuts-spec.json` in `Kelbie/hunch`, the official packs |
| `owner/repo/name` | `rules/name.json` in `owner/repo`, on its default branch |
| `owner/repo/name@v2` | the same at a tag, branch or commit; pin one for a review that must be repeatable |
| `nuts-spec#nut11/*,nut12/*` | only the rules whose ids match, by id or glob |
| `owner/repo/name@v2#pay/retry` | one rule of a pinned pack |

The selection goes after `#`, never after another `/`: `a/b/c` is already a complete pack name, so
`nuts-spec/nut01/mint-pubkey-format` cannot be told apart from a pack called `mint-pubkey-format` in
the repository `nuts-spec/nut01`. Quote the argument when it contains `*`, so the shell does not
expand it: `--pack "nuts-spec#nut11/*"`. A pattern that matches no rule in the pack is an error,
and the message points at `hunch config --pack <name>` to list the ids.

GitHub serves a branch's files from a cache for about five minutes, so a pack edited a moment ago
may still load as it was. A commit (`name@<sha>`) or a tag is exact.

A private repository needs `GITHUB_TOKEN`. The run prints where its rules came from:
`hunch: rules from Kelbie/hunch/nuts-spec@HEAD`.

## Official packs

| Pack | Reviews | Rules |
| --- | --- | --- |
| `nuts-spec` | a Cashu wallet, mint or library, in any of 12 languages, against the Cashu NUTs specification: NUT-00 to NUT-30 and the error codes | 320 |
| `nips-spec` | a Nostr client, relay, signer or library, in any of 12 languages, against the Nostr NIPs: event and relay protocol, encryption, signing, payments and the deprecated NIPs | 335 |
| `bips-spec` | a Bitcoin wallet, node, signer or library, in any of 12 languages, against the Bitcoin BIPs: key derivation, addresses, segwit and taproot, PSBT, descriptors, the peer-to-peer layer and payment protocols | 356 |

Browse them at <https://github.com/Kelbie/hunch/tree/main/rules>.

## Packs in the config

`--pack` is for a repository with no Hunch setup. A repository that has one names its packs in the
config instead, and `hunch install` copies their rules into `hunch.lock`
([install.md](install.md#packs)). Reviews then read the lock: no fetch, no network, and the exact
rules that were reviewed and committed.

```ts
export default defineConfig({
  include: ["src/**"],
  packs: [
    "nuts-spec",
    { pack: "bips-spec", rules: ["bip32/*", "bip340/*", "bip174/signer-uses-only-psbt-data"] },
  ],
  rules: {
    "nut11/*": "warn",
    "bip32/fingerprint-collisions": "off",
  },
});
```

```toml
[[packs]]
pack = "nuts-spec"

[[packs]]
pack = "bips-spec"
rules = ["bip32/*", "bip340/*"]

[rules]
"nut11/*" = "warn"
```

| To | Write |
| --- | --- |
| the whole pack | `"nuts-spec"` |
| a pack from another repository | `"owner/repo/payments"` |
| a pinned version, for a policy that must not move | `"nuts-spec@v2"` or `"owner/repo/payments@<sha>"` |
| only some of its rules | `{ pack: "bips-spec", rules: ["bip32/*", "bip340/*"] }` |
| an exact rule | `{ pack: "nuts-spec", rules: ["nut11/locktime-boundary"] }` |
| the same, in one string | `"bips-spec#bip32/*,bip340/*"`, the spelling `--pack` uses |

The object form and the `#` form mean the same thing; use whichever reads better, but not both for
one pack. TOML has no object literal in an array, so `packs = ["bips-spec#bip32/*"]` is the short
way to write a selection there.

- `rules` selects by exact id or glob. A pattern that matches nothing in the pack fails `install`,
  so a mistyped id can't leave a review quietly asking less than you think.
- Selecting a subset is the way to use a large specification pack in a project that implements part
  of it. `hunch config --pack <name>` lists the ids to choose from.
- Pack rules keep their author's level, threshold and file scope. Re-level or switch one off from
  your own `rules` by id or glob; write a rule with the same id to replace its question outright.
- Your `budget` governs the run, not the pack's. Check `maxRulesPerHunk` after adding a big pack.
- The lock pins each pack to the commit it was copied from. `install` re-copies packs every time,
  so an unpinned pack follows its branch when you next run it.

## Several at once

Repeat `--pack`; every pack applies.

```sh
npx -y --min-release-age=0 @kelbie/hunch check --all --pack nuts-spec --pack acme/policy/payments@v2
```

- Each pack's rules are asked only of the files that pack's `include` names, so a markdown pack
  and a TypeScript pack do not ask each other's questions.
- The run's scope is the union of the packs' `include` and `ignore`.
- The budget is the most generous any pack asks for, so adding a pack never makes a review partial.
- When two packs define the same rule id, the later `--pack` wins. Namespace ids (`nut11/…`).

## Combining with other flags

`--pack` replaces the repository's own policy for that run, as `--config` does: its config file, its
compiled skills and AGENTS.md, and the packs it has installed are all left out, so the run asks the
named packs and nothing else. (`--rule` only adds to whichever policy applies, and keeps the lock.)
Packs named in the config work the other way: they join the repository's own rules. See
[Packs in the config](#packs-in-the-config). Layer over it:

| To | Add |
| --- | --- |
| silence a pack rule | `--config '{"rules":{"nut11/locktime-boundary":"off"}}'` (a bare level keeps the pack's question) |
| change a limit | `--config '{"budget":{"concurrency":4}}'` |
| ask one more thing | `--rule mine/extra="A plain sentence."` |
| run a few rules | `--only nut11/locktime-boundary,nut12/blindsignature-dleq-shape`, or `--only "nut11/*"` |
| see every rule a pack asks | `config --pack nuts-spec`, then `config --pack nuts-spec --explain <id>` |
| review part of the repository | paths at the end: `check --all --pack nuts-spec src/wallet` |

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
| an authentication error | [Model access](setup.md#model-access): the user runs `auth login` |
| `HTTP 402`, no credit or quota left | the user adds credit to the provider account, or signs in with another key; the message lists the commands |
