# Hunch 🔮

Ask a plain-English question across a repository without guessing which words the code uses.
Hunch sends each in-scope chunk to [Jev](https://docs.typesafe.ai) and returns scored source
locations for a person or coding agent to investigate. It also runs recurring review rules on diffs.

## Use with your coding agent

```sh
npx skills add Kelbie/hunch
```

The [Agent Skill](skills/hunch/SKILL.md) explains when to search, how to phrase a question, and how
to verify the results. No project config is needed for an ad hoc search. Requires Node 22+, Git,
and provider authentication: run `npx -y --min-release-age=0 @kelbie/hunch auth login` once and Hunch works in every
directory (`--vercel` reuses a Vercel CLI login instead of a key).

```sh
# Gather implementation, callers, contracts, tests and precedents for a change.
npx -y --min-release-age=0 @kelbie/hunch find "add cancellation to file uploads"

# Look for an existing behavior, regardless of its names.
npx -y --min-release-age=0 @kelbie/hunch find "Does this code turn a failed operation into a successful result?" --mode condition

# Get structured evidence for an agent; include every above-threshold match.
npx -y --min-release-age=0 @kelbie/hunch find "Does this code retry a side effect?" --mode condition --top 0 --reporter json

# Review any repository against a published rule pack: no config, no clone.
npx -y --min-release-age=0 @kelbie/hunch check --all --pack nuts-spec --dry-run

# Review a branch with a one-off rule.
npx -y --min-release-age=0 @kelbie/hunch check --rule errors="Preserve failures that callers need to handle."
```

Use `rg` for exact symbols and text. Use Hunch when the behavior may have many implementations
or names. Read the returned source and follow its dependencies before drawing a conclusion.

## Recurring audits

Run `npx -y --min-release-age=0 @kelbie/hunch init` to configure plain-English or typed questions. Run them locally with
`check`, across whole files with `check --all`, or on pull requests through GitHub Actions or the
GitHub App. PR policy comes from the immutable base commit.

[Installation](skills/hunch/references/install.md) · [Rule packs](skills/hunch/references/packs.md) · [Writing rules](skills/hunch/references/rules.md) ·
[Configuration](skills/hunch/references/config.md) · [CLI reference](skills/hunch/references/cli.md)

## What the results mean

Search scores rank candidates; findings flag configured concerns. Neither proves a bug or the
absence of one. A complete run means the selected chunks were evaluated, not that every relevant
behavior was found. Reports identify omissions and distinguish result limits from search coverage.

Code is sent to the selected provider. Cost depends on input tokens, repeated context and questions;
small model prices make broad scans practical, but latency and recall still need measurement.

[Search workflow](skills/hunch/references/find.md) · [Architecture](docs/architecture.md) ·
[Research and evaluation design](docs/semantic-search-research.md) · [Deployment](docs/deploy.md)
