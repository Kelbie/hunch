# hunch find

`check` asks whether code is wrong. `find` asks **where the code is**: it scores every chunk of the
repository against a change the user is about to make, and prints the matching source. Use it
before starting work, to hand yourself or another agent the right context. Real output:
[examples/find.md](../examples/find.md). Flags: [cli.md](cli.md#hunch-find).

## What it asks

Each chunk gets five yes/no questions in one request. Every probability is kept.

| Facet | Question asked of every chunk |
| --- | --- |
| `edit` | Would carrying out the task require editing these lines? |
| `contract` | Does this define the value, limit or type the task hinges on? |
| `caller` | Does this consume the behaviour that would change? |
| `test` | Does this test the area, so it would need updating or would catch a mistake? |
| `precedent` | Does this already solve the same kind of problem somewhere else? |

Matches are grouped by their strongest facet. `--top` (default 12) applies **per facet**, so the one
test worth updating isn't crowded out by definitions. `--min` (default 0.5) drops weak matches.
`--facet edit,test` narrows the answer; it doesn't lower the cost.

## Running it

| The user wants | Command |
| --- | --- |
| the code for a task | `find "add a rate limit to the upload endpoint"` |
| it as context for an agent | `find "…" --reporter markdown > context.md`. Markdown is also the default when output is redirected |
| to know if someone's already on it | `find "…" --prs` (needs `gh` and a github.com `origin`) |
| a narrower search | paths as arguments: `find "…" src/api` |
| another branch | `--head <ref>` |
| the cost first | `--dry-run`: chunks, requests and questions. With `--prs` it adds one request per open PR title, and up to `--pr-max` diff reads, which it can't count until the PRs are listed |

`find` needs no rules and no config. With no config it searches every file except lockfiles,
minified files and `node_modules`, and says so on stderr. With a config it uses `include`/`ignore`
and the provider settings, and ignores `budget`: it has `--concurrency` (default 8, max 32) and a
one-hour ceiling. One request per chunk.

## `--prs`

Open PRs' titles are judged first, one cheap request each. Only titles scoring above 0.5 have their
diff read (at most `--pr-max`, default 10; drafts only with `--drafts`). Each read diff is judged
`duplicate` (already makes the change) or `overlap` (edits the same code). Anything that couldn't be
listed, read or judged becomes a notice, and the run is incomplete. "No duplicate found" and "couldn't
check" are never reported the same way.

## Output

| `--reporter` | Contains |
| --- | --- |
| `text` (terminal default) | coloured groups by facet, each passage cut at `--lines` (40), plus existing PRs first |
| `markdown` (redirect default) | every matched passage in full under a `file:start-end` heading; touching chunks of one file are merged |
| `json` | `{ matches, stats, notices, complete, existingWork }`: each match has `file`, `startLine`, `endLine`, `code`, `facet`, `score` and every facet's probability |

## What to trust

Each score comes from a classifier that saw one chunk in isolation, with no view of callers. Treat the
grouping as the signal and verify before relying on it. Relevant code can be missing. Scores across
facets are not calibrated against each other.

Exit codes: 0 when complete, 2 when any chunk or the PR list couldn't be searched.
